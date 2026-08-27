import { db } from '../../db';
import { appendHarnessEvent } from '../repositories/harness';
import { harnessNodeRetryPending } from './harness-dag';
import type { HarnessExecutorRegistry } from './harness-executor';
import { queueReadyHarnessNodes } from './harness-dispatcher';
import { enqueueRootResultNotification } from './harness-result-notification';
import { parseHarnessControlAction, parseHarnessRecord, parseHarnessTaskContract, parseJsonColumn } from './harness-schema';
import { evaluateNodeTransition, evaluateRunTransition, type HarnessTransitionActor } from './harness-state-machine';

type AnyRow = Record<string, any>;

export interface HarnessControlResult {
  ok: boolean;
  replayed?: boolean;
  data: AnyRow;
}

function controlError(message: string, code: string, status = 400): Error {
  return Object.assign(new Error(message), { code, status });
}

function requestReplay(runId: string, requestId: string): HarnessControlResult | null {
  const event = db.prepare('SELECT payload_json FROM harness_events WHERE run_id=? AND request_id=?')
    .get(runId, requestId) as AnyRow | undefined;
  if (!event) return null;
  return {
    ok: true,
    replayed: true,
    data: parseJsonColumn(event.payload_json, 'harness_events.payload_json', parseHarnessRecord),
  };
}

function terminalFailureReason(node: AnyRow, fallback: string): string {
  try {
    const failure = JSON.parse(String(node.failure_json || '{}'));
    return String(failure.reason || fallback);
  } catch {
    return fallback;
  }
}

type CancellationSource = 'cancelled' | 'dependency' | 'policy' | 'budget';

function notifyCancelledChild(run: AnyRow, node: AnyRow, reason: string, source: CancellationSource): void {
  if (node.node_type === 'root' || ['failed', 'cancelling', 'cancelled'].includes(run.status)) return;
  enqueueRootResultNotification({
    run,
    childNode: node,
    outcome: 'failed',
    result: null,
    failureSource: source,
    reasons: [{ code: `node_${source}`, message: reason, category: source, retryable: false }],
  });
}

function requestNodeCancellationInTransaction(input: {
  run: AnyRow;
  node: AnyRow;
  actor: Extract<HarnessTransitionActor, 'user' | 'cascade'>;
  reason: string;
  requestId?: string;
  source: CancellationSource;
}): AnyRow {
  const { run, node, actor, reason, requestId, source } = input;
  if (node.status === 'cancelled') return { node_id: node.id, status: 'cancelled' };
  if (node.status === 'succeeded') throw controlError('已成功节点不能取消', 'node_already_succeeded', 409);
  const direct = node.status === 'created';
  const target = direct ? 'cancelled' : 'cancelling';
  const transition = evaluateNodeTransition({ from: node.status, to: target, actor });
  if (!transition.accepted) throw controlError(transition.reason, transition.code, 409);
  const failure = { category: source, reason, retryable: false };
  const updated = db.prepare(`UPDATE harness_nodes SET status=?, failure_json=?, waiting_reason=NULL,
    completed_at=CASE WHEN ?='cancelled' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END,
    lease_owner=NULL, lease_expires_at=NULL, version=version+1
    WHERE id=? AND version=?`).run(target, JSON.stringify(failure), target, node.id, node.version);
  if (updated.changes !== 1) throw controlError('节点版本冲突，请重试', 'version_conflict', 409);
  db.prepare(`UPDATE harness_dispatches SET status='cancelled', last_error=?, lease_owner=NULL, lease_expires_at=NULL
    WHERE node_id=? AND status IN ('queued','leased','dispatching')`).run(reason, node.id);
  const data = { node_id: node.id, status: target, reason };
  appendHarnessEvent({
    runId: run.id,
    type: direct ? 'node.cancelled' : 'node.cancellation_requested',
    fromNodeId: node.id,
    requestId,
    payload: data,
  });
  if (direct) {
    const stored = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(node.id) as AnyRow;
    notifyCancelledChild(run, stored, reason, source);
  }
  return data;
}

