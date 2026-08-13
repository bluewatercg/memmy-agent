import type { RuntimeNamespace, TopicActionEffect, TopicActionProposalRecord, TopicExecutionRunRecord } from "../../types.js";
import type { Repositories } from "../../storage/repositories.js";
import type { ProjectContextService } from "../project-context/project-context-service.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { evaluateExecutionPolicy } from "./execution-policy.js";
import { namespaceIdFromContext } from "../namespace/namespace-scope.js";

export interface TopicProposalAction {
  id: string;
  effect: TopicActionEffect;
  target: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  recoveryPoint: string;
  acceptanceCondition: string;
}

export interface TopicActionOutcome {
  status: "succeeded" | "failed";
  output?: unknown;
  error?: string;
}

export interface TopicExecutionContext {
  namespace: RuntimeNamespace;
  namespaceId: string;
  projectNamespaceId: string;
  sessionId: string;
  runId: string;
  proposalId: string;
  repos: Repositories;
  projectContextService: ProjectContextService;
}

export interface TopicActionHandler {
  effect: TopicActionEffect;
  execute(action: TopicProposalAction, context: TopicExecutionContext): Promise<TopicActionOutcome>;
}

interface ActionResult {
  id: string;
  status: "pending" | "succeeded" | "failed" | "awaiting_confirmation" | "skipped";
  output?: unknown;
  error?: string;
  confirmedAt?: string;
  confirmedBy?: Record<string, unknown>;
}

interface RunResult {
  actions: ActionResult[];
  pendingAction?: {
    id: string;
    target: string;
    input: Record<string, unknown>;
    rollbackMetadata: Record<string, unknown>;
  };
  error?: string;
}

export interface ProposalExecutorOptions {
  repos: Repositories;
  projectContextService: ProjectContextService;
}

export class ProposalExecutor {
  private readonly handlers = new Map<TopicActionEffect, TopicActionHandler>();

  constructor(private readonly options: ProposalExecutorOptions) {
    this.registerDefaultHandlers();
  }

  registerHandler(handler: TopicActionHandler): void {
    this.handlers.set(handler.effect, handler);
  }

  async approveProposal(
    namespace: RuntimeNamespace,
    sessionId: string,
    proposalId: string,
    expectedProposalVersion: number,
    actor: Record<string, unknown>
  ): Promise<TopicExecutionRunRecord> {
    const namespaceId = stableHash(namespace);

    // Validate session exists
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    // Validate session is not stale
    if (session.state === "stale") {
      throw new Error(`session is stale: ${sessionId}`);
    }

    // Validate proposal exists and version matches
    const proposals = this.options.repos.topicDecisions.listProposals(namespaceId, sessionId);
    const proposal = proposals.find(p => p.id === proposalId);
    if (!proposal) {
      throw new Error(`proposal not found: ${proposalId}`);
    }

    if (proposal.version !== expectedProposalVersion) {
      throw new Error(`proposal version conflict: expected ${expectedProposalVersion}, got ${proposal.version}`);
    }

    // Validate proposal is recommended
    const isRecommended = proposal.metadata.recommended === true;
    if (!isRecommended) {
      throw new Error(`proposal is not recommended: ${proposalId}`);
    }

    // Extract actions from proposal payload
    const actions = this.extractActions(proposal);

    // Validate all actions against policy
    for (const action of actions) {
      const policy = evaluateExecutionPolicy(action.effect, {
        recoveryPoint: action.recoveryPoint,
        acceptanceCondition: action.acceptanceCondition
      });
      if (policy.mode === "forbidden") {
        throw new Error(`action forbidden by policy: ${action.id} — ${policy.reason}`);
      }
    }

    // Create execution run
    const now = nowIso();
    const run = this.options.repos.topicDecisions.createExecutionRun({
      id: newId("tdrun"),
      namespaceId,
      sessionId,
      proposalId,
      status: "running",
      result: { actions: actions.map(a => ({ id: a.id, status: "pending" })) },
      version: 1,
      createdAt: now,
      updatedAt: now
    });

    // Update proposal status to approved
    this.options.repos.topicDecisions.updateProposal(
      { ...proposal, status: "approved", version: proposal.version + 1, updatedAt: now },
      proposal.version
    );

    // Update session state to executing
    this.options.repos.topicDecisions.updateSession(
      { ...session, state: "executing", version: session.version + 1, updatedAt: now },
      session.version
    );

    // Execute actions
    const context: TopicExecutionContext = {
      projectNamespaceId: namespaceIdFromContext(namespace),
      namespace,
      namespaceId,
      sessionId,
      runId: run.id,
      proposalId,
      repos: this.options.repos,
      projectContextService: this.options.projectContextService
    };

    return this.executeActions(run, actions, context, actor);
  }

