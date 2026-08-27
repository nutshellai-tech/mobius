export type HarnessBackend = 'codex' | 'claude-code' | 'deepseek-harness';
export type HarnessCapabilityTag = 'private_data_read' | 'untrusted_ingest' | 'outbound_network';
export const MAX_HARNESS_AGENTS = 5;

export interface HarnessProfileDefinitionV1 {
  schema_version: '1.1';
  backend: HarnessBackend;
  model: string;
  capabilities: {
    can_main: boolean;
    can_work: boolean;
    can_evaluate: boolean;
    supports_write: boolean;
    supports_network: boolean;
    supports_runtime_verification: boolean;
    max_concurrency: number;
  };
  model_traits: {
    needs_context_reset: boolean;
    context_window_tokens: number;
    supports_auto_compaction: boolean;
    calibrated?: boolean;
  };
  skills: string[];
  tools: {
    allow: string[];
    deny: string[];
    capability_tags: HarnessCapabilityTag[];
  };
  cost_profile: { relative_cost_factor: number };
  default_context_policy: Record<string, unknown>;
  default_tool_policy: Record<string, unknown>;
}

export type HarnessExecutionMode = 'single' | 'multi';
export type HarnessMemberRole = 'main' | 'worker' | 'evaluator';
export type HarnessRiskLevel = 'low' | 'medium' | 'high';

export interface HarnessRunPolicyV1_0 {
  schema_version: '1.0';
  collaboration_shape: 'pipeline';
  max_concurrent_subharnesses: 1;
  max_depth: 0 | 1;
  max_nodes: 1 | 2 | 3 | 4 | 5;
  default_timeout_seconds: number;
  workspace_policy: 'read_only';
  evaluator_policy: 'by_risk' | 'always' | 'off';
  context_reset_policy: 'off';
  cost_soft_limit_usd: number;
  cost_hard_limit_usd: number;
}

export interface HarnessRunPolicyV1_1 {
  schema_version: '1.1';
  topology_selection_mode: 'explicit' | 'recommend' | 'auto_safe';
  collaboration_shape: 'pipeline' | 'adaptive' | 'fanout';
  max_concurrent_subharnesses: 1 | 2 | 3 | 4;
  parallel_read_only_only: true;
  max_depth: 0 | 1;
  max_nodes: 1 | 2 | 3 | 4 | 5;
  default_timeout_seconds: number;
  workspace_policy: 'read_only';
  evaluator_policy: 'by_risk' | 'always' | 'off';
  context_reset_policy: 'off';
  cost_soft_limit_usd: number;
  cost_hard_limit_usd: number;
}

export type HarnessRunPolicyV1 = HarnessRunPolicyV1_0 | HarnessRunPolicyV1_1;

export interface HarnessRosterDraftMemberV1 {
  member_key: string;
  profile_id: string;
  purpose?: 'worker' | 'evaluator';
}

export interface HarnessEstimateRequestV1 {
  anchor_type: 'issue';
  issue_id: string;
  session_name?: string;
  language?: 'zh' | 'en';
  excluded_skill_ids?: string[];
  excluded_memory_ids?: string[];
  goal: string;
  execution_mode: HarnessExecutionMode;
  roster: {
    main_member_key: string;
    members: HarnessRosterDraftMemberV1[];
    /**
     * Reserve an adaptive pool of Worker instances from the selected Profiles.
     * The Main still decides how many of those instances are actually started.
     */
    auto_expand?: boolean;
  };
  policy?: Partial<HarnessRunPolicyV1_1>;
}

export interface HarnessEstimateAcknowledgementV1 {
  estimate_id: string;
  shown_cost_usd_range: [number, number];
}

export interface HarnessStoredEstimateAcknowledgementV1 {
  cost_range: [number, number];
  duration_range: [number, number];
  relative_to_single: number;
}

export interface HarnessRunCreatedEventPayloadV1 {
  execution_mode: HarnessExecutionMode;
  policy: HarnessRunPolicyV1;
  acknowledged_estimate: HarnessStoredEstimateAcknowledgementV1 | null;
}

export interface HarnessCreateRunRequestV1 extends HarnessEstimateRequestV1 {
  request_id: string;
  acknowledged_estimate?: HarnessEstimateAcknowledgementV1;
}

