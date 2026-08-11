/** Panel service module. */
import type {
  PanelAnalysisOutput,
  PanelItemsInput,
  PanelItemsOutput,
  PanelTasksInput,
  PanelTasksOutput,
  DeletePanelTaskOutput,
  MemoryApiLogsInput,
  MemoryApiLogsOutput,
  PanelOverviewOutput,
  ProjectContextPackOutput,
  ProjectContextFocusInput,
  ProjectContextGoalDecisionInput,
  ProjectContextProposeGoalInput,
  ProjectContextReadState,
  ProjectContextWorkItemCreateInput,
  ProjectContextWorkItemUpdateInput,
  ProjectGoalRecord,
  ProjectWorkItemRecord,
  RuntimeNamespace,
  TopicCandidateDecisionInput,
  TopicCandidateDecisionOutput,
  TopicInboxEvidenceInput,
  TopicInboxEvidenceOutput,
  TopicInboxListInput,
  TopicInboxListOutput,
  TopicInboxMergeInput,
  TopicInboxMergeOutput,
  TopicInboxRefreshInput,
  TopicInboxRefreshOutput,
  TopicInboxSplitInput,
  TopicInboxSplitOutput,
} from "@memmy/local-api-contracts";
import { MemoryLayerError } from "../adapters/outbound/memory-client/index.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { RuntimeContext } from "./runtime-context.js";

/** Contract for panel service. */
export interface PanelService {
  overview(ctx: RuntimeContext): Promise<PanelOverviewOutput>;
  analysis(ctx: RuntimeContext): Promise<PanelAnalysisOutput>;
  contextPack(projectId: string, ctx: RuntimeContext): Promise<ProjectContextPackOutput>;
  projectContextState(namespace: RuntimeNamespace, ctx: RuntimeContext): Promise<ProjectContextReadState>;
  proposeProjectGoal(input: ProjectContextProposeGoalInput, ctx: RuntimeContext): Promise<ProjectGoalRecord>;
  approveProjectGoal(id: string, input: ProjectContextGoalDecisionInput, ctx: RuntimeContext): Promise<ProjectGoalRecord>;
  rejectProjectGoal(id: string, input: ProjectContextGoalDecisionInput, ctx: RuntimeContext): Promise<ProjectGoalRecord>;
  createProjectWorkItem(input: ProjectContextWorkItemCreateInput, ctx: RuntimeContext): Promise<ProjectWorkItemRecord>;
  updateProjectWorkItem(id: string, input: ProjectContextWorkItemUpdateInput, ctx: RuntimeContext): Promise<ProjectWorkItemRecord>;
  setProjectFocus(input: ProjectContextFocusInput, ctx: RuntimeContext): Promise<ProjectWorkItemRecord | null>;
  listTopicInbox(input: TopicInboxListInput, ctx: RuntimeContext): Promise<TopicInboxListOutput>;
  refreshTopicInbox(input: TopicInboxRefreshInput, ctx: RuntimeContext): Promise<TopicInboxRefreshOutput>;
  decideTopicCandidate(id: string, input: TopicCandidateDecisionInput, ctx: RuntimeContext): Promise<TopicCandidateDecisionOutput>;
  mergeTopics(id: string, input: TopicInboxMergeInput, ctx: RuntimeContext): Promise<TopicInboxMergeOutput>;
  splitTopic(id: string, input: TopicInboxSplitInput, ctx: RuntimeContext): Promise<TopicInboxSplitOutput>;
  topicEvidence(id: string, input: TopicInboxEvidenceInput, ctx: RuntimeContext): Promise<TopicInboxEvidenceOutput>;
  items(input: PanelItemsInput, ctx: RuntimeContext): Promise<PanelItemsOutput>;
  tasks(input: PanelTasksInput, ctx: RuntimeContext): Promise<PanelTasksOutput>;
  deleteTask(id: string, ctx: RuntimeContext): Promise<DeletePanelTaskOutput>;
  memoryApiLogs(input: MemoryApiLogsInput, ctx: RuntimeContext): Promise<MemoryApiLogsOutput>;
}

/** Creates create panel service. */
export function createPanelService(deps: { memoryClient: MemoryClient }): PanelService {
  return {
    async overview(_ctx) {
      return deps.memoryClient.panelOverview();
    },

    async analysis(_ctx) {
      return deps.memoryClient.panelAnalysis();
    },

    async contextPack(projectId, _ctx) {
      return deps.memoryClient.projectContextPack(projectId);
    },

    async projectContextState(namespace, _ctx) {
      return deps.memoryClient.projectContextState(namespace);
    },

    async proposeProjectGoal(input, ctx) {
      return deps.memoryClient.proposeProjectGoal(withRuntimeProvenance(input, ctx));
    },

    async approveProjectGoal(id, input, ctx) {
      return deps.memoryClient.approveProjectGoal(id, withRuntimeProvenance(input, ctx));
    },

    async rejectProjectGoal(id, input, ctx) {
      return deps.memoryClient.rejectProjectGoal(id, withRuntimeProvenance(input, ctx));
    },

    async createProjectWorkItem(input, ctx) {
      return deps.memoryClient.createProjectWorkItem(withRuntimeProvenance(input, ctx));
    },

    async updateProjectWorkItem(id, input, ctx) {
      return deps.memoryClient.updateProjectWorkItem(id, withRuntimeProvenance(input, ctx));
    },

    async setProjectFocus(input, ctx) {
      return deps.memoryClient.setProjectFocus(withRuntimeProvenance(input, ctx));
    },

    async listTopicInbox(input, _ctx) { return deps.memoryClient.listTopicInbox(input); },
    async refreshTopicInbox(input, _ctx) { return deps.memoryClient.refreshTopicInbox(input); },
    async decideTopicCandidate(id, input, _ctx) { return deps.memoryClient.decideTopicCandidate(id, input); },
    async mergeTopics(id, input, _ctx) { return deps.memoryClient.mergeTopics(id, input); },
    async splitTopic(id, input, _ctx) { return deps.memoryClient.splitTopic(id, input); },
    async topicEvidence(id, input, _ctx) { return deps.memoryClient.topicEvidence(id, input); },

    async items(input, _ctx) {
      return deps.memoryClient.panelItems(input);
    },

    async tasks(input, _ctx) {
      return deps.memoryClient.panelTasks(input);
    },

    async deleteTask(id, _ctx) {
      return deps.memoryClient.deletePanelTask(id);
    },

    async memoryApiLogs(input, _ctx) {
      try {
        return await deps.memoryClient.memoryApiLogs(input);
      } catch (error) {
        if (isMissingMemoryLogsRoute(error)) {
          return {
            logs: [],
            total: 0,
            limit: input.limit ?? 50,
            offset: input.offset ?? 0,
            serverTime: new Date().toISOString()
          };
        }
        throw error;
      }
    }
  };
}

/** Checks is missing memory logs route. */
function isMissingMemoryLogsRoute(error: unknown): boolean {
  return (
    error instanceof MemoryLayerError &&
    error.status === 404 &&
    error.code === "not_found" &&
    error.message.toLowerCase().includes("logs")
  );
}

function withRuntimeProvenance<T extends { adapterId: string; requestId: string; provenance: object }>(input: T, ctx: RuntimeContext): T {
  return {
    ...input,
    adapterId: ctx.adapterId,
    requestId: ctx.requestId ?? input.requestId,
    provenance: { ...input.provenance, adapterId: ctx.adapterId, requestId: ctx.requestId ?? input.requestId }
  } as T;
}
