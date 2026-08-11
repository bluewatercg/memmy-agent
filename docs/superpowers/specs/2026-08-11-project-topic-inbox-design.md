# Project Topic Inbox Design

Date: 2026-08-11
Status: Approved for planning

## Problem

A project can accumulate hundreds of L1 trace memories. Reading them one by one makes the human perform the same clustering, deduplication, conflict detection, and evidence assessment that the system should perform automatically.

Memmy already summarizes individual L1 traces, generates reviewable L2/L3/Skill candidates, exposes a Project Context Pack, and ships `memmy-project-summarize`. These capabilities do not yet form a persistent incremental workflow. The user must still trigger summarization manually or inspect memory lists to discover what matters.

The product should treat raw L1 traces as evidence. The human-facing product is a small set of evolving, project-scoped topic packages and their candidate conclusions.

## Goals

- Automatically group related L1 traces within each project namespace.
- Incrementally update an existing topic package when related evidence arrives.
- Generate conclusions with compact evidence summaries, confidence, risk, and proposed memory layer.
- Keep raw L1 traces collapsed unless the user explicitly expands evidence.
- Support automatic background analysis and a manual "summarize now" refresh.
- Automatically approve only verified, high-confidence, low-risk L2 conclusions.
- Require human approval for every L3 and Skill conclusion.
- Preserve source-memory provenance, audit history, model identity, and reversible versions.
- Reuse the existing memory, relation, candidate review, worker, namespace, and audit systems.

## Non-goals

- Deleting or replacing L1 memories.
- Building a second memory database or parallel review system.
- Generating a fixed number of cards per project.
- Automatically approving architecture facts, Skills, conflicts, or sensitive operational guidance.
- Making an AI-generated topic package authoritative project context without the applicable approval.
- Producing scheduled reports as the primary data model. Reports may later be read-only projections of topic packages.

## Considered Approaches

### Topic package inbox

Related L1 traces continuously update a topic package. The inbox shows topic-level conclusions and exposes raw evidence only on demand.

This is selected because it directly removes repeated reading, supports incremental work, and maps cleanly to Memmy's existing candidate and provenance model.

### Periodic project report

A daily or weekly report is easy to read but weak for conclusion-level approval, provenance, incremental updates, and conflict resolution.

### Conversational summaries

On-demand questions produce the lightest interface but can leave important conclusions undiscovered and do not provide a durable governance queue.

## Domain Model

### Project Topic

A Project Topic is a project-scoped evolving cluster of related L1 evidence.

Fields:

- `id`: stable topic identifier.
- `namespaceId`: owning project namespace.
- `title`: compact human-readable subject.
- `summary`: current one-sentence project state for the topic.
- `status`: `active`, `needs_review`, `stale`, `merged`, or `archived`.
- `evidenceMemoryIds`: current supporting L1 IDs.
- `episodeIds`: distinct supporting episodes.
- `signals`: normalized tags, files, modules, tools, errors, and verification markers used for matching.
- `confidence`: clustering confidence, separate from conclusion confidence.
- `lastAnalyzedAt`: last successful model analysis.
- `lastEvidenceAt`: newest evidence timestamp.
- `model`: provider/model identity used for the current analysis.
- `version`: monotonically increasing topic version.
- `mergedIntoId`: canonical topic when this topic is merged.

A topic is not a memory layer and does not replace its evidence. It is an analysis and review container over existing project memories.

### Topic Candidate

A Topic Candidate is one precise conclusion derived from a topic.

Fields:

- `id`
- `topicId`
- `title`
- `conclusion`
- `proposedLayer`: `L2`, `L3`, or `Skill`.
- `confidence`: `high`, `medium`, or `low`.
- `risk`: `low`, `medium`, or `high`.
- `verificationStatus`: `verified`, `partially_verified`, `unverified`, or `conflicted`.
- `sourceMemoryIds`
- `evidenceSummary`: a bounded list of decisive evidence, not raw traces.
- `conflicts`: contradictory evidence references and explanation.
- `status`: `pending`, `auto_approved`, `approved`, `rejected`, `deferred`, `superseded`, or `stale`.
- `targetMemoryId`: approved L2/L3/Skill memory, when present.
- `model`
- `createdAt`, `updatedAt`, and `decidedAt`.