  async resumeExecution(namespace: RuntimeNamespace, runId: string): Promise<TopicExecutionRunRecord> {
    const namespaceId = stableHash(namespace);
    const run = this.getRun(namespaceId, runId);

    // Check session staleness
    const session = this.options.repos.topicDecisions.getSession(namespaceId, run.sessionId);
    if (!session) {
      throw new Error(`session not found: ${run.sessionId}`);
    }
    if (session.state === "stale") {
      const now = nowIso();
      const result = this.getRunResult(run);
      result.error = "session is stale; execution stopped";
      // Mark pending actions as skipped
      for (const action of result.actions) {
        if (action.status === "pending" || action.status === "awaiting_confirmation") {
          action.status = "skipped";
        }
      }
      return this.updateRun(run, "failed", result, now);
    }

    // Get proposal and actions
    const proposals = this.options.repos.topicDecisions.listProposals(namespaceId, run.sessionId);
    const proposal = proposals.find(p => p.id === run.proposalId);
    if (!proposal) {
      throw new Error(`proposal not found: ${run.proposalId}`);
    }

    const actions = this.extractActions(proposal);
    const result = this.getRunResult(run);

    // Filter to pending actions only (idempotency: skip succeeded)
    const pendingActions = actions.filter(a => {
      const actionResult = result.actions.find(ar => ar.id === a.id);
      return !actionResult || actionResult.status === "pending" || actionResult.status === "awaiting_confirmation";
    });

    if (pendingActions.length === 0) {
      // All actions already completed
      return run;
    }

    const context: TopicExecutionContext = {
      projectNamespaceId: namespaceIdFromContext(namespace),
      namespace,
      namespaceId,
      sessionId: run.sessionId,
      runId: run.id,
      proposalId: run.proposalId,
      repos: this.options.repos,
      projectContextService: this.options.projectContextService
    };

    return this.executeActions(run, actions, context, undefined, result);
  }

  async confirmExecutionAction(
    namespace: RuntimeNamespace,
    runId: string,
    actionId: string,
    expectedRunVersion: number,
    approved: boolean,
    actor: Record<string, unknown>
  ): Promise<TopicExecutionRunRecord> {
    const namespaceId = stableHash(namespace);
    const run = this.getRun(namespaceId, runId);

    // Validate run version
    if (run.version !== expectedRunVersion) {
      throw new Error(`run version conflict: expected ${expectedRunVersion}, got ${run.version}`);
    }

    const result = this.getRunResult(run);

    // Validate action is pending confirmation
    const pendingAction = result.pendingAction;
    if (!pendingAction || pendingAction.id !== actionId) {
      throw new Error(`action not pending confirmation: ${actionId}`);
    }

    const now = nowIso();

    if (!approved) {
      // Rejection: cancel run
      for (const action of result.actions) {
        if (action.status === "pending" || action.status === "awaiting_confirmation") {
          action.status = "skipped";
        }
      }
      delete result.pendingAction;
      return this.updateRun(run, "cancelled", result, now);
    }

    // Approval: record confirmation and execute action
    const actionResult = result.actions.find(ar => ar.id === actionId);
    if (actionResult) {
      actionResult.status = "succeeded";
      actionResult.confirmedAt = now;
      actionResult.confirmedBy = actor;
    }

    // Get proposal and execute remaining actions
    const proposals = this.options.repos.topicDecisions.listProposals(namespaceId, run.sessionId);
    const proposal = proposals.find(p => p.id === run.proposalId);
    if (!proposal) {
      throw new Error(`proposal not found: ${run.proposalId}`);
    }

    const actions = this.extractActions(proposal);
    delete result.pendingAction;

    const context: TopicExecutionContext = {
      projectNamespaceId: namespaceIdFromContext(namespace),
      namespace,
      namespaceId,
      sessionId: run.sessionId,
      runId: run.id,
      proposalId: run.proposalId,
      repos: this.options.repos,
      projectContextService: this.options.projectContextService
    };

    // Execute remaining actions after the confirmed one
    const confirmedIndex = actions.findIndex(a => a.id === actionId);
    const remainingActions = actions.slice(confirmedIndex + 1);

    if (remainingActions.length === 0) {
      return this.updateRun(run, "completed", result, now);
    }

    const updatedRun = this.updateRun(run, "running", result, now);
    return this.executeActions(updatedRun, actions, context, actor, result);
  }

