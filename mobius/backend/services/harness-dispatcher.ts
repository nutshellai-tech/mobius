import crypto from 'crypto';
import { db } from '../../db';
import { appendHarnessEvent } from '../repositories/harness';
import { buildHarnessContext } from './harness-context';
import { harnessDagCriticalPathSeconds, harnessDagNodeStates, harnessNodeRetryPending } from './harness-dag';
import type { HarnessDispatchOutcome, HarnessDispatchRow, HarnessExecutor } from './harness-executor';
import { HarnessExecutorRegistry } from './harness-executor';
import { adaptiveHarnessSchedulingEnabled, harnessCapacity, harnessNotificationDigestEnabled } from './harness-features';
import {
  buildRootResultNotificationDigestPrompt,
  buildRootResultNotificationPrompt,
  enqueueRootResultNotification,
} from './harness-result-notification';
import { parseHarnessMemberSnapshot, parseHarnessRunPolicy, parseHarnessTaskContract, parseJsonColumn } from './harness-schema';
import { evaluateNodeTransition, evaluateRunTransition } from './harness-state-machine';
import { buildHarnessSchedulingNudgePrompt, getHarnessSchedulingState } from './harness-scheduling';

type AnyRow = Record<string, any>;

const SUB_RESERVED_STATES = ['queued', 'starting', 'running', 'waiting_input', 'submitted', 'verifying'];
const SUB_CLAIMED_STATES = ['starting', 'running', 'waiting_input', 'submitted', 'verifying'];
const NOTIFICATION_DIGEST_WINDOW_MS = 500;
const NOTIFICATION_DIGEST_MAX_EVENTS = 20;