A changed conclusion supersedes the previous candidate instead of mutating an approved conclusion invisibly.

## Topic Matching

Topic matching uses multiple signals rather than one embedding threshold:

1. semantic similarity between the incoming L1 summary and active topic summaries;
2. shared normalized tags;
3. common files, modules, tools, commands, error signatures, or named decisions;
4. episode adjacency and source-memory relations;
5. explicit error -> fix -> verification chains;
6. negative evidence that indicates different tasks despite shared generic vocabulary.

The matcher chooses exactly one of:

- attach to an existing topic;
- create a new topic;
- leave the L1 unassigned and queue it for later analysis.

When confidence is ambiguous, it creates or preserves separate topics. It must not force unrelated evidence together. Later analysis may propose a merge, which is auditable and reversible.

## Incremental Analysis

The worker schedules topic analysis when:

- a new eligible L1 is created;
- an L1 gains reflection, reward, verification, or quality feedback;
- evidence relations change;
- the user invokes "summarize now" for a project;
- an earlier analysis failed and becomes retryable.

Analysis receives the previous topic state plus only new or materially changed evidence. It must:

1. update the title and one-sentence current state;
2. identify new, strengthened, weakened, conflicted, or obsolete conclusions;
3. deduplicate against existing pending and approved project memories;
4. emit candidate conclusions using the same quality rules as `memmy-project-summarize`;
5. preserve decisive source-memory IDs;
6. supersede stale candidates explicitly.

Refresh is idempotent. Running it twice without changed evidence produces no new topic, candidate, or memory versions.

## Automatic Approval Policy

Only an L2 candidate may be automatically approved, and only when all conditions hold:

- confidence is `high`;
- risk is `low`;
- verification status is `verified`;
- evidence is internally consistent and has no unresolved conflict;
- evidence contains a successful observable verification result;
- the conclusion is not duplicated by an active or pending memory;
- the conclusion is not security-sensitive, destructive, release-related, credential-related, access-control-related, or data-migration guidance;
- the candidate is not an architecture/ownership fact that belongs in L3;
- the candidate is not an executable multi-step workflow that belongs in Skill.

Every L3 and Skill candidate requires human approval. Any candidate with medium/high risk, partial/no verification, conflicts, or sensitive operational content requires human approval regardless of proposed layer.

Automatic approval writes through the existing memory governance path, records an audit decision with policy version and model identity, preserves source-memory relations, and supports the existing version restore mechanism.

## Inbox Experience

The inbox is grouped first by project and then by topic. It does not impose a fixed card count; related evidence shares a topic package and repeated low-information L1 traces do not consume review positions.

Each collapsed topic row shows:

- topic title and current one-sentence state;
- number of source L1 memories and episodes;
- counts of pending, auto-approved, conflicted, and stale conclusions;
- risk/confidence indicators;
- last evidence and analysis times.

Expanding a topic shows candidate cards. Each card shows conclusion, proposed layer, confidence, risk, verification status, decisive evidence summary, and conflict state.

Actions:

- approve;
- edit and approve;
- reject;
- defer;
- expand evidence;
- merge or split topics when automatic grouping is wrong;
- undo an automatic approval through the existing history/restore flow;
- summarize now for the selected project.

Raw L1 content is never required for routine review. "Expand evidence" is an escape hatch for disputes, conflicts, or high-risk conclusions.

## Module Interface

Introduce a deep module named `ProjectTopicInbox` at the evolution/read-model seam. Its external interface is intentionally small:

```ts
interface ProjectTopicInbox {
  ingest(memoryId: string): Promise<TopicIngestResult>;
  list(namespace: RuntimeNamespace, input?: TopicInboxQuery): TopicInboxView;
  decide(candidateId: string, decision: TopicCandidateDecision): Promise<TopicDecisionResult>;
  refresh(namespace: RuntimeNamespace): Promise<TopicRefreshResult>;
}
```

