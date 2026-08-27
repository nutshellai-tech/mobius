import { db } from '../../db';
import { appendHarnessEvent } from '../repositories/harness';
import type { HarnessExecutorRegistry } from './harness-executor';
import { enqueueRootResultNotification } from './harness-result-notification';
import { parseHarnessRunPolicy, parseHarnessTaskContract, parseJsonColumn } from './harness-schema';
import { evaluateNodeTransition, evaluateRunTransition } from './harness-state-machine';
import { stopHarnessRunForBudget } from './harness-control';

type AnyRow = Record<string, any>;

function executorFor(registry: HarnessExecutorRegistry) {
  const executor = registry.get('mobius-session');
  if (!executor) throw new Error('Mobius Session Harness Executor 未注册');
  return executor;
}

function activeSessionId(nodeId: string): string | null {
  const row = db.prepare(`SELECT session_id FROM harness_node_sessions
    WHERE node_id=? AND status='active' ORDER BY generation DESC LIMIT 1`).get(nodeId) as AnyRow | undefined;
  return row?.session_id || null;
}

function timeoutSeconds(node: AnyRow): number {
  const contract = parseJsonColumn(
    node.task_contract_json,
    'harness_nodes.task_contract_json',
    parseHarnessTaskContract,
  );
  return Math.max(30, Math.min(86_400, Number(contract.budget.timeout_seconds) || 1_800));
}

function markNodeTimedOut(nodeId: string, now: Date): AnyRow | null {
  const transaction = db.transaction(() => {
    const node = db.prepare(`SELECT * FROM harness_nodes WHERE id=?
      AND status IN ('running','waiting_input')`).get(nodeId) as AnyRow | undefined;
    if (!node) return null;
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(node.run_id) as AnyRow;
    const target = node.status === 'running' ? 'timed_out' : 'failed';
    const retryable = node.node_type !== 'root' && Number(node.attempt) < Number(node.max_attempts);
    const transition = evaluateNodeTransition({ from: node.status, to: target, actor: 'timeout' });
    if (!transition.accepted) throw Object.assign(new Error(transition.reason), { code: transition.code });
    const failure = {
      category: 'timeout',
      reason: `节点超过 Task Contract timeout_seconds=${timeoutSeconds(node)}`,
      retryable,
      timed_out_at: now.toISOString(),
    };
    const updated = db.prepare(`UPDATE harness_nodes SET status=?, failure_json=?, completed_at=?,
      lease_owner=NULL, lease_expires_at=NULL, waiting_reason=NULL, version=version+1
      WHERE id=? AND version=? AND status=?`).run(
      target,
      JSON.stringify(failure),
      now.toISOString(),
      node.id,
      node.version,
      node.status,
    );
    if (updated.changes !== 1) return null;
    appendHarnessEvent({
      runId: run.id,
      type: 'node.timed_out',
      fromNodeId: node.id,
      payload: { node_id: node.id, previous_status: node.status, ...failure },
    });
    db.prepare(`UPDATE harness_dispatches SET status='cancelled', last_error='node timed out',
      lease_owner=NULL, lease_expires_at=NULL
      WHERE node_id=? AND status IN ('queued','leased','dispatching')`).run(node.id);

    const storedNode = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(node.id) as AnyRow;
    if (node.node_type === 'root') {
      const runTransition = evaluateRunTransition({ from: run.status, to: 'failed', actor: 'system' });
      if (runTransition.accepted) {
        db.prepare(`UPDATE harness_runs SET status='failed', failure_json=?, updated_at=?, version=version+1
          WHERE id=? AND version=?`).run(JSON.stringify(failure), now.toISOString(), run.id, run.version);
        appendHarnessEvent({ runId: run.id, type: 'run.failed', fromNodeId: node.id, payload: failure });
      }
    } else if (!retryable) {
      enqueueRootResultNotification({
        run,
        childNode: storedNode,
        outcome: 'failed',
        result: null,
        failureSource: 'timeout',
        reasons: [{ code: 'node_timeout', message: failure.reason, category: 'timeout', retryable: false }],
      });
    }
    return storedNode;
  });
  return transaction.immediate();
}

