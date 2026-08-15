import type {
  AgentLoadoutEntry,
  AgentLoadoutMode,
  AssetApplicability,
  MemoryAssetRecord
} from "../../types.js";
import type { Repositories } from "../../storage/repositories.js";

export interface AgentLoadoutServiceDependencies {
  repositories: Repositories;
  now?: () => string;
  id?: (prefix: string) => string;
}

export interface BindAgentLoadoutInput {
  namespaceId: string;
  agentId: string;
  assetId: string;
  assetVersion: number;
  mode: AgentLoadoutMode;
  priority: number;
  projectId?: string;
  planId?: string;
  workItemId?: string;
  taskTypes: string[];
  retireWhen: AssetApplicability["retireWhen"];
}

export interface AgentLoadoutContext {
  namespaceId: string;
  agentId: string;
  mode: AgentLoadoutMode;
  projectId?: string;
  planId?: string;
  workItemId?: string;
  taskType?: string;
  signals: string[];
  at?: string;
}

export interface AvailableAgentAsset {
  binding: AgentLoadoutEntry;
  asset: MemoryAssetRecord;
}

export interface RetireCompletedLoadoutsInput {
  namespaceId: string;
  agentId: string;
  actorId: string;
  completedPlanIds?: string[];
}

const defaultNow = (): string => new Date().toISOString();
const defaultId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

export class AgentLoadoutService {
  private readonly now: () => string;
  private readonly id: (prefix: string) => string;

  constructor(private readonly deps: AgentLoadoutServiceDependencies) {
    this.now = deps.now ?? defaultNow;
    this.id = deps.id ?? defaultId;
  }

  bind(input: BindAgentLoadoutInput): AgentLoadoutEntry {
    this.validateBindingInput(input);
    const asset = this.deps.repositories.assets.get(input.namespaceId, input.assetId, input.assetVersion);
    if (!asset) {
      throw new Error(`asset not found: ${input.namespaceId}/${input.assetId}/v${input.assetVersion}`);
    }
    if (asset.status !== "active") throw new Error("agent loadout requires an active asset version");
    if (!isVisibleToAgent(asset, input.agentId)) throw new Error("asset is not visible to agent");
    validateBindingScope(asset.applicability, input);

    const at = this.now();
    return this.deps.repositories.agentLoadouts.create({
      id: this.id("agent-loadout"),
      namespaceId: input.namespaceId,
      agentId: input.agentId,
      assetId: input.assetId,
      assetVersion: input.assetVersion,
      mode: input.mode,
      priority: input.priority,
      enabled: true,
      projectId: input.projectId,
      planId: input.planId,
      workItemId: input.workItemId,
      taskTypes: [...new Set(input.taskTypes)],
      retireWhen: input.retireWhen,
      createdAt: at,
      updatedAt: at
    });
  }

  listAvailable(context: AgentLoadoutContext): AvailableAgentAsset[] {
    const at = context.at ?? this.now();
    const signals = new Set(context.signals);
    const available: AvailableAgentAsset[] = [];

    for (const binding of this.deps.repositories.agentLoadouts.list(
      context.namespaceId,
      context.agentId,
      { enabled: true }
    )) {
      if (!bindingMatchesContext(binding, context)) continue;
      const asset = this.deps.repositories.assets.get(
        context.namespaceId,
        binding.assetId,
        binding.assetVersion
      );
      if (!asset || asset.status !== "active" || !isVisibleToAgent(asset, context.agentId)) continue;
      if (!applicabilityMatchesContext(asset.applicability, context, signals, at)) continue;
      available.push({ binding, asset });
    }
    return available;
  }

  retireCompleted(input: RetireCompletedLoadoutsInput): AgentLoadoutEntry[] {
    if (!input.actorId.trim()) throw new Error("loadout retirement requires actorId");
    const completedWorkItems = new Set(
      this.deps.repositories.projectContext.listWorkItems(input.namespaceId)
        .filter((item) => item.status === "completed")
        .map((item) => item.id)
    );
    const completedProjects = new Set(
      this.deps.repositories.projectContext.listGoals(input.namespaceId)
        .filter((goal) => goal.status === "completed" && goal.projectId)
        .map((goal) => goal.projectId!)
    );
    const completedPlans = new Set(input.completedPlanIds ?? []);
    const at = this.now();
    const retired: AgentLoadoutEntry[] = [];

    for (const binding of this.deps.repositories.agentLoadouts.list(
      input.namespaceId,
      input.agentId,
      { enabled: true }
    )) {
      if (!shouldRetire(binding, completedWorkItems, completedPlans, completedProjects)) continue;
      const updated = this.deps.repositories.transaction(() => {
        const next = this.deps.repositories.agentLoadouts.setEnabled(
          binding.namespaceId,
          binding.id,
          false,
          at
        );
        this.deps.repositories.runtime.appendChange({
          memoryId: binding.assetId,
          namespaceId: binding.namespaceId,
          kind: "memory_asset",
          op: "lifecycle",
          entityId: binding.id,
          userId: input.actorId,
          changeType: "asset.loadout.retired",
          version: binding.assetVersion,
          before: binding,
          after: next,
          source: "asset.agent-loadout.v1",
          createdAt: at
        });
        return next;
      });
      retired.push(updated);
    }
    return retired;
  }