export function retryHarnessNodeByUser(userId: string, runId: string, nodeId: string, raw: unknown): HarnessControlResult {
  const input = parseHarnessControlAction(raw);
  const transaction = db.transaction(() => {
    const replay = requestReplay(runId, input.request_id);
    if (replay) return replay;
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(runId) as AnyRow | undefined;
    const node = db.prepare('SELECT * FROM harness_nodes WHERE id=? AND run_id=?').get(nodeId, runId) as AnyRow | undefined;
    if (!run || !node) throw controlError('Harness 节点不存在', 'harness_node_missing', 404);
    if (node.node_type === 'root') throw controlError('Root 重试必须通过新的 Run 发起', 'root_retry_forbidden', 409);
    if (!['failed', 'timed_out', 'interrupted'].includes(node.status)) {
      throw controlError(`节点处于 ${node.status}，不能重试`, 'node_retry_state_invalid', 409);
    }
    if (node.waived_at) throw controlError('已豁免节点不能重试', 'waived_node_retry_forbidden', 409);
    if (Number(node.attempt) >= Number(node.max_attempts)) {
      throw controlError('节点已经达到最大尝试次数', 'attempts_exhausted', 409);
    }
    let failure: AnyRow = {};
    try { failure = JSON.parse(String(node.failure_json || '{}')); } catch {}
    failure = { ...failure, retryable: true, retry_requested_by_user_id: userId, retry_reason: input.reason };
    db.prepare(`UPDATE harness_nodes SET failure_json=?, waiting_reason='retry:requested', version=version+1
      WHERE id=? AND version=?`).run(JSON.stringify(failure), node.id, node.version);
    const data = { node_id: node.id, status: node.status, retry_pending: true, reason: input.reason };
    appendHarnessEvent({ runId, type: 'node.retry_requested', fromNodeId: node.id,
      requestId: input.request_id, payload: data });
    return { ok: true, data };
  });
  const result = transaction.immediate();
  queueReadyHarnessNodes(runId);
  return result;
}

export function cancelHarnessNodeByUser(userId: string, runId: string, nodeId: string, raw: unknown): HarnessControlResult {
  const input = parseHarnessControlAction(raw);
  const transaction = db.transaction(() => {
    const replay = requestReplay(runId, input.request_id);
    if (replay) return replay;
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(runId) as AnyRow | undefined;
    const node = db.prepare('SELECT * FROM harness_nodes WHERE id=? AND run_id=?').get(nodeId, runId) as AnyRow | undefined;
    if (!run || !node) throw controlError('Harness 节点不存在', 'harness_node_missing', 404);
    if (node.node_type === 'root') throw controlError('请取消整个 Run，而不是单独取消 Root', 'root_cancel_requires_run', 409);
    const data = requestNodeCancellationInTransaction({
      run,
      node,
      actor: 'user',
      reason: input.reason,
      requestId: input.request_id,
      source: 'cancelled',
    });
    return { ok: true, data: { ...data, requested_by_user_id: userId } };
  });
  return transaction.immediate();
}

