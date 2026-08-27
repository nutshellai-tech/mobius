import crypto from 'crypto';
import { db } from '../../db';
import { appendHarnessEvent } from '../repositories/harness';
import {
  harnessNodeResultDeliverableReasons,
  parseHarnessNodeResult,
  parseHarnessTaskContract,
  parseJsonColumn,
} from './harness-schema';
import { HarnessExecutorRegistry } from './harness-executor';
import { MobiusSessionHarnessExecutor } from './harness-executor-session';
import {
  claimNextHarnessDispatch,
  deliverClaimedHarnessDispatchBatch,
  nextHarnessNotificationDigestDelayMs,
  queueReadyHarnessNodes,
  reconcileExpiredHarnessDispatch,
} from './harness-dispatcher';
import { enqueueRootResultNotification, structuredVerificationReasons } from './harness-result-notification';
import {
  finalizePreconditionReasons,
  finalizeTerminalVerificationReasons,
} from './harness-finalize-gate';
import { evaluateNodeTransition, evaluateRunTransition } from './harness-state-machine';
import { enforceHarnessCostLimits, enforceHarnessNodeTimeouts } from './harness-runtime-policy';
import { harnessCapacity } from './harness-features';
import { applyHarnessFailurePolicies, processHarnessCancellations } from './harness-control';

type AnyRow = Record<string, any>;

