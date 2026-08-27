import { db } from '../../db';
import { PORT } from '../config';
import { harnessDagNodeStates } from './harness-dag';
import { parseHarnessRunPolicy, parseJsonColumn } from './harness-schema';

type AnyRow = Record<string, any>;

const RESERVED_SUB_STATES = ['queued', 'starting', 'running', 'waiting_input', 'submitted', 'verifying'];
const TERMINAL_SUB_STATES = ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted', 'orphaned'];

export interface HarnessSchedulingState {
  run_id: string;
  collaboration_shape: string;
  max_concurrency: number;
  max_nodes: number;
  total_nodes: number;
  active_sub_count: number;
  ready_sub_count: number;
  terminal_sub_count: number;
  idle_slots: number;
  remaining_node_capacity: number;
  available_member_ids: string[];
  underfilled: boolean;
  recommended_action: 'fill_parallel_wave' | 'scheduler_will_dispatch' | 'continue_main_work_or_wait' | 'synthesize_or_finalize';
}

function placeholders(values: string[]): string {
  return values.map(() => '?').join(',');
}

export function getHarnessSchedulingState(runId: string): HarnessSchedulingState {
  const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(runId) as AnyRow | undefined;
  if (!run) throw Object.assign(new Error('Harness Run 不存在'), { status: 404, code: 'harness_run_missing' });
  const policy = parseJsonColumn(run.policy_json, 'harness_runs.policy_json', parseHarnessRunPolicy);
  const maxConcurrency = policy.schema_version === '1.1' && policy.collaboration_shape !== 'pipeline'
    ? Math.max(1, Number(policy.max_concurrent_subharnesses) || 1)
    : 1;
  const totalNodes = Number((db.prepare('SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=?').get(runId) as AnyRow).count);
  const activeSubs = db.prepare(`SELECT id, assignee_member_id FROM harness_nodes
    WHERE run_id=? AND node_type!='root' AND status IN (${placeholders(RESERVED_SUB_STATES)})`)
    .all(runId, ...RESERVED_SUB_STATES) as AnyRow[];
  const activeMemberIds = new Set(activeSubs.map((node) => String(node.assignee_member_id)));
  const availableMemberIds = (db.prepare(`SELECT id FROM harness_run_members
    WHERE run_id=? AND role!='main' ORDER BY selection_order`).all(runId) as AnyRow[])
    .map((member) => String(member.id))
    .filter((memberId) => !activeMemberIds.has(memberId));
  const nodeTypes = new Map((db.prepare('SELECT id, node_type FROM harness_nodes WHERE run_id=?').all(runId) as AnyRow[])
    .map((node) => [String(node.id), String(node.node_type)]));
  const readySubCount = [...harnessDagNodeStates(runId).values()]
    .filter((state) => state.ready && nodeTypes.get(state.node_id) !== 'root').length;
  const terminalSubCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM harness_nodes
    WHERE run_id=? AND node_type!='root' AND status IN (${placeholders(TERMINAL_SUB_STATES)})`)
    .get(runId, ...TERMINAL_SUB_STATES) as AnyRow).count);
  const remainingNodeCapacity = Math.max(0, Number(policy.max_nodes) - totalNodes);
  const idleSlots = Math.max(0, Math.min(
    maxConcurrency - activeSubs.length,
    availableMemberIds.length,
    remainingNodeCapacity,
  ));
  const underfilled = activeSubs.length > 0 && idleSlots > 0;
  const recommendedAction = idleSlots > 0
    ? 'fill_parallel_wave'
    : readySubCount > 0 && activeSubs.length === 0
      ? 'scheduler_will_dispatch'
      : activeSubs.length > 0
        ? 'continue_main_work_or_wait'
        : 'synthesize_or_finalize';
  return {
    run_id: runId,
    collaboration_shape: policy.collaboration_shape,
    max_concurrency: maxConcurrency,
    max_nodes: Number(policy.max_nodes),
    total_nodes: totalNodes,
    active_sub_count: activeSubs.length,
    ready_sub_count: readySubCount,
    terminal_sub_count: terminalSubCount,
    idle_slots: idleSlots,
    remaining_node_capacity: remainingNodeCapacity,
    available_member_ids: availableMemberIds,
    underfilled,
    recommended_action: recommendedAction,
  };
}

export function buildHarnessSchedulingNudgePrompt(input: {
  runId: string;
  eventId: string;
  scheduling: HarnessSchedulingState;
}): string {
  return [
    'Harness scheduling notification (trusted control metadata only).',
    `run_id: ${input.runId}`,
    `scheduling_event_id: ${input.eventId}`,
    `active_sub_count: ${input.scheduling.active_sub_count}`,
    `idle_slots: ${input.scheduling.idle_slots}`,
    `remaining_node_capacity: ${input.scheduling.remaining_node_capacity}`,
    `recommended_action: ${input.scheduling.recommended_action}`,
    `scheduling_api: http://127.0.0.1:${PORT}/api/harness-internal/runs/${input.runId}/scheduling`,
    'Do not passively wait for the only active Sub. Reassess the goal now: dispatch all other currently known independent work in one node-batches request, or continue useful Main work that does not depend on the Sub.',
    'If no additional delegation or concurrent Main work is genuinely useful, record that coordination decision in your reasoning and then wait; do not create duplicate filler tasks.',
  ].join('\n');
}