export function waiveHarnessNodeByUser(userId: string, runId: string, nodeId: string, raw: unknown): HarnessControlResult {
  const input = parseHarnessControlAction(raw);
  const transaction = db.transaction(() => {
    const replay = requestReplay(runId, input.request_id);
    if (replay) return replay;
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(runId) as AnyRow | undefined;
    const node = db.prepare('SELECT * FROM harness_nodes WHERE id=? AND run_id=?').get(nodeId, runId) as AnyRow | undefined;
    if (!run || !node) throw controlError('Harness 节点不存在', 'harness_node_missing', 404);
    if (node.node_type === 'root') throw controlError('Root 节点不能豁免', 'root_waiver_forbidden', 409);
    if (!['failed', 'timed_out', 'interrupted', 'orphaned', 'cancelled'].includes(node.status)) {
      throw controlError(`节点处于 ${node.status}，不能豁免`, 'node_waiver_state_invalid', 409);
    }
    if (node.waived_at) {
      return { ok: true, data: { node_id: node.id, status: node.status, waived: true } };
    }
    let failure: AnyRow = {};
    try { failure = JSON.parse(String(node.failure_json || '{}')); } catch {}
    failure = { ...failure, retryable: false };
    const updated = db.prepare(`UPDATE harness_nodes SET waived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      waived_by_user_id=?, waiver_reason=?, failure_json=?, waiting_reason=NULL, version=version+1
      WHERE id=? AND version=?`).run(userId, input.reason, JSON.stringify(failure), node.id, node.version);
    if (updated.changes !== 1) throw controlError('节点版本冲突，请重试', 'version_conflict', 409);
    const data = { node_id: node.id, status: node.status, waived: true, reason: input.reason };
    appendHarnessEvent({ runId, type: 'node.waived', fromNodeId: node.id,
      requestId: input.request_id, payload: data });
    return { ok: true, data };
  });
  return transaction.immediate();
}

export function cancelHarnessRunByUser(userId: string, runId: string, raw: unknown): HarnessControlResult {
  const input = parseHarnessControlAction(raw);
  const transaction = db.transaction(() => {
    const replay = requestReplay(runId, input.request_id);
    if (replay) return replay;
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(runId) as AnyRow | undefined;
    if (!run) throw controlError('Harness Run 不存在', 'harness_run_missing', 404);
    if (['completed', 'cancelled'].includes(run.status)) {
      throw controlError(`Run 已处于终态 ${run.status}`, 'run_terminal', 409);
    }
    const transition = evaluateRunTransition({ from: run.status, to: 'cancelling', actor: 'user' });
    if (!transition.accepted) throw controlError(transition.reason, transition.code, 409);
    const updated = db.prepare(`UPDATE harness_runs SET status='cancelling', failure_json=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=? AND version=?`)
      .run(JSON.stringify({ category: 'cancelled', reason: input.reason, requested_by_user_id: userId }), run.id, run.version);
    if (updated.changes !== 1) throw controlError('Run 版本冲突，请重试', 'version_conflict', 409);
    const cancellingRun = { ...run, status: 'cancelling' };
    const nodes = db.prepare(`SELECT * FROM harness_nodes WHERE run_id=?
      ORDER BY CASE WHEN node_type='root' THEN 1 ELSE 0 END, created_at`).all(runId) as AnyRow[];
    for (const node of nodes) {
      if (['succeeded', 'cancelled'].includes(node.status)) continue;
      requestNodeCancellationInTransaction({
        run: cancellingRun,
        node,
        actor: 'cascade',
        reason: input.reason,
        source: 'cancelled',
      });
    }
    const data = { run_id: run.id, status: 'cancelling', reason: input.reason };
    appendHarnessEvent({ runId, type: 'run.cancellation_requested', requestId: input.request_id, payload: data });
    return { ok: true, data };
  });
  return transaction.immediate();
}