  private validateBindingInput(input: BindAgentLoadoutInput): void {
    if (!input.namespaceId.trim() || !input.agentId.trim() || !input.assetId.trim()) {
      throw new Error("agent loadout requires namespaceId, agentId, and assetId");
    }
    if (!Number.isInteger(input.assetVersion) || input.assetVersion < 1) {
      throw new Error("agent loadout assetVersion must be a positive integer");
    }
    if (!Number.isFinite(input.priority)) throw new Error("agent loadout priority must be finite");
    if (input.taskTypes.some((taskType) => !taskType.trim())) {
      throw new Error("agent loadout taskTypes must be non-empty strings");
    }
  }
}

function isVisibleToAgent(asset: MemoryAssetRecord, agentId: string): boolean {
  if (asset.ownerId === agentId) return true;
  if (asset.visibility === "team") return true;
  return asset.allowedAgentIds.includes(agentId);
}

function validateBindingScope(
  applicability: AssetApplicability,
  input: BindAgentLoadoutInput
): void {
  validateScopedValue("project", input.projectId, applicability.projectIds);
  validateScopedValue("plan", input.planId, applicability.planIds);
  validateScopedValue("work item", input.workItemId, applicability.workItemIds);
  if (applicability.taskTypes.length > 0) {
    const allowed = new Set(applicability.taskTypes);
    if (input.taskTypes.some((taskType) => !allowed.has(taskType))) {
      throw new Error("agent loadout exceeds asset task type scope");
    }
  }
  if (input.retireWhen !== applicability.retireWhen) {
    throw new Error("agent loadout retirement rule must match asset applicability");
  }
}

function validateScopedValue(label: string, value: string | undefined, allowed: string[]): void {
  if (value && allowed.length > 0 && !allowed.includes(value)) {
    throw new Error(`agent loadout exceeds asset ${label} scope`);
  }
}

function bindingMatchesContext(binding: AgentLoadoutEntry, context: AgentLoadoutContext): boolean {
  if (binding.mode !== context.mode) return false;
  if (binding.projectId && binding.projectId !== context.projectId) return false;
  if (binding.planId && binding.planId !== context.planId) return false;
  if (binding.workItemId && binding.workItemId !== context.workItemId) return false;
  return binding.taskTypes.length === 0 || (context.taskType !== undefined && binding.taskTypes.includes(context.taskType));
}

function applicabilityMatchesContext(
  applicability: AssetApplicability,
  context: AgentLoadoutContext,
  signals: Set<string>,
  at: string
): boolean {
  if (!matchesAllowed(context.projectId, applicability.projectIds)) return false;
  if (!matchesAllowed(context.planId, applicability.planIds)) return false;
  if (!matchesAllowed(context.workItemId, applicability.workItemIds)) return false;
  if (applicability.taskTypes.length > 0
    && (!context.taskType || !applicability.taskTypes.includes(context.taskType))) return false;
  if (applicability.requiredSignals.some((signal) => !signals.has(signal))) return false;
  if (applicability.excludedSignals.some((signal) => signals.has(signal))) return false;
  if (applicability.validFrom && at < applicability.validFrom) return false;
  if (applicability.validUntil && at > applicability.validUntil) return false;
  return true;
}

function matchesAllowed(value: string | undefined, allowed: string[]): boolean {
  return allowed.length === 0 || (value !== undefined && allowed.includes(value));
}

function shouldRetire(
  binding: AgentLoadoutEntry,
  completedWorkItems: Set<string>,
  completedPlans: Set<string>,
  completedProjects: Set<string>
): boolean {
  switch (binding.retireWhen) {
    case "work_item_completed":
      return binding.workItemId !== undefined && completedWorkItems.has(binding.workItemId);
    case "plan_completed":
      return binding.planId !== undefined && completedPlans.has(binding.planId);
    case "project_completed":
      return binding.projectId !== undefined && completedProjects.has(binding.projectId);
    case "explicit":
    case "never":
      return false;
  }
}