const ACTIVE_RUN_STATES = "'planning','running','waiting_input','verifying','synthesizing','cancelling'";
const owner = `harness-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const registry = new HarnessExecutorRegistry();
registry.register(new MobiusSessionHarnessExecutor());

let scanning = false;
let scanRequested = false;
let timer: NodeJS.Timeout | null = null;
let digestTimer: NodeJS.Timeout | null = null;
let started = false;

function hasHarnessWork(): boolean {
  const activeRuns = Number((db.prepare(`SELECT COUNT(*) AS count FROM harness_runs
    WHERE status IN (${ACTIVE_RUN_STATES})`).get() as AnyRow).count);
  if (activeRuns > 0) return true;
  return Number((db.prepare("SELECT COUNT(*) AS count FROM harness_nodes WHERE status='cancelling'").get() as AnyRow).count) > 0;
}

function enabled(name: string, fallback = true): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function verificationDecision(node: AnyRow): { accepted: boolean; reasons: string[]; result: AnyRow } {
  const contract = parseJsonColumn(node.task_contract_json, 'harness_nodes.task_contract_json', parseHarnessTaskContract);
  const result = parseJsonColumn(node.result_json, 'harness_nodes.result_json', parseHarnessNodeResult);
  const reasons: string[] = [];
  const byCriterion = new Map<string, AnyRow>();
  for (const item of result.acceptance_results) {
    if (byCriterion.has(item.criterion_id)) reasons.push(`验收项重复: ${item.criterion_id}`);
    byCriterion.set(item.criterion_id, item);
  }
  for (const criterion of contract.acceptance_criteria) {
    const item = byCriterion.get(criterion.id);
    if (!item && criterion.required) {
      reasons.push(`缺少必需验收项: ${criterion.id}`);
      continue;
    }
    if (item && criterion.required && Number(item.score) < Number(criterion.threshold ?? 1)) {
      reasons.push(`验收项未达到阈值: ${criterion.id}`);
    }
    if (criterion.check?.expect_artifact_kind) reasons.push(`Phase 1 不支持 Artifact 验收: ${criterion.id}`);
  }
  const known = new Set(contract.acceptance_criteria.map((criterion) => criterion.id));
  for (const criterionId of byCriterion.keys()) {
    if (!known.has(criterionId)) reasons.push(`结果包含合同外验收项: ${criterionId}`);
  }
  if (result.status !== 'succeeded') reasons.push(`节点自报结果不是 succeeded: ${result.status}`);
  if (result.unresolved.length > 0) reasons.push('节点仍有未解决事项');
  if (result.artifact_ids.length > 0 || result.acceptance_results.some((item) => item.evidence_artifact_ids.length > 0)) {
    reasons.push('Phase 1 不接受未注册的 Artifact 引用');
  }
  reasons.push(...harnessNodeResultDeliverableReasons(result, contract));
  const unsupportedDeliverable = contract.deliverables.find((item) => item.required && !['report', 'structured_data'].includes(item.kind));
  if (unsupportedDeliverable) reasons.push(`Phase 1 不支持必需交付物类型: ${unsupportedDeliverable.kind}`);
  if (contract.risk_level !== 'low') reasons.push('Phase 1 只验证 low risk 只读节点');
  return { accepted: reasons.length === 0, reasons, result };
}

export function verifySubmittedHarnessNode(nodeId: string): void {
  const transaction = db.transaction(() => {
    const node = db.prepare("SELECT * FROM harness_nodes WHERE id=? AND status='submitted'").get(nodeId) as AnyRow | undefined;
    if (!node) return;
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(node.run_id) as AnyRow;
    let decision: ReturnType<typeof verificationDecision>;
    try {
      decision = verificationDecision(node);
    } catch (error) {
      decision = { accepted: false, reasons: [error instanceof Error ? error.message : String(error)], result: null as any };
    }
    const begin = evaluateNodeTransition({ from: 'submitted', to: 'verifying', actor: 'orchestrator' });
    if (!begin.accepted) throw new Error(begin.reason);
    db.prepare("UPDATE harness_nodes SET status='verifying', version=version+1 WHERE id=? AND status='submitted'").run(node.id);
    appendHarnessEvent({ runId: run.id, type: 'node.verifying', fromNodeId: node.id, payload: { node_id: node.id } });

    if (node.node_type === 'root' && decision.accepted) {
      decision.reasons.push(...finalizeTerminalVerificationReasons(run, decision.result));
      decision.accepted = decision.reasons.length === 0;
      if (decision.accepted) {
        const gateReasons = finalizePreconditionReasons(run, node, decision.result);
        if (gateReasons.length > 0) {
          const retry = evaluateNodeTransition({ from: 'verifying', to: 'running', actor: 'orchestrator' });
          if (!retry.accepted) throw new Error(retry.reason);
          const restored = db.prepare(`UPDATE harness_nodes SET status='running', result_json=NULL,
            submitted_at=NULL, completed_at=NULL, failure_json=NULL, version=version+1
            WHERE id=? AND status='verifying'`).run(node.id);
          if (restored.changes !== 1) {
            throw Object.assign(new Error('Finalize 竞态恢复 root 状态时发生版本冲突'), {
              code: 'version_conflict',
            });
          }
          appendHarnessEvent({
            runId: run.id,
            type: 'node.finalize_not_ready',
            fromNodeId: node.id,
            payload: {
              node_id: node.id,
              reasons: gateReasons,
              retryable: true,
              retry_requires_new_request_id: true,
            },
          });
          return;
        }
      }
    }
    const target = decision.accepted ? 'succeeded' : 'failed';
    // Verification failures are deterministic contract failures. Retrying the
    // same submitted payload would only spend another turn without changing
    // the evidence, so they require an explicit user retry after correction.
    const retryable = false;
    const finish = evaluateNodeTransition({ from: 'verifying', to: target, actor: 'orchestrator' });
    if (!finish.accepted) throw new Error(finish.reason);
    db.prepare(`UPDATE harness_nodes SET status=?, failure_json=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      version=version+1 WHERE id=? AND status='verifying'`)
      .run(target, decision.accepted ? null : JSON.stringify({
        category: 'verification',
        reasons: decision.reasons,
        retryable,
      }), node.id);
    appendHarnessEvent({ runId: run.id, type: decision.accepted ? 'node.succeeded' : 'node.failed', fromNodeId: node.id,
      payload: { node_id: node.id, verification: { accepted: decision.accepted, reasons: decision.reasons } } });

    if (node.node_type !== 'root' && !retryable) {
      enqueueRootResultNotification({
        run,
        childNode: node,
        outcome: decision.accepted ? 'completed' : 'failed',
        result: decision.result,
        failureSource: decision.accepted ? undefined : 'verification',
        reasons: decision.accepted ? [] : structuredVerificationReasons(decision.reasons),
      });
      return;
    }
    if (retryable) return;
    if (!decision.accepted) {
      const failRun = evaluateRunTransition({ from: run.status, to: 'failed', actor: 'system' });
      if (failRun.accepted) {
        db.prepare(`UPDATE harness_runs SET status='failed', failure_json=?, version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`)
          .run(JSON.stringify({ category: 'verification', reasons: decision.reasons }), run.id, run.version);
        appendHarnessEvent({ runId: run.id, type: 'run.failed', fromNodeId: node.id, payload: { reasons: decision.reasons } });
      }
      return;
    }
    const toVerifying = evaluateRunTransition({ from: run.status, to: 'verifying', actor: 'orchestrator' });
    if (!toVerifying.accepted) throw new Error(toVerifying.reason);
    const toSynthesizing = evaluateRunTransition({ from: 'verifying', to: 'synthesizing', actor: 'orchestrator' });
    const toCompleted = evaluateRunTransition({ from: 'synthesizing', to: 'completed', actor: 'orchestrator' });
    if (!toSynthesizing.accepted || !toCompleted.accepted) throw new Error('Run finalize 状态机拒绝合法转换');
    const verifyingUpdate = db.prepare(`UPDATE harness_runs SET status='verifying', version=version+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`).run(run.id, run.version);
    if (verifyingUpdate.changes !== 1) throw Object.assign(new Error('Run finalize 进入 verifying 时发生版本冲突'), { code: 'version_conflict' });
    appendHarnessEvent({ runId: run.id, type: 'run.verifying', fromNodeId: node.id, payload: {} });
    const synthesizingUpdate = db.prepare(`UPDATE harness_runs SET status='synthesizing', version=version+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`).run(run.id, run.version + 1);
    if (synthesizingUpdate.changes !== 1) throw Object.assign(new Error('Run finalize 进入 synthesizing 时发生版本冲突'), { code: 'version_conflict' });
    appendHarnessEvent({ runId: run.id, type: 'run.synthesizing', fromNodeId: node.id, payload: {} });
    const completedUpdate = db.prepare(`UPDATE harness_runs SET status='completed', final_result_json=?,
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      version=version+1 WHERE id=? AND version=?`).run(JSON.stringify(decision.result), run.id, run.version + 2);
    if (completedUpdate.changes !== 1) throw Object.assign(new Error('Run finalize 进入 completed 时发生版本冲突'), { code: 'version_conflict' });
    appendHarnessEvent({ runId: run.id, type: 'run.completed', fromNodeId: node.id, payload: { final_result: decision.result } });
  });
  transaction.immediate();
  const runId = (db.prepare('SELECT run_id FROM harness_nodes WHERE id=?').get(nodeId) as AnyRow | undefined)?.run_id;
  if (runId) queueReadyHarnessNodes(runId);
}

async function recoverExpiredDispatches(): Promise<void> {
  const rows = db.prepare(`SELECT * FROM harness_dispatches
    WHERE status IN ('leased','dispatching') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    ORDER BY created_at LIMIT 20`).all(new Date().toISOString()) as AnyRow[];
  for (const row of rows) await reconcileExpiredHarnessDispatch(row, registry);
}

export async function runHarnessScanOnce(): Promise<{ active: boolean }> {
  const active = hasHarnessWork();
  if (!active || !enabled('HARNESS_ORCHESTRATOR_ENABLED')) return { active };
  await recoverExpiredDispatches();
  await enforceHarnessNodeTimeouts(registry);
  enforceHarnessCostLimits();
  applyHarnessFailurePolicies();
  await processHarnessCancellations(registry);
  if (enabled('HARNESS_VERIFICATION_ENABLED')) {
    const submitted = db.prepare("SELECT id FROM harness_nodes WHERE status='submitted' ORDER BY submitted_at LIMIT 20").all() as AnyRow[];
    for (const node of submitted) verifySubmittedHarnessNode(node.id);
  }
  const runs = db.prepare(`SELECT id FROM harness_runs WHERE status IN (${ACTIVE_RUN_STATES}) ORDER BY updated_at`).all() as AnyRow[];
  for (const run of runs) queueReadyHarnessNodes(run.id);
  if (enabled('HARNESS_DISPATCH_ENABLED')) {
    const dispatchBatchSize = harnessCapacity(
      'HARNESS_DISPATCH_BATCH_SIZE',
      harnessCapacity('HARNESS_MAX_PARALLEL_SUBS', 4),
      16,
    );
    const claims: Array<NonNullable<ReturnType<typeof claimNextHarnessDispatch>>> = [];
    for (let index = 0; index < dispatchBatchSize; index += 1) {
      const claim = claimNextHarnessDispatch(owner);
      if (!claim) break;
      claims.push(claim);
    }
    await deliverClaimedHarnessDispatchBatch(claims, registry);
    const digestDelay = nextHarnessNotificationDigestDelayMs();
    if (digestTimer) clearTimeout(digestTimer);
    digestTimer = digestDelay === null ? null : setTimeout(() => {
      digestTimer = null;
      requestHarnessScan();
    }, Math.max(1, digestDelay));
    digestTimer?.unref();
  }
  return { active: true };
}

async function scan(): Promise<void> {
  if (scanning) {
    scanRequested = true;
    return;
  }
  scanning = true;
  try {
    do {
      scanRequested = false;
      await runHarnessScanOnce();
    } while (scanRequested);
  } catch (error) {
    console.error('[harness-orchestrator] scan failed:', error);
  } finally {
    scanning = false;
  }
}

function schedule(): void {
  if (!started) return;
  const active = hasHarnessWork();
  timer = setTimeout(async () => {
    await scan();
    schedule();
  }, active ? 2_000 : 10_000);
  timer.unref();
}

export function requestHarnessScan(): void {
  if (!enabled('HARNESS_ORCHESTRATOR_ENABLED')) return;
  scanRequested = true;
  const immediate = setImmediate(() => { void scan(); });
  immediate.unref();
}

export function startHarnessOrchestrator(): void {
  if (started || !enabled('HARNESS_ORCHESTRATOR_ENABLED')) return;
  started = true;
  requestHarnessScan();
  schedule();
}

export function stopHarnessOrchestrator(): void {
  started = false;
  if (timer) clearTimeout(timer);
  if (digestTimer) clearTimeout(digestTimer);
  timer = null;
  digestTimer = null;
}

export function harnessExecutorRegistry(): HarnessExecutorRegistry {
  return registry;
}