export interface HarnessAcceptanceCriterionV1 {
  id: string;
  description: string;
  verification: 'deterministic' | 'runtime_check' | 'evaluator' | 'parent_review';
  required: boolean;
  threshold?: number;
  weight?: number;
  check?: { command?: string; expect_exit_code?: number; expect_artifact_kind?: string };
}

export interface HarnessTaskParallelismV1_2 {
  mode: 'serial' | 'parallel_safe';
  independence_key?: string;
  reason?: string;
  estimated_duration_seconds?: number;
  read_scopes?: string[];
  mutable_resources?: string[];
  aggregation_key?: string;
  expected_output_size_bytes?: number;
  failure_policy?: 'continue_siblings' | 'stop_group';
}

export interface HarnessTaskContractV1_1 {
  schema_version: '1.1';
  objective: string;
  risk_level: HarnessRiskLevel;
  acceptance_criteria: HarnessAcceptanceCriterionV1[];
  inputs: Array<{
    kind: 'artifact' | 'file' | 'session' | 'research' | 'url' | 'text';
    ref: string;
    description?: string;
    trust: 'instruction' | 'data_only';
  }>;
  deliverables: Array<{
    kind: 'report' | 'patch' | 'commit' | 'file' | 'test_result' | 'structured_data';
    name: string;
    required: boolean;
  }>;
  dependencies: string[];
  workspace: { mode: 'read_only'; allowed_paths?: string[] };
  tools: {
    profile: 'research' | 'coding' | 'review' | 'custom';
    allow?: string[];
    deny?: string[];
    capability_tags: HarnessCapabilityTag[];
  };
  budget: { timeout_seconds: number; max_turns?: number; max_cost_usd?: number; max_attempts?: number };
  communication: { parent_only: true; progress_interval_seconds?: number };
}

export interface HarnessTaskContractV1_2 extends Omit<HarnessTaskContractV1_1, 'schema_version'> {
  schema_version: '1.2';
  parallelism?: HarnessTaskParallelismV1_2;
}

export type HarnessTaskContractV1 = HarnessTaskContractV1_1 | HarnessTaskContractV1_2;

export interface HarnessNodeBatchRequestV1 {
  request_id: string;
  nodes: Array<{
    client_ref: string;
    assignee_member_id: string;
    task_contract: HarnessTaskContractV1;
  }>;
}

export interface HarnessNodeResultV1 {
  schema_version: '1.1';
  status: 'succeeded' | 'failed' | 'partial';
  summary: string;
  acceptance_results: Array<{
    criterion_id: string;
    score: number;
    evidence_artifact_ids: string[];
    detail?: string;
  }>;
  artifact_ids: string[];
  tests: Array<{
    command?: string;
    status: 'passed' | 'failed' | 'not_run';
    artifact_id?: string;
    detail?: string;
  }>;
  risks: string[];
  unresolved: string[];
  recommended_followups: string[];
}

export interface HarnessNodeOutputV1_2 {
  kind: 'report' | 'structured_data';
  name: string;
  mime_type: 'text/markdown' | 'application/json';
  content: string;
}

export interface HarnessSynthesisManifestV1 {
  included_result_event_ids: string[];
  excluded_results: Array<{ event_id: string; reason: string }>;
  criterion_sources: Array<{
    criterion_id: string;
    source_event_ids: string[];
  }>;
  deduplication_keys: string[];
  conflicts: Array<{
    source_event_ids: string[];
    resolution: string;
    unresolved: boolean;
  }>;
  coverage_gaps: string[];
}

export interface HarnessNodeResultV1_2 extends Omit<HarnessNodeResultV1, 'schema_version'> {
  schema_version: '1.2';
  outputs: HarnessNodeOutputV1_2[];
  synthesis_manifest?: HarnessSynthesisManifestV1;
}

export type HarnessNodeResult = HarnessNodeResultV1 | HarnessNodeResultV1_2;

export interface HarnessResultAckRequestV1 {
  request_id: string;
  last_seen_seq: number;
}

export interface HarnessInternalTokenPayload {
  kind: 'harness-node';
  run_id: string;
  node_id: string;
  member_id: string;
  role: HarnessMemberRole;
  allowed_member_ids: string[];
  actions: string[];
  iat?: number;
  exp?: number;
}