The implementation owns matching, incremental analysis, deduplication, candidate lifecycle, auto-approval policy, audit writes, retry state, and projections. Callers do not choose clustering thresholds or approval rules.

The module reuses existing repositories and worker queues. New persistence stores topic and candidate state only; approved conclusions remain ordinary L2/L3/Skill memories.

## Integration

- L1 creation and material evidence updates enqueue topic ingestion jobs.
- The worker processes ingestion and analysis using the configured Evolution model.
- Existing review-candidate governance remains the write path for approved conclusions.
- The Project Context Pack may show approved conclusions and topic summaries but must not treat pending candidates as authoritative state.
- `memmy-project-summarize` uses the same topic inbox refresh and candidate-card projection instead of maintaining separate quality logic.
- Existing raw memory and context-pack views remain available during migration.

## Failure Handling

- Model unavailable: preserve unprocessed evidence, mark the topic `stale`, and retry through the existing worker policy.
- Malformed model output: reject the analysis result atomically; do not partially update candidates.
- Ambiguous clustering: preserve separate topics or leave evidence unassigned.
- Conflicting evidence: set affected candidates to `conflicted`, block automatic approval, and expose both sides.
- Namespace mismatch: fail closed and never attach evidence across projects.
- Duplicate refresh: return the existing analysis state without new writes.
- Candidate approval race: use version checks; a decision against a stale candidate version fails with the current version for reload.
- Approved conclusion later contradicted: create a new review candidate and supersession proposal; never silently rewrite the approved memory.

## Migration

Existing L1 memories remain unchanged. Initial topic creation is a bounded backfill per project, processed through the worker with resumable cursors. Existing resolving L2/L3/Skill memories may be linked into matching topics but are not duplicated. Existing approved memories participate in deduplication.

The current keyword-based Project Context Pack remains available. Topic packages become an additional reviewed projection, then may replace its heuristic topic sections after behavior is verified.

## Verification

### Matching and lifecycle

- Related L1 memories from different episodes join one topic.
- An error, its fix, and successful verification join one topic and retain ordered evidence.
- Similar generic vocabulary from unrelated tasks does not force a merge.
- New evidence increments the topic version and does not duplicate unchanged candidates.
- Repeated refresh without changed evidence is idempotent.
- Topic merge/split preserves every evidence relation and audit event.

### Governance

- A verified high-confidence low-risk L2 may auto-approve.
- L3 and Skill never auto-approve.
- Security, release, destructive, credential, access-control, and migration conclusions never auto-approve.
- Conflicted, medium/high-risk, and incompletely verified candidates never auto-approve.
- Approval, edit-approval, rejection, deferral, supersession, and undo are auditable.
- Approved memories retain all decisive source-memory IDs.

### Isolation and resilience

- Topic matching and listing never cross project namespaces.
- Failed analysis leaves prior topic state intact and evidence retryable.
- Concurrent refresh and ingestion produce one coherent version.
- Initial backfill resumes after interruption without duplicates.

### End-to-end scenario

1. Capture several L1 traces about one model migration, including configuration, a failed container start, the corrected port handling, and successful tests.
2. Verify they appear as one topic package with compact conclusions and collapsed raw evidence.
3. Verify a low-risk tested configuration lesson auto-approves as L2.
4. Verify an architecture conclusion remains pending as L3.
5. Add contradictory evidence and verify automatic approval stops and the conflict becomes visible.
6. Resolve the conflict, refresh, approve the revised L3 candidate, and verify the approved memory retains source relations and audit history.
7. Run refresh again and verify no duplicate topic, candidate, or memory is created.

## Completion Criteria

The feature is complete when a project with many L1 traces can be understood and governed from topic packages without routine raw-trace reading; related evidence updates one package incrementally; only policy-eligible L2 conclusions auto-approve; L3, Skill, sensitive, risky, unverified, and conflicted conclusions remain explicitly reviewable; and every conclusion is project-isolated, traceable, auditable, and reversible.