export function stopHarnessRunForBudget(runId: string, actualCostUsd: number, limitUsd: number): boolean {
  const transaction = db.transaction(() => {
    const run = db.prepare(`SELECT * FROM harness_runs WHERE id=?
      AND status IN ('planning','running','waiting_input','verifying','synthesizing')`).get(runId) as AnyRow | undefined;
    if (!run) return false;
    const transition = evaluateRunTransition({ from: run.status, to: 'failed', actor: 'system' });
    if (!transition.accepted) return false;
    const reason = `Run 实际成本 ${actualCostUsd.toFixed(6)} USD 已达到硬上限 ${limitUsd.toFixed(6)} USD`;
    const failure = { category: 'budget', reason, actual_cost_usd: actualCostUsd, limit_usd: limitUsd };
    const updated = db.prepare(`UPDATE harness_runs SET status='failed', failure_json=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=? AND version=?`)
      .run(JSON.stringify(failure), run.id, run.version);
    if (updated.changes !== 1) return false;
    const failedRun = { ...run, status: 'failed' };
    const nodes = db.prepare(`SELECT * FROM harness_nodes WHERE run_id=?
      AND status NOT IN ('succeeded','cancelled') ORDER BY created_at`).all(run.id) as AnyRow[];
    for (const node of nodes) {
      requestNodeCancellationInTransaction({
        run: failedRun,
        node,
        actor: 'cascade',
        reason,
        source: 'budget',
      });
    }
    const costRequestId = `run.cost_hard_limit_reached:${run.id}`;
    if (!db.prepare('SELECT 1 FROM harness_events WHERE run_id=? AND request_id=?').get(run.id, costRequestId)) {
      appendHarnessEvent({ runId: run.id, type: 'run.cost_hard_limit_reached',
        requestId: costRequestId, payload: failure });
    }
    appendHarnessEvent({ runId: run.id, type: 'run.failed', payload: failure });
    return true;
  });
  return transaction.immediate();
}

function cascadeDependencyFailures(): number {
  const rows = db.prepare(`SELECT child.*, run.status AS run_status, dependency.id AS failed_dependency_id
    FROM harness_dependencies edge
    JOIN harness_nodes child ON child.run_id=edge.run_id AND child.id=edge.node_id
    JOIN harness_nodes dependency ON dependency.run_id=edge.run_id AND dependency.id=edge.depends_on_node_id
    JOIN harness_runs run ON run.id=edge.run_id
    WHERE child.status='created'
      AND dependency.status IN ('failed','timed_out','interrupted','orphaned','cancelled')
      AND run.status IN ('planning','running','waiting_input')
    ORDER BY child.created_at`).all() as AnyRow[];
  let cancelled = 0;
  for (const row of rows) {
    const dependency = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(row.failed_dependency_id) as AnyRow;
    if (harnessNodeRetryPending(dependency)) continue;
    const transaction = db.transaction(() => {
      const node = db.prepare("SELECT * FROM harness_nodes WHERE id=? AND status='created'").get(row.id) as AnyRow | undefined;
      const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(row.run_id) as AnyRow;
      if (!node || !run) return false;
      const reason = `依赖节点 ${row.failed_dependency_id} 未成功，当前节点无法执行`;
      requestNodeCancellationInTransaction({ run, node, actor: 'cascade', reason, source: 'dependency' });
      return true;
    });
    if (transaction.immediate()) cancelled += 1;
  }
  return cancelled;
}

function requestStopGroupCancellations(): number {
  const terminal = db.prepare(`SELECT * FROM harness_nodes WHERE node_type!='root'
    AND status IN ('failed','timed_out','interrupted','orphaned') ORDER BY completed_at`).all() as AnyRow[];
  let requested = 0;
  for (const failed of terminal) {
    if (harnessNodeRetryPending(failed)) continue;
    const failedContract = parseJsonColumn(failed.task_contract_json, 'harness_nodes.task_contract_json', parseHarnessTaskContract);
    if (failedContract.schema_version !== '1.2'
      || failedContract.parallelism?.failure_policy !== 'stop_group'
      || !failedContract.parallelism.aggregation_key) continue;
    const candidates = db.prepare(`SELECT * FROM harness_nodes WHERE run_id=? AND id!=? AND node_type!='root'
      AND status IN ('created','queued','starting','running','waiting_input','submitted','verifying')`).all(
      failed.run_id,
      failed.id,
    ) as AnyRow[];
    for (const candidate of candidates) {
      const contract = parseJsonColumn(candidate.task_contract_json, 'harness_nodes.task_contract_json', parseHarnessTaskContract);
      if (contract.schema_version !== '1.2'
        || contract.parallelism?.aggregation_key !== failedContract.parallelism.aggregation_key) continue;
      const transaction = db.transaction(() => {
        const node = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(candidate.id) as AnyRow;
        const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(candidate.run_id) as AnyRow;
        if (!node || !run || !['created','queued','starting','running','waiting_input','submitted','verifying'].includes(node.status)) return false;
        const reason = `同组节点 ${failed.id} 失败，按 stop_group 策略停止聚合组 ${failedContract.parallelism!.aggregation_key}`;
        requestNodeCancellationInTransaction({ run, node, actor: 'cascade', reason, source: 'policy' });
        return true;
      });
      if (transaction.immediate()) requested += 1;
    }
  }
  return requested;
}