async function interruptNode(registry: HarnessExecutorRegistry, node: AnyRow): Promise<boolean> {
  const sessionId = activeSessionId(node.id);
  if (!sessionId) return true;
  try {
    await executorFor(registry).interrupt(sessionId);
    appendHarnessEvent({
      runId: node.run_id,
      type: 'node.runtime_interrupted',
      fromNodeId: node.id,
      payload: { node_id: node.id, session_id: sessionId, reason: 'timeout' },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendHarnessEvent({
      runId: node.run_id,
      type: 'node.runtime_interrupt_failed',
      fromNodeId: node.id,
      payload: { node_id: node.id, session_id: sessionId, reason: 'timeout', error: message },
    });
    return false;
  }
}

function stopUnsafeTimeoutRetry(nodeId: string): void {
  const transaction = db.transaction(() => {
    const node = db.prepare("SELECT * FROM harness_nodes WHERE id=? AND status IN ('timed_out','failed')")
      .get(nodeId) as AnyRow | undefined;
    if (!node || node.node_type === 'root') return;
    let failure: AnyRow = {};
    try { failure = JSON.parse(String(node.failure_json || '{}')); } catch {}
    if (failure.retryable !== true) return;
    failure = {
      ...failure,
      retryable: false,
      cleanup_failed: true,
      reason: `${String(failure.reason || '节点超时')}；运行时中断失败，为避免重复执行已停止自动重试`,
    };
    db.prepare('UPDATE harness_nodes SET failure_json=?, version=version+1 WHERE id=?')
      .run(JSON.stringify(failure), node.id);
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(node.run_id) as AnyRow;
    const stored = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(node.id) as AnyRow;
    enqueueRootResultNotification({
      run,
      childNode: stored,
      outcome: 'failed',
      result: null,
      failureSource: 'timeout',
      reasons: [{ code: 'timeout_interrupt_failed', message: failure.reason, category: 'timeout', retryable: false }],
    });
  });
  transaction.immediate();
}

export async function enforceHarnessNodeTimeouts(registry: HarnessExecutorRegistry): Promise<number> {
  const now = new Date();
  const candidates = db.prepare(`SELECT * FROM harness_nodes
    WHERE status IN ('running','waiting_input') AND started_at IS NOT NULL
    ORDER BY started_at LIMIT 50`).all() as AnyRow[];
  let timedOut = 0;
  for (const candidate of candidates) {
    const startedAt = Date.parse(String(candidate.started_at));
    if (!Number.isFinite(startedAt) || startedAt + timeoutSeconds(candidate) * 1_000 > now.getTime()) continue;
    const node = markNodeTimedOut(candidate.id, now);
    if (!node) continue;
    timedOut += 1;
    if (!(await interruptNode(registry, node))) stopUnsafeTimeoutRetry(node.id);
  }
  return timedOut;
}

function actualRunCostUsd(runId: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(COALESCE(s.total_cost_usd, 0)), 0) AS total
    FROM harness_node_sessions hns
    JOIN harness_nodes n ON n.id=hns.node_id
    JOIN sessions_v2 s ON s.session_id=hns.session_id
    WHERE n.run_id=?`).get(runId) as AnyRow;
  return Number(row?.total) || 0;
}

function appendCostEventOnce(runId: string, type: string, payload: AnyRow): void {
  const requestId = `${type}:${runId}`;
  if (db.prepare('SELECT 1 FROM harness_events WHERE run_id=? AND request_id=?').get(runId, requestId)) return;
  appendHarnessEvent({ runId, type, requestId, payload });
}

export function enforceHarnessCostLimits(): number {
  const runs = db.prepare(`SELECT * FROM harness_runs
    WHERE status IN ('planning','running','waiting_input','verifying','synthesizing')`).all() as AnyRow[];
  let stopped = 0;
  for (const run of runs) {
    const policy = parseJsonColumn(run.policy_json, 'harness_runs.policy_json', parseHarnessRunPolicy);
    const actualCost = actualRunCostUsd(run.id);
    if (actualCost >= Number(policy.cost_soft_limit_usd)) {
      appendCostEventOnce(run.id, 'run.cost_soft_limit_reached', {
        actual_cost_usd: actualCost,
        limit_usd: Number(policy.cost_soft_limit_usd),
      });
    }
    if (actualCost < Number(policy.cost_hard_limit_usd)) continue;
    if (stopHarnessRunForBudget(run.id, actualCost, Number(policy.cost_hard_limit_usd))) stopped += 1;
  }
  return stopped;
}
