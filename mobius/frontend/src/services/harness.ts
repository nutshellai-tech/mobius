import { api } from '../store'
import { pollRecursive } from './polling'

export type HarnessExecutionMode = 'single' | 'multi'
export type HarnessMemberRole = 'main' | 'worker' | 'evaluator'
export type HarnessCollaborationShape = 'pipeline' | 'adaptive' | 'fanout'
export const MAX_HARNESS_AGENTS = 5

export interface HarnessPolicyDraft {
  schema_version: '1.1'
  topology_selection_mode: 'explicit' | 'recommend' | 'auto_safe'
  collaboration_shape: HarnessCollaborationShape
  max_concurrent_subharnesses: 1 | 2 | 3 | 4
  parallel_read_only_only: true
}

export interface HarnessFeatures {
  adaptive_scheduling_enabled: boolean
  batch_create_enabled: boolean
  max_parallel_subs: number
  root_result_wake_enabled: boolean
  result_ack_required: boolean
  notification_digest_enabled: boolean
}

export interface HarnessProfile {
  id: string
  name: string
  description: string
  backend: 'codex' | 'claude-code' | 'deepseek-harness'
  default_model: string
  version: number
  definition: {
    capabilities: {
      can_main: boolean
      can_work: boolean
      can_evaluate: boolean
      supports_write: boolean
      supports_network: boolean
      supports_runtime_verification: boolean
    }
    cost_profile: { relative_cost_factor: number }
  }
}

export interface HarnessRosterMemberDraft {
  member_key: string
  profile_id: string
  purpose?: 'worker' | 'evaluator'
}

export interface HarnessRunDraft {
  anchor_type: 'issue'
  issue_id: string
  session_name?: string
  language?: 'zh' | 'en'
  excluded_skill_ids?: string[]
  excluded_memory_ids?: string[]
  goal: string
  execution_mode: HarnessExecutionMode
  roster: {
    main_member_key: string
    members: HarnessRosterMemberDraft[]
    auto_expand?: boolean
  }
  policy?: HarnessPolicyDraft
}

export interface HarnessEstimate {
  estimate_id: string
  expires_at: string
  estimated_duration_seconds_range: [number, number]
  estimated_serial_duration_seconds_range: [number, number]
  estimated_cost_usd_range: [number, number]
  relative_to_single: number
  estimated_parallel_speedup: number
  assumptions: string[]
}

export interface HarnessRunRecord {
  id: string
  session_name?: string | null
  language?: 'zh' | 'en'
  goal: string
  execution_mode: HarnessExecutionMode
  status: string
  node_count?: number
  succeeded_node_count?: number
  created_at: string
  started_at?: string | null
  completed_at?: string | null
  updated_at: string
  policy: {
    schema_version: '1.0' | '1.1'
    topology_selection_mode?: 'explicit' | 'recommend' | 'auto_safe'
    collaboration_shape: HarnessCollaborationShape
    max_concurrent_subharnesses: number
  }
  final_result?: HarnessNodeResult | null
  failure?: { reason?: string } | null
  actual_cost_usd?: number
  cost_telemetry_status?: 'not_started' | 'reported' | 'zero_or_unreported'
  acknowledged_estimate?: {
    cost_range: [number, number]
    duration_range: [number, number]
    relative_to_single: number
  } | null
}

export interface HarnessMemberSnapshot {
  id: string
  role: HarnessMemberRole
  display_name: string
  selection_order: number
  config_snapshot: {
    member_key: string
    profile_id: string
    profile_version: number
  }
}

export interface HarnessNodeResult {
  schema_version?: '1.1' | '1.2'
  status: 'succeeded' | 'failed' | 'partial'
  summary: string
  risks: string[]
  unresolved: string[]
  recommended_followups: string[]
  outputs?: Array<{
    kind: 'report' | 'structured_data'
    name: string
    mime_type: 'text/markdown' | 'application/json'
    content: string
  }>
}

export interface HarnessNodeSnapshot {
  id: string
  parent_node_id?: string | null
  assignee_member_id: string
  path: string
  node_type: 'root' | 'worker' | 'evaluator'
  status: string
  model: string
  session_id?: string | null
  created_at: string
  started_at?: string | null
  completed_at?: string | null
  ready: boolean
  blocked_by: string[]
  waiting_reason?: string | null
  attempt: number
  max_attempts: number
  waived_at?: string | null
  waiver_reason?: string | null
  task_contract: {
    objective: string
    workspace: { mode: 'read_only' }
    parallelism?: { mode: 'serial' | 'parallel_safe'; independence_key?: string }
  }
  result?: HarnessNodeResult | null
  failure_json?: string | null
  actual_cost_usd?: number
  cost_telemetry_status?: 'not_started' | 'reported' | 'zero_or_unreported'
}