export interface ClaimedHarnessDispatch {
  dispatch: AnyRow;
  run: AnyRow;
  node: AnyRow;
  member: AnyRow;
  notificationDispatches?: AnyRow[];
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function isoAfter(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function dependenciesSucceeded(runId: string, nodeId: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM harness_dependencies d
    JOIN harness_nodes n ON n.run_id=d.run_id AND n.id=d.depends_on_node_id
    WHERE d.run_id=? AND d.node_id=? AND n.status!='succeeded'`).get(runId, nodeId) as AnyRow;
  return Number(row.count) === 0;
}

function placeholders(values: string[]): string {
  return values.map(() => '?').join(',');
}

function runConcurrency(run: AnyRow): number {
  const policy = parseJsonColumn(run.policy_json, 'harness_runs.policy_json', parseHarnessRunPolicy);
  if (!adaptiveHarnessSchedulingEnabled() || policy.schema_version === '1.0') return 1;
  if (policy.collaboration_shape === 'pipeline') return 1;
  return Math.max(1, Math.min(4, Number(policy.max_concurrent_subharnesses) || 1));
}

function nodeContract(node: AnyRow): AnyRow {
  return parseJsonColumn(node.task_contract_json, 'harness_nodes.task_contract_json', parseHarnessTaskContract);
}

function parallelSafe(node: AnyRow): boolean {
  const contract = nodeContract(node);
  return contract.schema_version === '1.2' && contract.parallelism?.mode === 'parallel_safe';
}

function memberBackend(member: AnyRow): string {
  return parseJsonColumn(
    member.config_snapshot_json,
    'harness_run_members.config_snapshot_json',
    parseHarnessMemberSnapshot,
  ).definition.backend;
}

function backendCapacity(backend: string): number {
  if (backend === 'codex') return harnessCapacity('HARNESS_MAX_CODEX_SUBS', 3);
  if (backend === 'claude-code') return harnessCapacity('HARNESS_MAX_CLAUDE_SUBS', 3);
  if (backend === 'deepseek-harness') return harnessCapacity('HARNESS_MAX_DEEPSEEK_SUBS', 2);
  return 1;
}

function countSubs(states: string[], where = '', params: unknown[] = []): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM harness_nodes n
    JOIN harness_runs r ON r.id=n.run_id
    WHERE n.node_type!='root' AND n.status IN (${placeholders(states)}) ${where}`)
    .get(...states, ...params) as AnyRow;
  return Number(row.count);
}

function claimedCapacityAvailable(run: AnyRow, node: AnyRow, member: AnyRow): boolean {
  const activeInRun = countSubs(SUB_CLAIMED_STATES, 'AND n.run_id=? AND n.id!=?', [run.id, node.id]);
  const concurrency = runConcurrency(run);
  if (activeInRun >= concurrency) return false;
  const activeRunNodes = db.prepare(`SELECT * FROM harness_nodes WHERE run_id=? AND node_type!='root'
    AND id!=? AND status IN (${placeholders(SUB_CLAIMED_STATES)})`).all(run.id, node.id, ...SUB_CLAIMED_STATES) as AnyRow[];
  if (activeRunNodes.length > 0 && (!parallelSafe(node) || activeRunNodes.some((active) => !parallelSafe(active)))) return false;
  if (countSubs(SUB_CLAIMED_STATES) >= harnessCapacity('HARNESS_MAX_PARALLEL_SUBS', 4)) return false;
  if (countSubs(SUB_CLAIMED_STATES, 'AND r.owner_user_id=?', [run.owner_user_id])
    >= harnessCapacity('HARNESS_MAX_PARALLEL_SUBS_PER_USER', harnessCapacity('HARNESS_MAX_PARALLEL_SUBS', 4))) return false;
  if (countSubs(SUB_CLAIMED_STATES, 'AND r.project_id=?', [run.project_id])
    >= harnessCapacity('HARNESS_MAX_PARALLEL_SUBS_PER_PROJECT', harnessCapacity('HARNESS_MAX_PARALLEL_SUBS', 4))) return false;
  const backend = memberBackend(member);
  const backendActive = (db.prepare(`SELECT n.*, m.config_snapshot_json FROM harness_nodes n
    JOIN harness_run_members m ON m.id=n.assignee_member_id AND m.run_id=n.run_id
    WHERE n.node_type!='root' AND n.status IN (${placeholders(SUB_CLAIMED_STATES)})`)
    .all(...SUB_CLAIMED_STATES) as AnyRow[]).filter((active) => memberBackend(active) === backend).length;
  return backendActive < backendCapacity(backend);
}

function markResourceBlocked(runId: string, nodeIds: string[], reason: string): void {
  const waitingReason = `resource:${reason}`;
  for (const nodeId of nodeIds) {
    const updated = db.prepare(`UPDATE harness_nodes SET waiting_reason=?, version=version+1
      WHERE id=? AND status IN ('created','failed','timed_out','interrupted')
        AND COALESCE(waiting_reason, '')!=?`)
      .run(waitingReason, nodeId, waitingReason);
    if (updated.changes === 1) {
      appendHarnessEvent({ runId, type: 'node.resource_blocked', fromNodeId: nodeId,
        payload: { node_id: nodeId, reason } });
    }
  }
}

function actualRunCostUsd(runId: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(COALESCE(s.total_cost_usd, 0)), 0) AS total
    FROM harness_node_sessions hns
    JOIN harness_nodes n ON n.id=hns.node_id
    JOIN sessions_v2 s ON s.session_id=hns.session_id
    WHERE n.run_id=?`).get(runId) as AnyRow;
  return Number(row?.total) || 0;
}

function appendRunCostEventOnce(runId: string, type: string, payload: AnyRow): void {
  const requestId = `${type}:${runId}`;
  const existing = db.prepare('SELECT 1 FROM harness_events WHERE run_id=? AND request_id=?').get(runId, requestId);
  if (!existing) appendHarnessEvent({ runId, type, requestId, payload });
}

function executorFor(registry: HarnessExecutorRegistry): HarnessExecutor {
  const executor = registry.get('mobius-session') || registry.list()[0];
  if (!executor) throw Object.assign(new Error('没有可用的 Harness Executor'), { code: 'harness_executor_missing' });
  return executor;
}

function timestampMs(value: unknown): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function queuedNotificationDigest(dispatch: AnyRow): AnyRow[] | null {
  const queued = db.prepare(`SELECT * FROM harness_dispatches
    WHERE run_id=? AND node_id=? AND kind='message' AND status='queued'
    ORDER BY created_at, id LIMIT ?`).all(
    dispatch.run_id,
    dispatch.node_id,
    NOTIFICATION_DIGEST_MAX_EVENTS,
  ) as AnyRow[];
  const firstCreatedAt = timestampMs(queued[0]?.created_at);
  const withinWindow = queued.filter(
    (candidate) => timestampMs(candidate.created_at) - firstCreatedAt <= NOTIFICATION_DIGEST_WINDOW_MS,
  );
  if (
    withinWindow.length < NOTIFICATION_DIGEST_MAX_EVENTS
    && Date.now() - firstCreatedAt < NOTIFICATION_DIGEST_WINDOW_MS
  ) return null;
  return withinWindow;
}

export function nextHarnessNotificationDigestDelayMs(): number | null {
  if (!harnessNotificationDigestEnabled()) return null;
  const first = db.prepare(`SELECT d.* FROM harness_dispatches d
    JOIN harness_nodes n ON n.id=d.node_id AND n.run_id=d.run_id
    JOIN harness_runs r ON r.id=d.run_id
    WHERE d.kind='message' AND d.status='queued' AND n.node_type='root'
      AND n.status IN ('running','waiting_input') AND r.status IN ('running','waiting_input')
    ORDER BY d.created_at, d.id LIMIT 1`).get() as AnyRow | undefined;
  if (!first) return null;
  const digest = db.prepare(`SELECT created_at FROM harness_dispatches
    WHERE run_id=? AND node_id=? AND kind='message' AND status='queued'
    ORDER BY created_at, id LIMIT ?`).all(
    first.run_id,
    first.node_id,
    NOTIFICATION_DIGEST_MAX_EVENTS,
  ) as AnyRow[];
  const firstCreatedAt = timestampMs(first.created_at);
  const withinWindow = digest.filter(
    (candidate) => timestampMs(candidate.created_at) - firstCreatedAt <= NOTIFICATION_DIGEST_WINDOW_MS,
  );
  if (withinWindow.length >= NOTIFICATION_DIGEST_MAX_EVENTS) return 0;
  return Math.max(0, NOTIFICATION_DIGEST_WINDOW_MS - (Date.now() - firstCreatedAt));
}

export function claimNextHarnessDispatch(owner: string): ClaimedHarnessDispatch | null {
  const transaction = db.transaction(() => {
    const candidates = db.prepare(`SELECT d.* FROM harness_dispatches d
      JOIN harness_nodes n ON n.id=d.node_id AND n.run_id=d.run_id
      JOIN harness_runs r ON r.id=d.run_id
      WHERE d.status='queued' AND (
        (d.kind='start' AND n.status='queued' AND r.status IN ('planning','running'))
        OR
        (d.kind IN ('message','followup') AND n.node_type='root'
          AND n.status IN ('running','waiting_input') AND r.status IN ('running','waiting_input'))
      )
      ORDER BY CASE WHEN d.kind IN ('message','followup') THEN 0 ELSE 1 END,
        (SELECT COUNT(*) FROM harness_nodes active
          WHERE active.run_id=r.id AND active.node_type!='root'
            AND active.status IN ('starting','running','waiting_input','submitted','verifying')) ASC,
        n.priority DESC, d.created_at ASC LIMIT 100`).all() as AnyRow[];
    for (const dispatch of candidates) {
      const node = db.prepare('SELECT * FROM harness_nodes WHERE id=? AND run_id=?').get(dispatch.node_id, dispatch.run_id) as AnyRow;
      const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(dispatch.run_id) as AnyRow;
      const member = db.prepare('SELECT * FROM harness_run_members WHERE id=? AND run_id=?').get(node.assignee_member_id, run.id) as AnyRow | undefined;
      if (!member) continue;
      const isMessage = ['message', 'followup'].includes(dispatch.kind);
      if (isMessage) {
        const notificationDispatches = dispatch.kind === 'message' && harnessNotificationDigestEnabled()
          ? queuedNotificationDigest(dispatch)
          : [dispatch];
        if (!notificationDispatches) continue;
        const leasedDispatches: AnyRow[] = [];
        for (const notificationDispatch of notificationDispatches) {
          const dispatchUpdated = db.prepare(`UPDATE harness_dispatches SET status='leased', lease_owner=?,
            lease_expires_at=?, attempt=attempt+1 WHERE id=? AND status='queued'`).run(
            owner,
            isoAfter(60),
            notificationDispatch.id,
          );
          if (dispatchUpdated.changes !== 1) throw new Error('Notification digest claim conflict');
          appendHarnessEvent({ runId: run.id, type: 'dispatch.leased', fromNodeId: node.id,
            payload: { dispatch_id: notificationDispatch.id, lease_owner: owner, kind: notificationDispatch.kind } });
          leasedDispatches.push(
            db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(notificationDispatch.id) as AnyRow,
          );
        }
        return {
          dispatch: leasedDispatches[0],
          run,
          node,
          member,
          notificationDispatches: leasedDispatches.length > 1 ? leasedDispatches : undefined,
        } as ClaimedHarnessDispatch;
      }
      if (!dependenciesSucceeded(run.id, node.id)) continue;
      if (node.node_type !== 'root' && member.role === 'main') {
        db.prepare("UPDATE harness_dispatches SET status='failed', last_error='main-only member cannot run sub node' WHERE id=? AND status='queued'").run(dispatch.id);
        appendHarnessEvent({ runId: run.id, type: 'dispatch.failed', fromNodeId: node.id, payload: { dispatch_id: dispatch.id, code: 'main_only_member' } });
        continue;
      }
      if (node.node_type !== 'root') {
        if (!claimedCapacityAvailable(run, node, member)) continue;
      }
      const transition = evaluateNodeTransition({ from: node.status, to: 'starting', actor: 'orchestrator' });
      if (!transition.accepted) {
        appendHarnessEvent({ runId: run.id, type: 'node.transition_rejected', fromNodeId: node.id,
          payload: { from: node.status, to: 'starting', actor: 'orchestrator', code: transition.code, reason: transition.reason } });
        continue;
      }
      try {
        const nodeUpdated = db.prepare(`UPDATE harness_nodes SET status='starting', attempt=attempt+1,
          lease_owner=?, lease_expires_at=?, version=version+1, started_at=COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          WHERE id=? AND status='queued' AND version=?`).run(owner, isoAfter(60), node.id, node.version);
        if (nodeUpdated.changes !== 1) continue;
      } catch (error: any) {
        if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
          appendHarnessEvent({ runId: run.id, type: 'member.slot_contended', fromNodeId: node.id,
            payload: { member_id: member.id, dispatch_id: dispatch.id } });
          continue;
        }
        throw error;
      }
      const dispatchUpdated = db.prepare(`UPDATE harness_dispatches SET status='leased', lease_owner=?,
        lease_expires_at=?, attempt=attempt+1 WHERE id=? AND status='queued'`).run(owner, isoAfter(60), dispatch.id);
      if (dispatchUpdated.changes !== 1) throw new Error('Dispatch claim version conflict');
      appendHarnessEvent({ runId: run.id, type: 'dispatch.leased', fromNodeId: node.id,
        payload: { dispatch_id: dispatch.id, lease_owner: owner } });
      return {
        dispatch: db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(dispatch.id),
        run,
        node: db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(node.id),
        member,
      } as ClaimedHarnessDispatch;
    }
    return null;
  });
  return transaction.immediate();
}

function finishDelivered(claim: ClaimedHarnessDispatch, executor: HarnessExecutor, sessionId: string, outcome: HarnessDispatchOutcome): void {
  const transaction = db.transaction(() => {
    const dispatch = db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(claim.dispatch.id) as AnyRow;
    const node = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(claim.node.id) as AnyRow;
    if (dispatch.status === 'delivered') return;
    if (!['leased', 'dispatching'].includes(dispatch.status)) throw new Error(`Dispatch ${dispatch.id} 状态已变化: ${dispatch.status}`);
    const evidence = outcome.evidence === 'observed' ? 'observed' : 'inferred';
    db.prepare(`INSERT INTO harness_dispatch_receipts
      (dispatch_id, run_id, node_id, session_id, executor_kind, receipt_marker, evidence, evidence_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dispatch_id) DO NOTHING`)
      .run(dispatch.id, dispatch.run_id, dispatch.node_id, sessionId, executor.kind, dispatch.receipt_marker, evidence, outcome.detail || null);
    db.prepare(`UPDATE harness_dispatches SET status='delivered', target_session_id=?, delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      lease_owner=NULL, lease_expires_at=NULL, last_error=NULL WHERE id=?`).run(sessionId, dispatch.id);
    if (dispatch.kind === 'start' && node.status === 'starting') {
      const transition = evaluateNodeTransition({ from: 'starting', to: 'running', actor: 'lease_holder' });
      if (!transition.accepted) throw new Error(transition.reason);
      db.prepare(`UPDATE harness_nodes SET status='running', lease_owner=NULL, lease_expires_at=NULL,
        heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=? AND status='starting'`).run(node.id);
      appendHarnessEvent({ runId: dispatch.run_id, type: 'node.running', fromNodeId: node.id,
        payload: { node_id: node.id, session_id: sessionId } });
    }
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(dispatch.run_id) as AnyRow;
    if (dispatch.kind === 'start' && node.node_type === 'root' && run.status === 'planning') {
      const runTransition = evaluateRunTransition({ from: 'planning', to: 'running', actor: 'orchestrator' });
      if (!runTransition.accepted) throw new Error(runTransition.reason);
      db.prepare("UPDATE harness_runs SET status='running', version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='planning'").run(run.id);
      appendHarnessEvent({ runId: run.id, type: 'run.running', fromNodeId: node.id, payload: { root_node_id: node.id } });
    }
    appendHarnessEvent({ runId: dispatch.run_id, type: 'dispatch.delivered', fromNodeId: node.id,
      payload: { dispatch_id: dispatch.id, session_id: sessionId, evidence } });
  });
  transaction.immediate();
}

function failDispatch(claim: ClaimedHarnessDispatch, error: unknown, uncertain = false): void {
  const detail = error instanceof Error ? error.message : String(error);
  const failureCategory = uncertain ? 'uncertain_dispatch' : 'backend';
  const transaction = db.transaction(() => {
    const dispatch = db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(claim.dispatch.id) as AnyRow | undefined;
    const node = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(claim.node.id) as AnyRow | undefined;
    if (!dispatch || !node || ['delivered', 'failed', 'uncertain'].includes(dispatch.status)) return;
    const isMessage = ['message', 'followup'].includes(dispatch.kind);
    const canRetryMessage = isMessage && !uncertain && Number(dispatch.attempt) < 3;
    const dispatchStatus = canRetryMessage ? 'queued' : (uncertain ? 'uncertain' : 'failed');
    db.prepare(`UPDATE harness_dispatches SET status=?, last_error=?, lease_owner=NULL, lease_expires_at=NULL WHERE id=?`)
      .run(dispatchStatus, detail, dispatch.id);
    if (dispatch.kind === 'start' && node.status === 'starting') {
      const target = uncertain ? 'orphaned' : 'failed';
      const actor = uncertain ? 'recovery' : 'orchestrator';
      const retryable = !uncertain && node.node_type !== 'root'
        && Number(node.attempt) < Number(node.max_attempts);
      const transition = evaluateNodeTransition({ from: 'starting', to: target, actor });
      if (!transition.accepted) throw new Error(transition.reason);
      db.prepare(`UPDATE harness_nodes SET status=?, failure_json=?, lease_owner=NULL, lease_expires_at=NULL,
        completed_at=CASE WHEN ?='failed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END,
        version=version+1 WHERE id=? AND status='starting'`)
        .run(target, JSON.stringify({ category: failureCategory, reason: detail, retryable }), target, node.id);
      appendHarnessEvent({ runId: dispatch.run_id, type: `node.${target}`, fromNodeId: node.id,
        payload: { node_id: node.id, category: failureCategory, reason: detail } });
      if (node.node_type === 'root') {
        const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(dispatch.run_id) as AnyRow;
        const runTransition = evaluateRunTransition({ from: run.status, to: 'failed', actor: 'system' });
        if (!runTransition.accepted) throw Object.assign(new Error(runTransition.reason), { code: runTransition.code });
        const runUpdated = db.prepare(`UPDATE harness_runs SET status='failed', failure_json=?, version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`)
          .run(JSON.stringify({ category: failureCategory, reason: detail }), run.id, run.version);
        if (runUpdated.changes !== 1) throw Object.assign(new Error('Run 版本冲突，无法记录根节点启动失败'), { code: 'version_conflict' });
        appendHarnessEvent({ runId: run.id, type: 'run.failed', fromNodeId: node.id,
          payload: { category: failureCategory, reason: detail } });
      } else if (!retryable) {
        const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(dispatch.run_id) as AnyRow;
        const terminalNode = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(node.id) as AnyRow;
        enqueueRootResultNotification({
          run,
          childNode: terminalNode,
          outcome: 'failed',
          result: null,
          failureSource: uncertain ? 'recovery' : 'backend',
          reasons: [{
            code: uncertain ? 'dispatch_uncertain' : 'dispatch_failed',
            message: detail,
            category: failureCategory,
            retryable: false,
          }],
        });
      }
    }
    appendHarnessEvent({
      runId: dispatch.run_id,
      type: canRetryMessage ? 'dispatch.retry_queued' : (uncertain ? 'dispatch.uncertain' : 'dispatch.failed'),
      fromNodeId: node.id,
      payload: { dispatch_id: dispatch.id, reason: detail, kind: dispatch.kind, attempt: dispatch.attempt },
    });
    if (isMessage && !canRetryMessage && !uncertain) {
      appendHarnessEvent({
        runId: dispatch.run_id,
        type: 'member.result_notification_failed',
        fromNodeId: node.id,
        causationId: dispatch.event_id,
        payload: { dispatch_id: dispatch.id, result_event_id: dispatch.event_id, attempts: dispatch.attempt },
      });
    }
  });
  transaction.immediate();
}

export async function deliverClaimedHarnessDispatch(claim: ClaimedHarnessDispatch, registry: HarnessExecutorRegistry): Promise<void> {
  const executor = executorFor(registry);
  const notificationDispatches = claim.notificationDispatches || [claim.dispatch];
  const dispatchClaims = notificationDispatches.map((dispatch) => ({ ...claim, dispatch }));
  try {
    const session = await executor.startSession({
      runId: claim.run.id,
      nodeId: claim.node.id,
      memberId: claim.member.id,
      model: claim.node.model,
      workspacePath: claim.node.workspace_path,
    });
    const markDispatching = db.transaction(() => {
      for (const dispatch of notificationDispatches) {
        const updated = db.prepare(`UPDATE harness_dispatches SET status='dispatching', target_session_id=?, lease_expires_at=?
          WHERE id=? AND status='leased' AND lease_owner=?`).run(
          session.sessionId,
          isoAfter(60),
          dispatch.id,
          dispatch.lease_owner,
        );
        if (updated.changes !== 1) throw new Error('Dispatch lease lost before delivery');
        appendHarnessEvent({ runId: claim.run.id, type: 'dispatch.dispatching', fromNodeId: claim.node.id,
          payload: { dispatch_id: dispatch.id, session_id: session.sessionId } });
      }
    });
    markDispatching.immediate();
    const context = buildHarnessContext(claim.node.id);
    let prompt: string;
    if (['message', 'followup'].includes(claim.dispatch.kind)) {
      const events = notificationDispatches.map((dispatch) => {
        const event = db.prepare('SELECT * FROM harness_events WHERE run_id=? AND event_id=?')
          .get(claim.run.id, dispatch.event_id) as AnyRow | undefined;
        if (!event) throw new Error(`Harness 通知事件无效: ${dispatch.event_id}`);
        return event;
      });
      if (events.length === 1 && events[0].type === 'scheduler.wave_underfilled') {
        prompt = buildHarnessSchedulingNudgePrompt({
          runId: claim.run.id,
          eventId: events[0].event_id,
          scheduling: getHarnessSchedulingState(claim.run.id),
        });
      } else if (events.every((event) => ['member.task_completed', 'member.task_failed'].includes(event.type)) && events.length > 1) {
        prompt = buildRootResultNotificationDigestPrompt({
          runId: claim.run.id,
          rootNodeId: claim.node.id,
          notifications: events.map((event) => ({
            childNodeId: event.from_node_id,
            resultEventId: event.event_id,
            resultEventSeq: Number(event.seq),
          })),
        });
      } else if (events.length === 1 && ['member.task_completed', 'member.task_failed'].includes(events[0].type)) {
        const event = events[0];
        prompt = buildRootResultNotificationPrompt({
          runId: claim.run.id,
          childNodeId: event.from_node_id,
          resultEventId: event.event_id,
          resultEventSeq: Number(event.seq),
          outcome: event.type === 'member.task_completed' ? 'completed' : 'failed',
        });
      } else {
        throw new Error(`Harness 通知事件类型无效: ${events.map((event) => event.type).join(',')}`);
      }
    } else {
      prompt = `${context.prompt}\n\nUse MOBIUS_HARNESS_TOKEN from the process environment for all Harness actions. Do not print or expose it.`;
    }
    const outcome = await executor.dispatch({
      kind: claim.dispatch.kind,
      runId: claim.run.id,
      nodeId: claim.node.id,
      sessionId: session.sessionId,
      requestId: claim.dispatch.request_id,
      prompt,
      receiptMarker: notificationDispatches
        .map((dispatch) => dispatch.receipt_marker)
        .join('\nDispatch receipt marker: '),
      scopedToken: context.token,
      causationEventId: claim.dispatch.event_id,
    });
    if (!outcome.delivered || outcome.evidence === 'unknown' || outcome.evidence === 'absent') {
      for (const dispatchClaim of dispatchClaims) {
        failDispatch(
          dispatchClaim,
          outcome.detail || 'Executor could not confirm delivery',
          outcome.evidence === 'unknown',
        );
      }
      return;
    }
    for (const dispatchClaim of dispatchClaims) {
      finishDelivered(dispatchClaim, executor, session.sessionId, outcome);
    }
  } catch (error) {
    for (const dispatchClaim of dispatchClaims) failDispatch(dispatchClaim, error, false);
  }
}

/**
 * Deliver different Harness nodes concurrently while preserving FIFO delivery
 * for multiple messages targeting the same node/session. Claiming happens
 * before delivery, so slow backend startup cannot keep later ready nodes from
 * entering the same scheduling wave.
 */
export async function deliverClaimedHarnessDispatchBatch(
  claims: ClaimedHarnessDispatch[],
  registry: HarnessExecutorRegistry,
): Promise<void> {
  const chains = new Map<string, Promise<void>>();
  for (const claim of claims) {
    const key = String(claim.node.id);
    const previous = chains.get(key) || Promise.resolve();
    chains.set(key, previous.then(() => deliverClaimedHarnessDispatch(claim, registry)));
  }
  const results = await Promise.allSettled([...chains.values()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[harness-dispatcher] concurrent delivery chain failed:', result.reason);
    }
  }
}

export async function reconcileExpiredHarnessDispatch(dispatch: AnyRow, registry: HarnessExecutorRegistry): Promise<void> {
  const executor = executorFor(registry);
  const existingReceipt = db.prepare('SELECT * FROM harness_dispatch_receipts WHERE dispatch_id=?').get(dispatch.id) as AnyRow | undefined;
  let evidence: 'observed' | 'inferred' | 'absent' | 'unknown' = existingReceipt?.evidence || 'unknown';
  if (!existingReceipt && executor.reconcile) {
    evidence = await executor.reconcile({
      id: dispatch.id,
      runId: dispatch.run_id,
      nodeId: dispatch.node_id,
      requestId: dispatch.request_id,
      receiptMarker: dispatch.receipt_marker,
      targetSessionId: dispatch.target_session_id,
    } as HarnessDispatchRow);
  }
  const claim = {
    dispatch,
    run: db.prepare('SELECT * FROM harness_runs WHERE id=?').get(dispatch.run_id),
    node: db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(dispatch.node_id),
    member: db.prepare(`SELECT m.* FROM harness_run_members m JOIN harness_nodes n ON n.assignee_member_id=m.id
      WHERE n.id=? AND m.run_id=?`).get(dispatch.node_id, dispatch.run_id),
  } as ClaimedHarnessDispatch;
  if (evidence === 'observed' || evidence === 'inferred') {
    finishDelivered(claim, executor, dispatch.target_session_id, { delivered: true, evidence, detail: 'recovered from persisted delivery evidence' });
  } else {
    failDispatch(
      claim,
      evidence === 'absent' ? 'Expired dispatch has no persisted marker' : 'Expired dispatch delivery is uncertain',
      evidence !== 'absent',
    );
  }
}

export function queueReadyHarnessNodesInTransaction(runId: string): number {
  const run = db.prepare(`SELECT * FROM harness_runs WHERE id=?
    AND status IN ('planning','running','waiting_input')`).get(runId) as AnyRow | undefined;
  if (!run) return 0;
  const dagStates = harnessDagNodeStates(runId);
  const readyNodeIds = [...dagStates.values()].filter((state) => state.ready).map((state) => state.node_id);
  const policy = parseJsonColumn(run.policy_json, 'harness_runs.policy_json', parseHarnessRunPolicy);
  const actualCost = actualRunCostUsd(runId);
  if (actualCost >= Number(policy.cost_soft_limit_usd)) {
    appendRunCostEventOnce(runId, 'run.cost_soft_limit_reached', {
      actual_cost_usd: actualCost,
      limit_usd: Number(policy.cost_soft_limit_usd),
    });
  }
  if (actualCost >= Number(policy.cost_hard_limit_usd)) {
    markResourceBlocked(runId, readyNodeIds, 'cost_hard_limit');
    appendRunCostEventOnce(runId, 'run.cost_hard_limit_reached', {
      actual_cost_usd: actualCost,
      limit_usd: Number(policy.cost_hard_limit_usd),
    });
    return 0;
  }
  for (const state of dagStates.values()) {
    if (state.failed_dependencies.length === 0) continue;
    const waitingReason = `dependency_failed:${state.failed_dependencies.join(',')}`;
    const updated = db.prepare(`UPDATE harness_nodes SET waiting_reason=?, version=version+1
      WHERE id=? AND status='created' AND COALESCE(waiting_reason, '')!=?`)
      .run(waitingReason, state.node_id, waitingReason);
    if (updated.changes === 1) {
      appendHarnessEvent({
        runId,
        type: 'node.dependency_blocked',
        fromNodeId: state.node_id,
        payload: { node_id: state.node_id, blocked_by: state.failed_dependencies },
      });
    }
  }

  const activeNodes = db.prepare(`SELECT * FROM harness_nodes WHERE run_id=? AND node_type!='root'
    AND status IN (${placeholders(SUB_RESERVED_STATES)})`).all(runId, ...SUB_RESERVED_STATES) as AnyRow[];
  const concurrency = runConcurrency(run);
  let availableRunSlots = concurrency - activeNodes.length;
  if (availableRunSlots <= 0) {
    markResourceBlocked(runId, readyNodeIds, 'run_capacity');
    return 0;
  }
  if (activeNodes.some((node) => !parallelSafe(node))) {
    markResourceBlocked(runId, readyNodeIds, 'serial_task_active');
    return 0;
  }

  let hostSlots = harnessCapacity('HARNESS_MAX_PARALLEL_SUBS', 4) - countSubs(SUB_RESERVED_STATES);
  let userSlots = harnessCapacity('HARNESS_MAX_PARALLEL_SUBS_PER_USER', harnessCapacity('HARNESS_MAX_PARALLEL_SUBS', 4))
    - countSubs(SUB_RESERVED_STATES, 'AND r.owner_user_id=?', [run.owner_user_id]);
  let projectSlots = harnessCapacity('HARNESS_MAX_PARALLEL_SUBS_PER_PROJECT', harnessCapacity('HARNESS_MAX_PARALLEL_SUBS', 4))
    - countSubs(SUB_RESERVED_STATES, 'AND r.project_id=?', [run.project_id]);
  if (hostSlots <= 0 || userSlots <= 0 || projectSlots <= 0) {
    const reason = hostSlots <= 0 ? 'host_capacity' : userSlots <= 0 ? 'user_capacity' : 'project_capacity';
    markResourceBlocked(runId, readyNodeIds, reason);
    return 0;
  }

  const reservedWithMembers = db.prepare(`SELECT n.*, m.config_snapshot_json FROM harness_nodes n
    JOIN harness_run_members m ON m.id=n.assignee_member_id AND m.run_id=n.run_id
    WHERE n.node_type!='root' AND n.status IN (${placeholders(SUB_RESERVED_STATES)})`)
    .all(...SUB_RESERVED_STATES) as AnyRow[];
  const backendCounts = new Map<string, number>();
  for (const node of reservedWithMembers) {
    const backend = memberBackend(node);
    backendCounts.set(backend, (backendCounts.get(backend) || 0) + 1);
  }
  const activeMembers = new Set(activeNodes.map((node) => node.assignee_member_id));
  const criticalPath = harnessDagCriticalPathSeconds(runId);
  const candidates = (db.prepare(`SELECT n.*, m.selection_order, m.config_snapshot_json
    FROM harness_nodes n
    JOIN harness_run_members m ON m.id=n.assignee_member_id AND m.run_id=n.run_id
    WHERE n.run_id=? AND n.status IN ('created','failed','timed_out','interrupted')
    ORDER BY n.priority DESC, n.created_at, m.selection_order`).all(runId) as AnyRow[])
    .filter((node) => node.status === 'created' || harnessNodeRetryPending(node))
    .sort((left, right) => Number(right.priority) - Number(left.priority)
      || Number(criticalPath.get(right.id) || 0) - Number(criticalPath.get(left.id) || 0)
      || String(left.created_at).localeCompare(String(right.created_at))
      || Number(left.selection_order) - Number(right.selection_order));
  let queued = 0;
  for (const node of candidates) {
    if (!dagStates.get(node.id)?.ready) continue;
    if (activeMembers.has(node.assignee_member_id)) {
      markResourceBlocked(runId, [node.id], 'member_capacity');
      continue;
    }
    const isParallel = parallelSafe(node);
    if ((activeNodes.length > 0 || queued > 0) && !isParallel) {
      markResourceBlocked(runId, [node.id], 'serial_task_wait');
      continue;
    }
    const backend = memberBackend(node);
    if ((backendCounts.get(backend) || 0) >= backendCapacity(backend)) {
      markResourceBlocked(runId, [node.id], `backend_capacity:${backend}`);
      continue;
    }
    if (availableRunSlots <= 0 || hostSlots <= 0 || userSlots <= 0 || projectSlots <= 0) {
      const reason = availableRunSlots <= 0 ? 'run_capacity'
        : hostSlots <= 0 ? 'host_capacity'
          : userSlots <= 0 ? 'user_capacity' : 'project_capacity';
      const remainingReady = candidates
        .filter((candidate) => candidate.status === 'created' && dagStates.get(candidate.id)?.ready)
        .map((candidate) => candidate.id);
      markResourceBlocked(runId, remainingReady, reason);
      break;
    }
    const previousStatus = node.status;
    const transition = evaluateNodeTransition({
      from: previousStatus,
      to: 'queued',
      actor: 'orchestrator',
      context: { attempts_exhausted: Number(node.attempt) >= Number(node.max_attempts) },
    });
    if (!transition.accepted) throw new Error(transition.reason);
    try {
      const updated = db.prepare(`UPDATE harness_nodes SET status='queued', waiting_reason=NULL,
        result_json=NULL, failure_json=NULL, started_at=NULL, submitted_at=NULL, completed_at=NULL,
        heartbeat_at=NULL, lease_owner=NULL, lease_expires_at=NULL, version=version+1
        WHERE id=? AND status=?`).run(node.id, previousStatus);
      if (updated.changes !== 1) continue;
    } catch (error: any) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        appendHarnessEvent({ runId, type: 'member.slot_contended', fromNodeId: node.id,
          payload: { member_id: node.assignee_member_id, phase: 'queue' } });
        continue;
      }
      throw error;
    }
    if (previousStatus !== 'created') {
      appendHarnessEvent({ runId, type: 'node.retry_queued', fromNodeId: node.id,
        payload: { node_id: node.id, previous_status: previousStatus, attempt: node.attempt, max_attempts: node.max_attempts } });
    }
    const queuedEvent = appendHarnessEvent({ runId, type: 'node.queued', fromNodeId: node.id,
      payload: { node_id: node.id, path: node.path, retry: previousStatus !== 'created' } });
    const dispatchId = shortId('hd');
    const dispatchRequestId = previousStatus === 'created'
      ? `dispatch:${runId}:${node.id}:start:${node.attempt}`
      : `dispatch:${runId}:${node.id}:retry:${node.attempt}:${dispatchId}`;
    db.prepare(`INSERT INTO harness_dispatches
      (id, run_id, node_id, event_id, kind, status, request_id, receipt_marker)
      VALUES (?, ?, ?, ?, 'start', 'queued', ?, ?)`)
      .run(dispatchId, runId, node.id, queuedEvent, dispatchRequestId, `MOBIUS_HARNESS_DISPATCH[${dispatchId}]`);
    appendHarnessEvent({ runId, type: 'dispatch.queued', fromNodeId: node.id,
      payload: { dispatch_id: dispatchId, kind: 'start' } });
    queued += 1;
    availableRunSlots -= 1;
    hostSlots -= 1;
    userSlots -= 1;
    projectSlots -= 1;
    activeMembers.add(node.assignee_member_id);
    backendCounts.set(backend, (backendCounts.get(backend) || 0) + 1);
    if (!isParallel) break;
  }
  return queued;
}

export function queueReadyHarnessNodes(runId: string): number {
  const transaction = db.transaction(() => queueReadyHarnessNodesInTransaction(runId));
  return transaction.immediate();
}