export function applyHarnessFailurePolicies(): number {
  return cascadeDependencyFailures() + requestStopGroupCancellations();
}

export async function processHarnessCancellations(registry: HarnessExecutorRegistry): Promise<number> {
  const executor = registry.get('mobius-session');
  if (!executor) throw new Error('Mobius Session Harness Executor 未注册');
  const nodes = db.prepare("SELECT * FROM harness_nodes WHERE status='cancelling' ORDER BY created_at LIMIT 50").all() as AnyRow[];
  let completed = 0;
  for (const node of nodes) {
    const session = db.prepare(`SELECT session_id FROM harness_node_sessions WHERE node_id=? AND status='active'
      ORDER BY generation DESC LIMIT 1`).get(node.id) as AnyRow | undefined;
    if (session?.session_id) {
      try {
        await executor.interrupt(session.session_id);
      } catch (error) {
        appendHarnessEvent({ runId: node.run_id, type: 'node.runtime_interrupt_failed', fromNodeId: node.id,
          payload: { node_id: node.id, session_id: session.session_id, reason: 'cancellation', error: error instanceof Error ? error.message : String(error) } });
        continue;
      }
    }
    const transaction = db.transaction(() => {
      const current = db.prepare("SELECT * FROM harness_nodes WHERE id=? AND status='cancelling'").get(node.id) as AnyRow | undefined;
      if (!current) return false;
      const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(current.run_id) as AnyRow;
      const transition = evaluateNodeTransition({ from: 'cancelling', to: 'cancelled', actor: 'orchestrator' });
      if (!transition.accepted) throw controlError(transition.reason, transition.code, 409);
      db.prepare(`UPDATE harness_nodes SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        version=version+1 WHERE id=? AND status='cancelling'`).run(current.id);
      db.prepare(`UPDATE harness_node_sessions SET status='retired', detached_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE node_id=? AND status='active'`).run(current.id);
      appendHarnessEvent({ runId: run.id, type: 'node.cancelled', fromNodeId: current.id,
        payload: { node_id: current.id, reason: terminalFailureReason(current, 'cancelled') } });
      const stored = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(current.id) as AnyRow;
      let source: CancellationSource = 'cancelled';
      try {
        const category = JSON.parse(String(current.failure_json || '{}')).category;
        if (['dependency', 'policy', 'budget'].includes(category)) source = category;
      } catch {}
      notifyCancelledChild(run, stored, terminalFailureReason(current, 'cancelled'), source);
      return true;
    });
    if (transaction.immediate()) completed += 1;
  }

  const cancellingRuns = db.prepare("SELECT * FROM harness_runs WHERE status='cancelling'").all() as AnyRow[];
  for (const run of cancellingRuns) {
    const pending = db.prepare("SELECT 1 FROM harness_nodes WHERE run_id=? AND status='cancelling' LIMIT 1").get(run.id);
    if (pending) continue;
    const transition = evaluateRunTransition({ from: 'cancelling', to: 'cancelled', actor: 'orchestrator' });
    if (!transition.accepted) continue;
    db.prepare(`UPDATE harness_runs SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=? AND status='cancelling'`).run(run.id);
    appendHarnessEvent({ runId: run.id, type: 'run.cancelled', payload: { run_id: run.id } });
  }
  return completed;
}