  private async executeActions(
    run: TopicExecutionRunRecord,
    actions: TopicProposalAction[],
    context: TopicExecutionContext,
    actor: Record<string, unknown> | undefined,
    existingResult?: RunResult
  ): Promise<TopicExecutionRunRecord> {
    const result: RunResult = existingResult ?? { actions: actions.map(a => ({ id: a.id, status: "pending" })) };
    let currentRun = run;

    // Topological sort for dependency order
    const sorted = this.topologicalSort(actions);

    for (const action of sorted) {
      const actionResult = result.actions.find(ar => ar.id === action.id);

      // Idempotency: skip already succeeded actions
      if (actionResult?.status === "succeeded") {
        continue;
      }

      // Check dependencies
      const unmetDeps = action.dependsOn.filter(depId => {
        const depResult = result.actions.find(ar => ar.id === depId);
        return !depResult || depResult.status !== "succeeded";
      });

      if (unmetDeps.length > 0) {
        if (actionResult) {
          actionResult.status = "skipped";
          actionResult.error = `unmet dependencies: ${unmetDeps.join(", ")}`;
        }
        continue;
      }

      // Evaluate policy
      const policy = evaluateExecutionPolicy(action.effect, {
        recoveryPoint: action.recoveryPoint,
        acceptanceCondition: action.acceptanceCondition
      });

      if (policy.mode === "forbidden") {
        if (actionResult) {
          actionResult.status = "failed";
          actionResult.error = `forbidden: ${policy.reason}`;
        }
        const now = nowIso();
        result.error = `action forbidden: ${action.id}`;
        return this.updateRun(currentRun, "failed", result, now);
      }

      if (policy.mode === "confirmation_required") {
        // Pause execution: store checkpoint and rollback metadata
        if (actionResult) {
          actionResult.status = "awaiting_confirmation";
        }
        result.pendingAction = {
          id: action.id,
          target: action.target,
          input: action.input,
          rollbackMetadata: {
            recoveryPoint: action.recoveryPoint,
            effect: action.effect,
            target: action.target,
            input: action.input
          }
        };
        const now = nowIso();
        return this.updateRun(currentRun, "awaiting_confirmation", result, now);
      }

      // Automatic: execute via handler
      const handler = this.handlers.get(action.effect);
      if (!handler) {
        if (actionResult) {
          actionResult.status = "failed";
          actionResult.error = `no handler registered for effect: ${action.effect}`;
        }
        const now = nowIso();
        result.error = `no handler for effect: ${action.effect}`;
        return this.updateRun(currentRun, "failed", result, now);
      }

      try {
        const outcome = await handler.execute(action, context);

        if (actionResult) {
          actionResult.status = outcome.status;
          if (outcome.status === "succeeded") {
            actionResult.output = outcome.output;
          } else {
            actionResult.error = outcome.error;
          }
        }

        // Persist action result before starting next action (checkpoint)
        const now = nowIso();
        if (outcome.status === "failed") {
          result.error = `action failed: ${action.id} — ${outcome.error}`;
          return this.updateRun(currentRun, "failed", result, now);
        }

        currentRun = this.updateRun(currentRun, "running", result, now);
      } catch (err) {
        const now = nowIso();
        if (actionResult) {
          actionResult.status = "failed";
          actionResult.error = err instanceof Error ? err.message : String(err);
        }
        result.error = `action threw: ${action.id} — ${err instanceof Error ? err.message : String(err)}`;
        return this.updateRun(currentRun, "failed", result, now);
      }
    }

    // All actions completed
    const now = nowIso();
    return this.updateRun(currentRun, "completed", result, now);
  }

  private topologicalSort(actions: TopicProposalAction[]): TopicProposalAction[] {
    const sorted: TopicProposalAction[] = [];
    const visited = new Set<string>();
    const actionMap = new Map(actions.map(a => [a.id, a]));

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const action = actionMap.get(id);
      if (!action) return;
      for (const dep of action.dependsOn) {
        visit(dep);
      }
      sorted.push(action);
    };