export interface HarnessEvent {
  event_id: string
  seq: number
  type: string
  from_node_id?: string | null
  to_node_id?: string | null
  created_at: string
  payload: Record<string, unknown>
}

export interface HarnessDispatchSnapshot {
  id: string
  node_id: string
  kind: string
  status: string
  attempt: number
  last_error?: string | null
}

export interface HarnessRunSnapshot {
  run: HarnessRunRecord
  members: HarnessMemberSnapshot[]
  nodes: HarnessNodeSnapshot[]
  dependencies: Array<{ node_id: string; depends_on_node_id: string }>
  dispatches: HarnessDispatchSnapshot[]
  events: HarnessEvent[]
}

export function listHarnessProfiles(projectId: string, signal?: AbortSignal): Promise<HarnessProfile[]> {
  return api(`/api/harness-profiles?project_id=${encodeURIComponent(projectId)}`, { signal })
}

export function getHarnessFeatures(signal?: AbortSignal): Promise<HarnessFeatures> {
  return api('/api/harness-runs/features', { signal })
}

export function estimateHarnessRun(draft: HarnessRunDraft, signal?: AbortSignal): Promise<HarnessEstimate> {
  return api('/api/harness-runs/estimate', {
    method: 'POST',
    body: JSON.stringify(draft),
    signal,
  })
}

export function createHarnessRun(
  draft: HarnessRunDraft,
  estimate?: HarnessEstimate,
): Promise<HarnessRunSnapshot> {
  return api('/api/harness-runs', {
    method: 'POST',
    body: JSON.stringify({
      ...draft,
      request_id: `ui:${crypto.randomUUID()}`,
      ...(estimate ? {
        acknowledged_estimate: {
          estimate_id: estimate.estimate_id,
          shown_cost_usd_range: estimate.estimated_cost_usd_range,
        },
      } : {}),
    }),
  })
}

export function listHarnessRuns(issueId: string, signal?: AbortSignal): Promise<HarnessRunRecord[]> {
  return api(`/api/harness-runs?issue_id=${encodeURIComponent(issueId)}`, { signal })
}

export function getHarnessRun(runId: string, signal?: AbortSignal): Promise<HarnessRunSnapshot> {
  return api(`/api/harness-runs/${encodeURIComponent(runId)}`, { signal })
}

function harnessControl(path: string, reason: string): Promise<{ ok: boolean; replayed?: boolean; data: Record<string, unknown> }> {
  return api(path, {
    method: 'POST',
    body: JSON.stringify({ request_id: `ui:${crypto.randomUUID()}`, reason }),
  })
}

export function retryHarnessNode(runId: string, nodeId: string, reason: string) {
  return harnessControl(`/api/harness-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/retry`, reason)
}

export function cancelHarnessNode(runId: string, nodeId: string, reason: string) {
  return harnessControl(`/api/harness-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/cancel`, reason)
}

export function waiveHarnessNode(runId: string, nodeId: string, reason: string) {
  return harnessControl(`/api/harness-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/waive`, reason)
}

export function cancelHarnessRun(runId: string, reason: string) {
  return harnessControl(`/api/harness-runs/${encodeURIComponent(runId)}/cancel`, reason)
}

export function isHarnessRunTerminal(status: string): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status)
}

export function waitForHarnessMainSession(runId: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stop = () => {}
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error('Harness Run 已创建，主会话仍在启动，请稍后从会话列表进入')))
    }, timeoutMs)
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      stop()
      callback()
    }
    stop = pollRecursive(async (signal) => {
      const snapshot = await getHarnessRun(runId, signal)
      const mainSessionId = snapshot.nodes.find((node) => node.node_type === 'root')?.session_id
      if (mainSessionId) {
        finish(() => resolve(mainSessionId))
        return
      }
      if (isHarnessRunTerminal(snapshot.run.status)) {
        finish(() => reject(new Error('Harness Run 已结束，但没有生成主会话')))
        return
      }
    }, 500, 5_000, { startImmediately: false })
  })
}
