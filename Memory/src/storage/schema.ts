import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 11;
export const SCHEMA_MIGRATION_ID = "011_asset_recall_terminal_outcomes";
const API_LOG_SOURCE_AGENT_MIGRATION_FROM_VERSION = 2;
const PROCESSING_TAGS = new Set([
  "摘要排队中",
  "摘要整理中",
  "摘要总结中",
  "建立索引中",
  "索引建立中",
  "索引已建立",
  "处理失败"
]);

const statements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    timeline TEXT NOT NULL,
    user_id TEXT NOT NULL,
    conversation_id TEXT,
    session_id TEXT,
    agent_id TEXT,
    app_id TEXT,
    memory_type TEXT NOT NULL DEFAULT 'LongTermMemory',
    status TEXT NOT NULL DEFAULT 'activated'
      CHECK (status IN ('activated', 'resolving', 'archived', 'deleted')),
    visibility TEXT NOT NULL DEFAULT 'private',
    memory_key TEXT,
    memory_value TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
    info_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(info_json)),
    properties_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties_json)),
    memory_layer TEXT NOT NULL CHECK (memory_layer IN ('L1', 'L2', 'L3', 'Skill')),
    content_hash TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_memories_layer_status_updated
    ON memories (memory_layer, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_conversation_updated
    ON memories (conversation_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_session_layer
    ON memories (session_id, memory_layer, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_agent_app
    ON memories (agent_id, app_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_content_hash_layer
    ON memories (content_hash, memory_layer)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_key_layer
    ON memories (memory_key, memory_layer)`,

  `CREATE TABLE IF NOT EXISTS memory_relations (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK (relation IN ('supersedes')),
    reason TEXT,
    actor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(actor_json)),
    created_at TEXT NOT NULL,
    UNIQUE (source_memory_id, target_memory_id, relation)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_relations_source
    ON memory_relations (source_memory_id, relation, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_relations_target
    ON memory_relations (target_memory_id, relation, created_at DESC)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5 (
    id UNINDEXED,
    identifier,
    memory_value,
    tags,
    tokenize='unicode61'
  )`,

  `CREATE TABLE IF NOT EXISTS memory_vector_entries (
    id INTEGER PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    vector_field TEXT NOT NULL CHECK (vector_field IN ('vec_summary', 'vec_action', 'vec')),
    embedding_model TEXT,
    embedding_provider TEXT,
    embedding_dim INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (memory_id, vector_field)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_vector_entries_field_updated
    ON memory_vector_entries (vector_field, updated_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    source TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    profile_label TEXT,
    workspace_id TEXT,
    workspace_path TEXT,
    host_session_key TEXT,
    conversation_id TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'closed')),
    meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
    opened_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    closed_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_updated
    ON sessions (user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_host_key
    ON sessions (host_session_key)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_host_scope
    ON sessions (user_id, source, profile_id, host_session_key, status)`,

  `CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    project_id TEXT,
    conversation_id TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'closed')),
    title TEXT,
    summary TEXT,
    l1_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(l1_memory_ids_json)),
    raw_turn_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(raw_turn_ids_json)),
    feedback_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(feedback_ids_json)),
    decision_repair_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(decision_repair_ids_json)),
    l2_policy_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(l2_policy_ids_json)),
    l3_world_model_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(l3_world_model_ids_json)),
    skill_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_memory_ids_json)),
    turn_count INTEGER NOT NULL DEFAULT 0,
    r_task REAL,
    reward_detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(reward_detail_json)),
    pipeline_run_id TEXT,
    pipeline_status TEXT NOT NULL DEFAULT 'idle' CHECK (pipeline_status IN ('idle', 'running', 'succeeded', 'failed')),
    pipeline_error TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_session_updated
    ON episodes (session_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_project_updated
    ON episodes (project_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_pipeline
    ON episodes (pipeline_status, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS raw_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    conversation_id TEXT,
    user_text TEXT,
    assistant_text TEXT,
    reasoning_summary TEXT,
    tool_calls_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_calls_json)),
    tool_results_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_results_json)),
    source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
    usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
    message_payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(message_payload_json)),
    status TEXT NOT NULL DEFAULT 'succeeded',
    redacted_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, turn_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_raw_turns_episode_created
    ON raw_turns (episode_id, created_at ASC)`,

  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    conversation_id TEXT,
    session_id TEXT,
    episode_id TEXT,
    l1_memory_id TEXT,
    raw_turn_id TEXT,
    channel TEXT NOT NULL CHECK (channel IN ('explicit', 'implicit')),
    polarity TEXT NOT NULL CHECK (polarity IN ('positive', 'negative', 'neutral')),
    magnitude REAL NOT NULL DEFAULT 1,
    rationale TEXT,
    raw_payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(raw_payload_json)),
    context_hash TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_session_created
    ON feedback (session_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_memory
    ON feedback (l1_memory_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_user_created
    ON feedback (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_episode_created
    ON feedback (episode_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_raw_turn_created
    ON feedback (raw_turn_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_context
    ON feedback (user_id, project_id, context_hash, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS decision_repairs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    episode_id TEXT,
    raw_turn_id TEXT,
    user_id TEXT NOT NULL,
    project_id TEXT,
    context_hash TEXT,
    issue TEXT NOT NULL,
    suggestion TEXT NOT NULL,
    preference TEXT,
    anti_pattern TEXT,
    high_value_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(high_value_memory_ids_json)),
    low_value_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(low_value_memory_ids_json)),
    attached_policy_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attached_policy_memory_ids_json)),
    feedback_id TEXT,
    validated INTEGER NOT NULL DEFAULT 0 CHECK (validated IN (0, 1)),
    source_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_json)),
    meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_decision_repairs_context
    ON decision_repairs (user_id, project_id, context_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_decision_repairs_episode
    ON decision_repairs (episode_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS l2_candidate_pool (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    source_memory_id TEXT NOT NULL,
    candidate_key TEXT NOT NULL,
    candidate_value TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'promoted', 'rejected')),
    evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_l2_candidate_status
    ON l2_candidate_pool (user_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_l2_candidate_pending_expiry
    ON l2_candidate_pool (user_id, candidate_key, status, expires_at)`,

  `CREATE TABLE IF NOT EXISTS trace_policy_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    l1_memory_id TEXT NOT NULL,
    l2_memory_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'supports',
    strength REAL NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (l1_memory_id, l2_memory_id, relation)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trace_policy_links_l1
    ON trace_policy_links (user_id, l1_memory_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_trace_policy_links_l2
    ON trace_policy_links (user_id, l2_memory_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS skill_trials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    skill_memory_id TEXT NOT NULL,
    session_id TEXT,
    episode_id TEXT NOT NULL,
    l1_memory_id TEXT,
    raw_turn_id TEXT,
    turn_id TEXT,
    tool_call_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'pass', 'fail', 'unknown')),
    outcome TEXT NOT NULL DEFAULT 'unknown'
      CHECK (outcome IN ('unknown', 'success', 'failure', 'cancelled')),
    feedback_id TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_skill_trials_skill_created
    ON skill_trials (skill_memory_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_trials_user_status
    ON skill_trials (user_id, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_trials_episode_status
    ON skill_trials (episode_id, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_trials_l1_status
    ON skill_trials (l1_memory_id, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_trials_raw_status
    ON skill_trials (raw_turn_id, status, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS recall_events (
    id TEXT PRIMARY KEY,
    namespace_id TEXT,
    session_id TEXT,
    episode_id TEXT,
    turn_id TEXT,
    user_id TEXT NOT NULL,
    query TEXT NOT NULL,
    query_hash TEXT,
    layers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(layers_json)),
    candidate_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_memory_ids_json)),
    injected_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(injected_memory_ids_json)),
    hit_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hit_memory_ids_json)),
    dropped_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dropped_json)),
    outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'positive', 'negative', 'ignored')),
    request_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(request_json)),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recall_events_session_created
    ON recall_events (session_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS api_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL CHECK (tool_name IN ('memory_add', 'memory_search', 'skill_generate', 'skill_evolve')),
    source_agent TEXT,
    input_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
    output_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(output_json)),
    duration_ms INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0, 1)),
    called_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_logs_tool_time
    ON api_logs (tool_name, called_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_api_logs_tool_source_time
    ON api_logs (tool_name, source_agent, called_at DESC)`,

  `CREATE TABLE IF NOT EXISTS memory_change_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL,
    namespace_id TEXT,
    kind TEXT,
    op TEXT,
    entity_id TEXT,
    user_id TEXT NOT NULL,
    change_type TEXT NOT NULL,
    version INTEGER,
    before_json TEXT,
    after_json TEXT,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_change_log_namespace_seq
    ON memory_change_log (namespace_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_change_log_created
    ON memory_change_log (created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at TEXT NOT NULL,
    expires_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS evolution_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'dead_letter')),
    dedupe_key TEXT,
    user_id TEXT NOT NULL,
    session_id TEXT,
    episode_id TEXT,
    target_memory_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    leased_until TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_evolution_jobs_status_created
    ON evolution_jobs (status, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_evolution_jobs_target
    ON evolution_jobs (target_memory_id, job_type)`,

  `CREATE TABLE IF NOT EXISTS embedding_retry_queue (
    id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('trace', 'policy', 'world_model', 'skill')),
    target_id TEXT NOT NULL,
    vector_field TEXT NOT NULL CHECK (vector_field IN ('vec_summary', 'vec_action', 'vec')),
    source_text TEXT NOT NULL,
    embed_role TEXT NOT NULL DEFAULT 'document' CHECK (embed_role IN ('document', 'query')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'in_progress', 'failed', 'succeeded')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 6,
    next_attempt_at INTEGER NOT NULL,
    claimed_by TEXT,
    lease_until INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (target_kind, target_id, vector_field)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_retry_due
    ON embedding_retry_queue (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_retry_target
    ON embedding_retry_queue (target_kind, target_id)`,

  `CREATE TABLE IF NOT EXISTS memory_processing_state (
    memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN (
      'summary_pending', 'summarizing', 'embedding_pending', 'embedding',
      'ready', 'ready_text_only', 'failed'
    )),
    stage TEXT CHECK (stage IN ('summary', 'embedding')),
    active_job_id TEXT REFERENCES evolution_jobs(id) ON DELETE SET NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    manual_retry_count INTEGER NOT NULL DEFAULT 0,
    retry_action TEXT NOT NULL DEFAULT 'retry'
      CHECK (retry_action IN ('retry', 'open_settings', 'none')),
    error_code TEXT,
    error_message TEXT,
    failed_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_processing_state_state_updated
    ON memory_processing_state (state, updated_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_processing_state_active_job
    ON memory_processing_state (active_job_id)`,

  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    episode_id TEXT,
    raw_turn_id TEXT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    uri TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_session_created
    ON artifacts (session_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS runtime_kv (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value_json)),
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    actor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(actor_json)),
    action TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created
    ON audit_logs (user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS project_context_goals (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT,
    workspace_id TEXT,
    workspace_path TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,
    acceptance_criteria_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance_criteria_json)),
    constraints_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(constraints_json)),
    status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'completed', 'archived')),
    version INTEGER NOT NULL,
    supersedes_id TEXT REFERENCES project_context_goals(id),
    source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
    provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_project_context_active_goal
    ON project_context_goals(namespace_id) WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS idx_project_context_goals_namespace
    ON project_context_goals(namespace_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS project_context_work_items (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT,
    workspace_id TEXT,
    workspace_path TEXT,
    goal_id TEXT REFERENCES project_context_goals(id),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    next_step TEXT NOT NULL,
    acceptance_criteria_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance_criteria_json)),
    constraints_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(constraints_json)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'blocked', 'completed', 'archived')),
    focused INTEGER NOT NULL DEFAULT 0 CHECK (focused IN (0, 1)),
    source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
    provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_project_context_focused_work_item
    ON project_context_work_items(namespace_id) WHERE focused = 1`,
  `CREATE INDEX IF NOT EXISTS idx_project_context_work_items_namespace
    ON project_context_work_items(namespace_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS project_context_facts (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT,
    workspace_id TEXT,
    workspace_path TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'constraint')),
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'superseded', 'archived')),
    supersedes_id TEXT REFERENCES project_context_facts(id),
    source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
    provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_context_facts_namespace
    ON project_context_facts(namespace_id, status, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS project_topics (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    project_id TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'merged')),
    version INTEGER NOT NULL,
    source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_topics_namespace_status_updated ON project_topics(namespace_id, status, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS project_topic_evidence (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES project_topics(id) ON DELETE CASCADE,
    namespace_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    role TEXT NOT NULL,
    summary TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    UNIQUE(topic_id, memory_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_topic_evidence_topic ON project_topic_evidence(namespace_id, topic_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS project_topic_candidates (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES project_topics(id) ON DELETE CASCADE,
    namespace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    conclusion TEXT NOT NULL,
    proposed_layer TEXT NOT NULL CHECK (proposed_layer IN ('L2', 'L3', 'Skill')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'deferred', 'superseded')),
    version INTEGER NOT NULL,
    supersedes_id TEXT REFERENCES project_topic_candidates(id),
    source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_topic_candidates_topic_status ON project_topic_candidates(namespace_id, topic_id, status, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS project_topic_analysis_runs (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    topic_id TEXT,
    status TEXT NOT NULL,
    owner TEXT,
    lease_until TEXT,
    result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(namespace_id, input_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_topic_analysis_namespace ON project_topic_analysis_runs(namespace_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS project_topic_decision_sessions (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'draft', 'gathering_evidence', 'debating', 'ready_for_decision',
      'awaiting_user_input', 'blocked_by_evidence', 'executing',
      'completed', 'stale', 'failed', 'cancelled'
    )),
    version INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (namespace_id, topic_id, input_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_topic_decision_sessions_namespace ON project_topic_decision_sessions(namespace_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS project_topic_decision_snapshots (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES project_topic_decision_sessions(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_topic_decision_snapshots_session ON project_topic_decision_snapshots(namespace_id, session_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS project_topic_agent_positions (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES project_topic_decision_sessions(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    stance TEXT NOT NULL,
    rationale TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    confidence REAL,
    missing_information_json TEXT DEFAULT '[]' CHECK (missing_information_json IS NULL OR json_valid(missing_information_json)),
    risks_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(risks_json)),
    assumptions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assumptions_json)),
    created_at TEXT NOT NULL,
    UNIQUE (session_id, snapshot_id, round, agent_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_topic_agent_positions_session_snapshot ON project_topic_agent_positions(namespace_id, session_id, snapshot_id)`,

  `CREATE TABLE IF NOT EXISTS project_topic_debate_rounds (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES project_topic_decision_sessions(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, round)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_topic_debate_rounds_session ON project_topic_debate_rounds(namespace_id, session_id, round)`,

  `CREATE TABLE IF NOT EXISTS project_topic_evidence_requests (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES project_topic_decision_sessions(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    question TEXT NOT NULL,
    verification TEXT NOT NULL CHECK (verification IN (
      'repository_verified', 'tool_verified', 'user_authoritative',
      'user_supplied_unverified', 'contradicted'
    )),
    status TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_topic_evidence_requests_session ON project_topic_evidence_requests(namespace_id, session_id, round)`,

  `CREATE TABLE IF NOT EXISTS project_topic_action_proposals (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES project_topic_decision_sessions(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
    effect TEXT NOT NULL CHECK (effect IN (
      'read', 'analyze', 'draft', 'create_candidate_task',
      'authoritative_write', 'external_write', 'delete',
      'topic_mutation', 'memory_promotion'
    )),
    title TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_topic_action_proposals_session ON project_topic_action_proposals(namespace_id, session_id, round)`,

  `CREATE TABLE IF NOT EXISTS project_topic_execution_runs (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES project_topic_decision_sessions(id) ON DELETE CASCADE,
    proposal_id TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_topic_execution_runs_session ON project_topic_execution_runs(namespace_id, session_id, proposal_id)`,
  `CREATE TABLE IF NOT EXISTS memory_assets (
    id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('chat_memory', 'skill', 'wiki', 'code_graph')),
    stable_key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL CHECK (status IN ('candidate', 'reviewing', 'active', 'deprecated', 'rejected')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    content_ref TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('private', 'team', 'restricted', 'agent')),
    allowed_agent_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_agent_ids_json)),
    source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
    source_episode_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_episode_ids_json)),
    source_trace_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_trace_ids_json)),
    source_topic_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_topic_ids_json)),
    applicability_json TEXT NOT NULL CHECK (json_valid(applicability_json)),
    validation_json TEXT NOT NULL CHECK (json_valid(validation_json)),
    provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (namespace_id, id, version),
    UNIQUE (namespace_id, stable_key, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_assets_namespace_status
    ON memory_assets (namespace_id, status, asset_type, stable_key, version DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_assets_namespace_id_version
    ON memory_assets (namespace_id, id, version DESC)`,

  `CREATE TABLE IF NOT EXISTS memory_temporal_validity (
    namespace_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    effective_from TEXT,
    effective_until TEXT,
    review_after TEXT,
    freshness TEXT NOT NULL CHECK (freshness IN ('current', 'review_due', 'stale', 'superseded', 'historical')),
    invalidation_keys_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(invalidation_keys_json)),
    invalidated_at TEXT,
    invalidation_reason TEXT,
    superseded_by_memory_id TEXT,
    last_reviewed_at TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    PRIMARY KEY (namespace_id, memory_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_temporal_validity_freshness
    ON memory_temporal_validity (namespace_id, freshness, review_after, memory_id)`,

  `CREATE TABLE IF NOT EXISTS memory_temporal_events (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    validity_version INTEGER NOT NULL CHECK (validity_version > 0),
    event_type TEXT NOT NULL CHECK (event_type IN ('initialized', 'review_due', 'reviewed', 'invalidated', 'superseded', 'historical')),
    actor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(actor_json)),
    reason TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    project_state_ref_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(project_state_ref_json)),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_temporal_events_memory_created
    ON memory_temporal_events (namespace_id, memory_id, created_at ASC, id ASC)`,
  `CREATE TABLE IF NOT EXISTS agent_loadout_entries (
    id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    asset_version INTEGER NOT NULL CHECK (asset_version > 0),
    mode TEXT NOT NULL CHECK (mode IN ('bootstrap', 'recall', 'tool')),
    priority INTEGER NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    project_id TEXT,
    plan_id TEXT,
    work_item_id TEXT,
    task_types_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(task_types_json)),
    retire_when TEXT NOT NULL CHECK (retire_when IN ('work_item_completed', 'plan_completed', 'project_completed', 'explicit', 'never')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (namespace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_loadout_entries_agent_enabled
    ON agent_loadout_entries (namespace_id, agent_id, enabled, priority DESC, id ASC)`,

  `CREATE TABLE IF NOT EXISTS asset_recall_events (
    id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    asset_version INTEGER NOT NULL CHECK (asset_version > 0),
    agent_id TEXT NOT NULL,
    episode_id TEXT,
    task_id TEXT,
    loadout_entry_id TEXT,
    offered_event_id TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('bootstrap', 'recall', 'tool')),
    event_key TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('offered', 'used', 'ignored', 'failed')),
    temporal_validity_version INTEGER NOT NULL CHECK (temporal_validity_version > 0),
    freshness_at_recall TEXT NOT NULL CHECK (freshness_at_recall IN ('current', 'review_due', 'stale', 'superseded', 'historical')),
    eligibility_evaluated_at TEXT NOT NULL,
    score_inputs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(score_inputs_json)),
    failure_reason TEXT,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (namespace_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_recall_events_idempotency
    ON asset_recall_events (namespace_id, COALESCE(episode_id, ''), asset_id, asset_version, mode, event_key)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_recall_events_episode
    ON asset_recall_events (namespace_id, episode_id, created_at ASC, id ASC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_recall_events_terminal_offer
    ON asset_recall_events (namespace_id, offered_event_id)
    WHERE offered_event_id IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS experience_sequences (
    id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (namespace_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS experience_sequence_members (
    id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    sequence_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    role TEXT NOT NULL CHECK (role IN ('solve', 'curate', 'verify')),
    task_id TEXT,
    plan_id TEXT,
    work_item_id TEXT,
    topic_id TEXT,
    provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (namespace_id, id),
    UNIQUE (namespace_id, sequence_id, position),
    UNIQUE (namespace_id, episode_id),
    FOREIGN KEY (namespace_id, sequence_id) REFERENCES experience_sequences(namespace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_experience_sequence_members_order
    ON experience_sequence_members (namespace_id, sequence_id, position ASC, id ASC)`,

  `CREATE TABLE IF NOT EXISTS asset_reward_evidence (
    id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    sequence_id TEXT NOT NULL,
    source_episode_id TEXT NOT NULL,
    target_episode_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    asset_version INTEGER NOT NULL CHECK (asset_version > 0),
    recall_event_id TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (relation IN ('explicit_sequence', 'asset_usage', 'plan_work_item', 'none')),
    target_task_reward REAL NOT NULL,
    usage_factor REAL NOT NULL,
    relation_confidence REAL NOT NULL,
    applicability_factor REAL NOT NULL,
    transfer_reward REAL NOT NULL,
    risk_penalty REAL NOT NULL CHECK (risk_penalty >= 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'unknown')),
    reason TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (namespace_id, id),
    UNIQUE (namespace_id, event_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_asset_reward_evidence_asset
    ON asset_reward_evidence (namespace_id, asset_id, asset_version, created_at ASC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_reward_evidence_target_episode
    ON asset_reward_evidence (namespace_id, target_episode_id, created_at ASC, id ASC)`,
];

export function migrate(db: Database.Database): void {
  const now = new Date().toISOString();
  const checksum = String(statements.join("\n").length);
  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }) ?? 0);
  const hasMemories = tableExists(db, "memories");
  const version = currentSchemaVersion(db);

  if (hasMemories && version !== SCHEMA_VERSION && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8 && version !== 9 && version !== 10) {
    throw new Error(
      `Unsupported memory database schema version ${version}; the database was left unchanged`
    );
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Memory database schema version ${version} is newer than supported version ${SCHEMA_VERSION}`
    );
  }

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      if (version === API_LOG_SOURCE_AGENT_MIGRATION_FROM_VERSION &&
          !columnExists(db, "api_logs", "source_agent")) {
        db.prepare(`ALTER TABLE api_logs ADD COLUMN source_agent TEXT`).run();
      }
      if (tableExists(db, "asset_recall_events") &&
          !columnExists(db, "asset_recall_events", "offered_event_id")) {
        db.prepare(`ALTER TABLE asset_recall_events ADD COLUMN offered_event_id TEXT`).run();
      }
      for (const statement of statements) {
        db.prepare(statement).run();
      }
      if (tableExists(db, "project_topic_analysis_runs")) {
        if (!columnExists(db, "project_topic_analysis_runs", "owner")) db.prepare(`ALTER TABLE project_topic_analysis_runs ADD COLUMN owner TEXT`).run();
        if (!columnExists(db, "project_topic_analysis_runs", "lease_until")) db.prepare(`ALTER TABLE project_topic_analysis_runs ADD COLUMN lease_until TEXT`).run();
        db.prepare(`UPDATE project_topic_analysis_runs
          SET status = 'failed', owner = NULL, result_json = '{"error":"legacy claim recovered"}', updated_at = ?
          WHERE status = 'claimed' AND lease_until IS NULL`).run(now);

      }
      db.prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_evolution_jobs_active_dedupe
         ON evolution_jobs (dedupe_key)
         WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'leased', 'failed')`
      ).run();

      if (hasMemories && version < SCHEMA_VERSION) {
        backfillMemoryProcessingState(db, now);
        removeLegacyProcessingMetadata(db);
      }

      db.prepare(
        `INSERT INTO schema_migrations (id, version, applied_at, checksum)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           applied_at = excluded.applied_at,
           checksum = excluded.checksum`
      ).run(SCHEMA_MIGRATION_ID, SCHEMA_VERSION, now, checksum);
    })();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

function currentSchemaVersion(db: Database.Database): number {
  if (!tableExists(db, "schema_migrations")) return 0;
  return Number((db.prepare(
    `SELECT MAX(version) AS version FROM schema_migrations`
  ).get() as { version?: number } | undefined)?.version ?? 0);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((item) => item.name === column);
}

function backfillMemoryProcessingState(db: Database.Database, now: string): void {
  db.prepare(
    `INSERT INTO memory_processing_state (
       memory_id, state, stage, active_job_id, attempt_count, manual_retry_count,
       retry_action, error_code, error_message, failed_at, updated_at
     )
     SELECT
       memories.id,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM memory_vector_entries
           WHERE memory_id = memories.id AND vector_field = 'vec_summary'
         ) THEN 'ready'
         WHEN COALESCE(latest_job.status, '') = 'dead_letter'
           OR COALESCE(latest_retry.status, '') = 'failed' THEN 'failed'
         WHEN COALESCE(latest_job.job_type, '') IN ('trace_summary', 'import_summary')
           THEN 'summary_pending'
         WHEN TRIM(COALESCE(
           json_extract(properties_json, '$.internal_info.trace.summary'),
           json_extract(info_json, '$.summary'),
           json_extract(properties_json, '$.internal_info.summary'),
           ''
         )) = '' THEN 'summary_pending'
         WHEN LOWER(TRIM(COALESCE(
           json_extract(properties_json, '$.internal_info.trace.summary'),
           json_extract(info_json, '$.summary'),
           json_extract(properties_json, '$.internal_info.summary'),
           ''
         ))) IN ('user', 'assistant', 'system', 'tool', 'developer', '摘要排队中', '摘要整理中', '摘要总结中')
           THEN 'summary_pending'
         ELSE 'embedding_pending'
       END,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM memory_vector_entries
           WHERE memory_id = memories.id AND vector_field = 'vec_summary'
         ) THEN NULL
         WHEN COALESCE(latest_job.job_type, '') IN ('trace_summary', 'import_summary') THEN 'summary'
         WHEN COALESCE(latest_job.job_type, '') = 'embedding'
           OR COALESCE(latest_retry.status, '') = 'failed' THEN 'embedding'
         WHEN TRIM(COALESCE(
           json_extract(properties_json, '$.internal_info.trace.summary'),
           json_extract(info_json, '$.summary'),
           json_extract(properties_json, '$.internal_info.summary'),
           ''
         )) = '' THEN 'summary'
         WHEN LOWER(TRIM(COALESCE(
           json_extract(properties_json, '$.internal_info.trace.summary'),
           json_extract(info_json, '$.summary'),
           json_extract(properties_json, '$.internal_info.summary'),
           ''
         ))) IN ('user', 'assistant', 'system', 'tool', 'developer', '摘要排队中', '摘要整理中', '摘要总结中')
           THEN 'summary'
         ELSE 'embedding'
       END,
       NULL,
       MAX(COALESCE(latest_job.attempts, 0), COALESCE(latest_retry.attempts, 0)),
       0,
       'retry',
       CASE
         WHEN COALESCE(latest_job.status, '') = 'dead_letter' THEN 'processing_failed'
         WHEN COALESCE(latest_retry.status, '') = 'failed' THEN 'embedding_failed'
         ELSE NULL
       END,
       COALESCE(latest_job.last_error, latest_retry.last_error),
       CASE
         WHEN COALESCE(latest_job.status, '') = 'dead_letter' THEN latest_job.updated_at
         WHEN COALESCE(latest_retry.status, '') = 'failed'
           THEN datetime(latest_retry.updated_at / 1000, 'unixepoch')
         ELSE NULL
       END,
       ?
     FROM memories
     LEFT JOIN evolution_jobs AS latest_job ON latest_job.id = (
       SELECT id FROM evolution_jobs
       WHERE target_memory_id = memories.id
         AND job_type IN ('trace_summary', 'import_summary', 'embedding')
       ORDER BY updated_at DESC, rowid DESC LIMIT 1
     )
     LEFT JOIN embedding_retry_queue AS latest_retry ON latest_retry.id = (
       SELECT id FROM embedding_retry_queue
       WHERE target_kind = 'trace' AND target_id = memories.id
         AND vector_field = 'vec_summary'
       ORDER BY updated_at DESC, rowid DESC LIMIT 1
     )
     WHERE memories.deleted_at IS NULL
       AND memories.status != 'deleted'
       AND memories.memory_layer = 'L1'
       AND json_extract(properties_json, '$.internal_info.memory_kind') = 'trace'
     ON CONFLICT(memory_id) DO NOTHING`
  ).run(now);

  db.prepare(
    `DELETE FROM evolution_jobs
     WHERE job_type IN ('trace_summary', 'import_summary', 'embedding')
       AND target_memory_id IN (SELECT memory_id FROM memory_processing_state)`
  ).run();
  db.prepare(
    `DELETE FROM embedding_retry_queue
     WHERE target_kind = 'trace'
       AND target_id IN (SELECT memory_id FROM memory_processing_state)`
  ).run();
}

function removeLegacyProcessingMetadata(db: Database.Database): void {
  const rows = db.prepare(
    `SELECT id, tags_json, info_json, properties_json, memory_value, status, deleted_at
     FROM memories
     WHERE memory_layer = 'L1'
       AND json_extract(properties_json, '$.internal_info.memory_kind') = 'trace'`
  ).all() as Array<{
    id: string;
    tags_json: string;
    info_json: string;
    properties_json: string;
    memory_value: string;
    status: string;
    deleted_at: string | null;
  }>;

  for (const row of rows) {
    const tags = stripProcessingTags(parseJsonArray(row.tags_json));
    const info = parseJsonObject(row.info_json);
    const properties = parseJsonObject(row.properties_json);
    delete info.import_pipeline;
    if (Array.isArray(info.tags)) info.tags = stripProcessingTags(info.tags);
    if (Array.isArray(properties.tags)) properties.tags = stripProcessingTags(properties.tags);
    const publicInfo = isRecord(properties.info) ? properties.info : undefined;
    if (publicInfo) {
      delete publicInfo.import_pipeline;
      if (Array.isArray(publicInfo.tags)) publicInfo.tags = stripProcessingTags(publicInfo.tags);
    }
    const internalInfo = isRecord(properties.internal_info) ? properties.internal_info : undefined;
    if (internalInfo) delete internalInfo.import_pipeline;

    db.prepare(
      `UPDATE memories SET tags_json = ?, info_json = ?, properties_json = ? WHERE id = ?`
    ).run(JSON.stringify(tags), JSON.stringify(info), JSON.stringify(properties), row.id);
    db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(row.id);
    if (!row.deleted_at && row.status !== "deleted") {
      db.prepare(
        `INSERT INTO memories_fts (id, identifier, memory_value, tags) VALUES (?, ?, ?, ?)`
      ).run(row.id, row.id, row.memory_value, tags.join(" "));
    }
  }
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stripProcessingTags(values: unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .filter((value) => !PROCESSING_TAGS.has(value)))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

export function getSchemaVersion(db: Database.Database): {
  version: number;
  lastMigrationId?: string;
} {
  const row = db
    .prepare(
      `SELECT id, version
       FROM schema_migrations
       ORDER BY version DESC
       LIMIT 1`
    )
    .get() as { id: string; version: number } | undefined;

  return {
    version: row?.version ?? 0,
    lastMigrationId: row?.id
  };
}