    for (const action of actions) {
      visit(action.id);
    }

    return sorted;
  }

  private extractActions(proposal: TopicActionProposalRecord): TopicProposalAction[] {
    const payload = proposal.payload;
    const rawActions = payload.actions as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(rawActions) || rawActions.length === 0) {
      // Single-action proposal: synthesize from proposal metadata
      return [
        {
          id: `${proposal.id}-action-1`,
          effect: proposal.effect,
          target: (proposal.metadata.artifact as string) ?? "unknown",
          input: payload,
          dependsOn: (payload.dependencies as string[]) ?? [],
          recoveryPoint: (proposal.metadata.recoveryPoint as string) ?? "",
          acceptanceCondition: (proposal.metadata.acceptanceCondition as string) ?? ""
        }
      ];
    }

    return rawActions.map(raw => ({
      id: String(raw.id),
      effect: String(raw.effect) as TopicActionEffect,
      target: String(raw.target),
      input: (raw.input as Record<string, unknown>) ?? {},
      dependsOn: (raw.dependsOn as string[]) ?? [],
      recoveryPoint: String(raw.recoveryPoint ?? ""),
      acceptanceCondition: String(raw.acceptanceCondition ?? "")
    }));
  }

  private getRun(namespaceId: string, runId: string): TopicExecutionRunRecord {
    const run = this.options.repos.topicDecisions.getRun(namespaceId, runId);
    if (!run) {
      throw new Error(`execution run not found: ${runId}`);
    }
    return run;
  }

  private getRunResult(run: TopicExecutionRunRecord): RunResult {
    return (run.result as unknown as RunResult) ?? { actions: [] };
  }

  private updateRun(
    run: TopicExecutionRunRecord,
    status: string,
    result: RunResult,
    updatedAt: string
  ): TopicExecutionRunRecord {
    return this.options.repos.topicDecisions.updateExecutionRun(
      { ...run, status, result: result as unknown as Record<string, unknown>, version: run.version + 1, updatedAt },
      run.version
    );
  }

  private registerDefaultHandlers(): void {
    // draft handler: persist bounded artifact through artifact repository
    this.registerHandler({
      effect: "draft",
      execute: async (action, context) => {
        try {
          const artifactId = context.repos.runtime.insertArtifact({
            sessionId: context.sessionId,
            userId: context.namespace.userId ?? "system",
            kind: "topic_decision_draft",
            payload: {
              proposalId: context.proposalId,
              actionId: action.id,
              target: action.target,
              input: action.input,
              runId: context.runId
            }
          });
          return { status: "succeeded", output: { artifactId } };
        } catch (err) {
          return { status: "failed", error: err instanceof Error ? err.message : String(err) };
        }
      }
    });

    // create_candidate_task handler: create non-focused pending work item with proposal/session provenance
    this.registerHandler({
      effect: "create_candidate_task",
      execute: async (action, context) => {
        try {
          const input = action.input as {
            title?: string;
            summary?: string;
            nextStep?: string;
            acceptanceCriteria?: string[];
            constraints?: string[];
          };

          if (!input.title || !input.summary || !input.nextStep) {
            return { status: "failed", error: "create_candidate_task requires title, summary, nextStep" };
          }

          const normalizedNamespace = {
            ...context.namespace,
            userId: context.namespace.userId ?? "system",
            source: context.namespace.source ?? "unknown",
            profileId: context.namespace.profileId ?? "default"
          };

          const workItem = context.projectContextService.createWorkItem({
            namespace: normalizedNamespace,
            title: input.title,
            summary: input.summary,
            nextStep: input.nextStep,
            acceptanceCriteria: input.acceptanceCriteria,
            constraints: input.constraints,
            status: "pending",
            provenance: {
              topicProposalId: context.proposalId,
              topicSessionId: context.sessionId,
              topicRunId: context.runId,
              topicActionId: action.id,
              sourceAgent: "topic-decision-executor",
              sourceMemoryIds: [],
              capturedAt: nowIso()
            }
          });

          return { status: "succeeded", output: { workItemId: workItem.id } };
        } catch (err) {
          return { status: "failed", error: err instanceof Error ? err.message : String(err) };
        }
      }
    });
  }
}
