import crypto from 'crypto';
import { db } from '../../db';
import { MAX_HARNESS_AGENTS } from '../types/harness';
import type {
  HarnessInternalTokenPayload,
  HarnessNodeBatchRequestV1,
  HarnessRunPolicyV1,
  HarnessTaskContractV1,
  HarnessTaskContractV1_2,
} from '../types/harness';
import {
  assertNoLethalTrifecta,
  parseHarnessInternalComplete,
  parseHarnessInternalCreateTask,
  parseHarnessInternalCreateNodeBatch,
  parseHarnessInternalFail,
  parseHarnessInternalProgress,
  parseHarnessInternalResultAck,
  parseHarnessMemberSnapshot,
  parseHarnessRecord,
  parseHarnessRunPolicy,
  parseHarnessTaskContract,
  parseJsonColumn,
} from './harness-schema';
import { appendHarnessEvent, getHarnessRunSnapshot } from '../repositories/harness';
import { evaluateNodeTransition, evaluateRunTransition, toNodeTransitionRejectedEvent, type HarnessNodeState } from './harness-state-machine';
import { enqueueRootResultNotification } from './harness-result-notification';
import { finalizePreconditionReasons } from './harness-finalize-gate';
import { assertHarnessDag, harnessNodesHaveDependencyPath } from './harness-dag';
import { adaptiveHarnessSchedulingEnabled, harnessBatchCreateEnabled } from './harness-features';
import { queueReadyHarnessNodesInTransaction } from './harness-dispatcher';
import { getHarnessSchedulingState } from './harness-scheduling';

type AnyRow = Record<string, any>;

export interface HarnessActionResult {
  ok: boolean;
  replayed?: boolean;
  rejected?: { code: string; reason: string; from?: string; to?: string; details?: unknown };
  data?: AnyRow;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function eventForRequest(runId: string, requestId: string): AnyRow | null {
  const row = db.prepare('SELECT * FROM harness_events WHERE run_id = ? AND request_id = ?').get(runId, requestId) as AnyRow | undefined;
  return row ? { ...row, payload: parseJsonColumn(row.payload_json, 'harness_events.payload_json', parseHarnessRecord) } : null;
}

function rejectTransition(runId: string, node: AnyRow, to: HarnessNodeState, actor: any, requestId: string): HarnessActionResult | null {
  const request = { from: node.status as HarnessNodeState, to, actor };
  const result = evaluateNodeTransition(request);
  if (result.accepted) return null;
  const event = toNodeTransitionRejectedEvent(request, result);
  appendHarnessEvent({ runId, type: event.type, fromNodeId: node.id, requestId, payload: event.payload });
  return { ok: false, rejected: { code: result.code, reason: result.reason, from: result.from, to: result.to } };
}

function assertTokenNode(payload: HarnessInternalTokenPayload, runId: string, nodeId?: string): { run: AnyRow; node: AnyRow; member: AnyRow } {
  if (payload.run_id !== runId || (nodeId && payload.node_id !== nodeId)) {
    throw Object.assign(new Error('Scoped token 不能访问其他 Run 或节点'), { status: 403, code: 'harness_scope_violation' });
  }
  const run = db.prepare('SELECT * FROM harness_runs WHERE id = ?').get(runId) as AnyRow | undefined;
  const node = db.prepare('SELECT * FROM harness_nodes WHERE id = ? AND run_id = ?').get(payload.node_id, runId) as AnyRow | undefined;
  const member = db.prepare('SELECT * FROM harness_run_members WHERE id = ? AND run_id = ?').get(payload.member_id, runId) as AnyRow | undefined;
  if (!run || !node || !member || node.assignee_member_id !== member.id) {
    throw Object.assign(new Error('Scoped token 对应的数据库身份已失效'), { status: 403, code: 'harness_identity_invalid' });
  }
  return { run, node, member };
}

function memberToolTags(member: AnyRow): string[] {
  return parseJsonColumn(member.config_snapshot_json, 'harness_run_members.config_snapshot_json', parseHarnessMemberSnapshot).definition.tools.capability_tags;
}

function rootOnly(payload: HarnessInternalTokenPayload, node: AnyRow, member: AnyRow): void {
  if (node.node_type !== 'root' || member.role !== 'main' || payload.role !== 'main') {
    throw Object.assign(new Error('此操作仅允许 root Main'), { status: 403, code: 'root_main_required' });
  }
}

interface PendingNodeInput {
  client_ref: string;
  assignee_member_id: string;
  task_contract: HarnessTaskContractV1;
}

function actionError(message: string, code: string, status = 400): Error {
  return Object.assign(new Error(message), { status, code });
}

function isParallelSafe(contract: HarnessTaskContractV1): contract is HarnessTaskContractV1_2 {
  return contract.schema_version === '1.2' && contract.parallelism?.mode === 'parallel_safe';
}

function scopePrefix(scope: string): string {
  const normalized = scope.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const wildcard = normalized.search(/[?*\[{]/);
  return (wildcard >= 0 ? normalized.slice(0, wildcard) : normalized).replace(/\/+$/, '');
}

function readScopesOverlap(first: string[], second: string[]): boolean {
  return first.some((left) => second.some((right) => {
    const a = scopePrefix(left);
    const b = scopePrefix(right);
    return !a || !b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }));
}

function validateTaskContractForRun(policy: HarnessRunPolicyV1, contract: HarnessTaskContractV1): void {
  if (contract.risk_level !== 'low') {
    throw actionError('Harness 只允许 low risk 的只读 Sub 任务', 'phase1_risk_forbidden');
  }
  if (contract.workspace.mode !== 'read_only') {
    throw actionError('Harness Sub 任务必须使用 read_only workspace', 'parallel_workspace_forbidden');
  }
  const unsupportedDeliverable = contract.deliverables.find((item) => item.required && !['report', 'structured_data'].includes(item.kind));
  if (unsupportedDeliverable) {
    throw actionError(`Harness 不支持必需交付物类型: ${unsupportedDeliverable.kind}`, 'phase1_deliverable_forbidden');
  }
  if (!isParallelSafe(contract)) return;
  if (!adaptiveHarnessSchedulingEnabled()
    || policy.schema_version !== '1.1'
    || !['adaptive', 'fanout'].includes(policy.collaboration_shape)) {
    throw actionError('parallel_safe 只允许用于已启用的 adaptive 或 fanout Run', 'parallel_policy_forbidden');
  }
  if (!contract.parallelism?.reason?.trim()) {
    throw actionError('parallel_safe 必须说明独立性理由', 'parallel_reason_required');
  }
  if (!contract.parallelism?.independence_key?.trim()) {
    throw actionError('parallel_safe 必须提供 independence_key', 'parallel_independence_key_required');
  }
  const readScopes = contract.parallelism?.read_scopes || [];
  if (readScopes.length === 0) {
    throw actionError('parallel_safe 必须提供至少一个有界 read_scope', 'parallel_read_scope_required');
  }
  if (readScopes.some((scope) => {
    const normalized = scope.trim().replace(/\\/g, '/');
    return !normalized || normalized === '*' || normalized === '**' || normalized === '/'
      || normalized === './**' || normalized.includes('../');
  })) {
    throw actionError('parallel_safe 的 read_scopes 必须是有界路径，不能覆盖整个工作区或包含上级目录', 'parallel_read_scope_unbounded');
  }
  if ((contract.parallelism.mutable_resources || []).length > 0) {
    throw actionError('parallel_safe 不能声明可变资源', 'parallel_mutable_resources_forbidden');
  }
  if (!Array.isArray(contract.parallelism.mutable_resources)) {
    throw actionError('parallel_safe 必须显式声明空 mutable_resources', 'parallel_mutable_resources_required');
  }
  if (!Number.isFinite(contract.parallelism.estimated_duration_seconds)) {
    throw actionError('parallel_safe 必须提供 estimated_duration_seconds', 'parallel_duration_required');
  }
  if (!contract.parallelism.failure_policy) {
    throw actionError('parallel_safe 必须提供 failure_policy', 'parallel_failure_policy_required');
  }
  if (contract.parallelism.failure_policy === 'stop_group' && !contract.parallelism.aggregation_key?.trim()) {
    throw actionError('stop_group 必须提供 aggregation_key', 'parallel_aggregation_key_required');
  }
  const mutationTool = (contract.tools.allow || []).find((tool) => /(write|edit|patch|commit|migrat|deploy|credential|service)/i.test(tool));
  if (mutationTool) throw actionError(`parallel_safe 不能启用写入型工具: ${mutationTool}`, 'parallel_write_tool_forbidden');
}

function normalizeTaskContract(assignee: AnyRow, input: HarnessTaskContractV1): HarnessTaskContractV1 {
  const tags = memberToolTags(assignee);
  assertNoLethalTrifecta(tags);
  return {
    ...input,
    workspace: { ...input.workspace, mode: 'read_only' },
    tools: { ...input.tools, capability_tags: tags as any },
    communication: { ...input.communication, parent_only: true },
  };
}

function createTaskNodes(
  payload: HarnessInternalTokenPayload,
  requestId: string,
  requestedNodes: PendingNodeInput[],
  batch: boolean,
): HarnessActionResult {
  const transaction = db.transaction(() => {
    const replay = eventForRequest(payload.run_id, requestId);
    if (replay) return { ok: true, replayed: true, data: replay.payload };
    const { run, node: callerNode, member: callerMember } = assertTokenNode(payload, payload.run_id);
    rootOnly(payload, callerNode, callerMember);
    if (run.execution_mode !== 'multi') throw actionError('单 Harness 模式不能创建 Sub Harness', 'multi_harness_disabled', 403);
    if (batch && !harnessBatchCreateEnabled()) throw actionError('Harness 批量创建功能未启用', 'harness_batch_create_disabled', 404);
    const policy = parseJsonColumn(run.policy_json, 'harness_runs.policy_json', parseHarnessRunPolicy);
    const nodeCount = Number((db.prepare('SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id = ?').get(run.id) as AnyRow).count);
    const maxNodes = Math.min(MAX_HARNESS_AGENTS, Number(policy.max_nodes) || MAX_HARNESS_AGENTS);
    if (nodeCount + requestedNodes.length > maxNodes) throw actionError(`每个 Run 最多 ${maxNodes} 个节点`, 'max_nodes_reached', 409);
    const clientRefs = new Set<string>();
    for (const requested of requestedNodes) {
      if (clientRefs.has(requested.client_ref)) throw actionError(`client_ref 重复: ${requested.client_ref}`, 'duplicate_client_ref');
      clientRefs.add(requested.client_ref);
    }
    const children = db.prepare("SELECT * FROM harness_nodes WHERE run_id = ? AND node_type != 'root' ORDER BY created_at").all(run.id) as AnyRow[];
    const nodeIdByRef = new Map(requestedNodes.map((requested) => [requested.client_ref, id('hn')]));
    const existingIds = new Set(children.map((child) => child.id));
    const prepared = requestedNodes.map((requested, index) => {
      if (!payload.allowed_member_ids.includes(requested.assignee_member_id)) {
        throw actionError('Main 只能向 token 中固化的已选 Member 分派', 'member_not_allowed', 403);
      }
      const assignee = db.prepare('SELECT * FROM harness_run_members WHERE id=? AND run_id=?')
        .get(requested.assignee_member_id, run.id) as AnyRow | undefined;
      if (!assignee) throw actionError('Member 不属于此 Run 的锁定 Roster', 'member_not_in_roster', 403);
      if (assignee.role === 'main') throw actionError('Main 不能通过分派更换 Main 或给 Main 创建 Sub 节点', 'main_reassignment_forbidden', 403);
      const dependencies = requested.task_contract.dependencies.map((dependency) => nodeIdByRef.get(dependency) || dependency);
      for (const dependencyId of dependencies) {
        if (!existingIds.has(dependencyId) && ![...nodeIdByRef.values()].includes(dependencyId)) {
          throw actionError(`依赖节点不属于此 Run: ${dependencyId}`, 'cross_run_dependency');
        }
      }
      const contract = normalizeTaskContract(assignee, { ...requested.task_contract, dependencies });
      validateTaskContractForRun(policy, contract);
      const nodeId = nodeIdByRef.get(requested.client_ref)!;
      if (dependencies.includes(nodeId)) throw actionError(`节点不能依赖自身: ${requested.client_ref}`, 'self_dependency');
      return {
        ...requested,
        node_id: nodeId,
        path: `root/${children.length + index + 1}`,
        assignee,
        contract,
        dependencies,
      };
    });
    if (policy.collaboration_shape === 'pipeline') {
      prepared.forEach((item, index) => {
        const previousId = index === 0 ? children.at(-1)?.id : prepared[index - 1].node_id;
        if (!previousId && item.dependencies.length !== 0) {
          throw actionError('流水线首个 Sub 节点不能依赖尚不存在的节点', 'invalid_pipeline_dependency');
        }
        if (previousId && (item.dependencies.length !== 1 || item.dependencies[0] !== previousId)) {
          throw actionError(`流水线后续节点必须且只能依赖前一节点 ${previousId}`, 'pipeline_dependency_required');
        }
      });
    }
    const existingBudget = children.reduce((sum, child) => {
      const contract = parseJsonColumn(child.task_contract_json, 'harness_nodes.task_contract_json', parseHarnessTaskContract);
      return sum + Number(contract.budget.max_cost_usd || 0);
    }, 0);
    const requestedBudget = prepared.reduce((sum, item) => sum + Number(item.contract.budget.max_cost_usd || 0), 0);
    if (existingBudget + requestedBudget > Number(policy.cost_hard_limit_usd)) {
      throw actionError('Sub Task 预算总额超过 Run cost_hard_limit_usd', 'harness_cost_limit_exceeded', 409);
    }
    for (const item of prepared) {
      const snapshot = parseJsonColumn(item.assignee.config_snapshot_json, 'harness_run_members.config_snapshot_json', parseHarnessMemberSnapshot);
      const nodeType = item.assignee.role === 'evaluator' ? 'evaluator' : 'worker';
      db.prepare(`INSERT INTO harness_nodes
        (id, run_id, parent_node_id, assignee_member_id, path, node_type, risk_level, status, depth, model,
         task_contract_json, context_policy_json, tool_policy_json, workspace_mode, max_attempts)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'created', 1, ?, ?, ?, ?, 'read_only', ?)`)
        .run(item.node_id, run.id, callerNode.id, item.assignee.id, item.path, nodeType, item.contract.risk_level,
          snapshot.definition.model, JSON.stringify(item.contract),
          JSON.stringify({ mode: item.assignee.role, system_skill: item.assignee.role === 'evaluator' ? 'harness-evaluator-agent' : 'harness-sub-agent' }),
          JSON.stringify(item.contract.tools), Math.max(1, Math.min(3, Number(item.contract.budget.max_attempts) || 2)));
    }
    for (const item of prepared) {
      for (const dependencyId of item.dependencies) {
        db.prepare('INSERT INTO harness_dependencies (run_id, node_id, depends_on_node_id) VALUES (?, ?, ?)')
          .run(run.id, item.node_id, dependencyId);
      }
    }
    assertHarnessDag(run.id);
    const allChildren = db.prepare("SELECT * FROM harness_nodes WHERE run_id=? AND node_type!='root'").all(run.id) as AnyRow[];
    for (let left = 0; left < allChildren.length; left += 1) {
      for (let right = left + 1; right < allChildren.length; right += 1) {
        const first = allChildren[left];
        const second = allChildren[right];
        const firstContract = parseJsonColumn(first.task_contract_json, 'harness_nodes.task_contract_json', parseHarnessTaskContract);
        const secondContract = parseJsonColumn(second.task_contract_json, 'harness_nodes.task_contract_json', parseHarnessTaskContract);
        if (!isParallelSafe(firstContract) || !isParallelSafe(secondContract)
          || harnessNodesHaveDependencyPath(run.id, first.id, second.id)) continue;
        if (first.assignee_member_id === second.assignee_member_id) {
          throw actionError('无依赖的 parallel_safe 节点必须分配给不同 Member', 'parallel_member_conflict');
        }
        if (firstContract.parallelism!.independence_key === secondContract.parallelism!.independence_key) {
          throw actionError('无依赖的 parallel_safe 节点必须使用不同 independence_key', 'parallel_independence_key_conflict');
        }
        if (readScopesOverlap(firstContract.parallelism!.read_scopes || [], secondContract.parallelism!.read_scopes || [])) {
          throw actionError('无依赖的 parallel_safe 节点 read_scopes 不能重叠', 'parallel_read_scope_overlap');
        }
      }
    }
    for (const item of prepared) {
      appendHarnessEvent({ runId: run.id, type: 'node.created', fromNodeId: callerNode.id, toNodeId: item.node_id,
        ...(!batch ? { requestId } : {}),
        payload: { node_id: item.node_id, assignee_member_id: item.assignee.id, path: item.path } });
      appendHarnessEvent({ runId: run.id, type: 'member.task_assigned', fromNodeId: callerNode.id, toNodeId: item.node_id,
        payload: { member_id: item.assignee.id, node_id: item.node_id } });
    }
    queueReadyHarnessNodesInTransaction(run.id);
    const dataNodes = prepared.map((item) => {
      const stored = db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(item.node_id) as AnyRow;
      const dispatch = db.prepare("SELECT id FROM harness_dispatches WHERE node_id=? AND kind='start' ORDER BY created_at DESC LIMIT 1")
        .get(item.node_id) as AnyRow | undefined;
      return { client_ref: item.client_ref, node_id: item.node_id, dispatch_id: dispatch?.id || null, queued: stored.status === 'queued' };
    });
    const scheduling = getHarnessSchedulingState(run.id);
    const data = batch ? { nodes: dataNodes, scheduling } : { ...dataNodes[0], scheduling };
    const autoWorkerPool = !!db.prepare(
      "SELECT 1 FROM harness_events WHERE run_id=? AND type='run.roster_auto_enabled' LIMIT 1",
    ).get(run.id);
    if (scheduling.underfilled && autoWorkerPool) {
      const schedulingEventId = appendHarnessEvent({
        runId: run.id,
        type: 'scheduler.wave_underfilled',
        fromNodeId: callerNode.id,
        payload: {
          active_sub_count: scheduling.active_sub_count,
          idle_slots: scheduling.idle_slots,
          available_member_ids: scheduling.available_member_ids,
          recommended_action: scheduling.recommended_action,
        },
      });
      const nudgeDispatchId = id('hd');
      db.prepare(`INSERT INTO harness_dispatches
        (id, run_id, node_id, event_id, kind, status, request_id, receipt_marker)
        VALUES (?, ?, ?, ?, 'followup', 'queued', ?, ?)`)
        .run(
          nudgeDispatchId,
          run.id,
          callerNode.id,
          schedulingEventId,
          `notify-scheduling:${run.id}:${schedulingEventId}`,
          `MOBIUS_HARNESS_DISPATCH[${nudgeDispatchId}]`,
        );
      appendHarnessEvent({
        runId: run.id,
        type: 'scheduler.refill_notification_queued',
        fromNodeId: callerNode.id,
        toNodeId: callerNode.id,
        causationId: schedulingEventId,
        payload: { dispatch_id: nudgeDispatchId, scheduling_event_id: schedulingEventId },
      });
    }
    if (batch) {
      appendHarnessEvent({ runId: run.id, type: 'node.batch_created', fromNodeId: callerNode.id,
        requestId, payload: data });
    }
    return data;
  });
  const result = transaction.immediate();
  return result && typeof result === 'object' && 'ok' in result ? result as HarnessActionResult : { ok: true, data: result };
}

export function createTaskForMember(payload: HarnessInternalTokenPayload, raw: unknown): HarnessActionResult {
  const input = parseHarnessInternalCreateTask(raw);
  return createTaskNodes(payload, input.request_id, [{
    client_ref: 'single-node',
    assignee_member_id: input.assignee_member_id,
    task_contract: input.task_contract,
  }], false);
}

export function createNodeBatch(payload: HarnessInternalTokenPayload, raw: unknown): HarnessActionResult {
  const input: HarnessNodeBatchRequestV1 = parseHarnessInternalCreateNodeBatch(raw);
  return createTaskNodes(payload, input.request_id, input.nodes, true);
}

export function reportHarnessProgress(payload: HarnessInternalTokenPayload, nodeId: string, raw: unknown): HarnessActionResult {
  const input = parseHarnessInternalProgress(raw);
  const transaction = db.transaction(() => {
    const replay = eventForRequest(payload.run_id, input.request_id);
    if (replay) return { ok: true, replayed: true, data: replay.payload };
    const { node } = assertTokenNode(payload, payload.run_id, nodeId);
    if (!['running', 'waiting_input'].includes(node.status)) {
      const rejected = rejectTransition(payload.run_id, node, 'waiting_input', 'agent', input.request_id);
      return rejected || { ok: false, rejected: { code: 'progress_state_invalid', reason: `节点处于 ${node.status}，不能上报进度` } };
    }
    const touched = db.prepare(`UPDATE harness_nodes SET heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      version=version+1 WHERE id=? AND version=? AND status IN ('running','waiting_input')`).run(node.id, node.version);
    if (touched.changes !== 1) {
      throw Object.assign(new Error('节点版本冲突，请读取最新状态后重试'), { status: 409, code: 'version_conflict' });
    }
    const eventPayload = { message: input.message, percent: input.percent ?? null, detail: input.detail || null };
    appendHarnessEvent({ runId: payload.run_id, type: 'node.progress', fromNodeId: node.id, requestId: input.request_id, payload: eventPayload });
    return { ok: true, data: eventPayload };
  });
  return transaction.immediate();
}

export function completeHarnessNode(payload: HarnessInternalTokenPayload, nodeId: string, raw: unknown): HarnessActionResult {
  const input = parseHarnessInternalComplete(raw);
  const transaction = db.transaction(() => {
    const replay = eventForRequest(payload.run_id, input.request_id);
    if (replay) return { ok: true, replayed: true, data: replay.payload };
    const { run, node } = assertTokenNode(payload, payload.run_id, nodeId);
    if (node.node_type === 'root') {
      const reasons = finalizePreconditionReasons(run, node, input.result);
      if (reasons.length > 0) {
        return {
          ok: false,
          rejected: {
            code: 'finalize_not_ready',
            reason: 'Root Finalize 前置条件暂未满足；补齐条件后使用新的 request_id 重试',
            details: { reasons, retryable: true, request_id_recorded: false },
          },
        };
      }
    }
    const rejected = rejectTransition(payload.run_id, node, 'submitted', 'agent', input.request_id);
    if (rejected) return rejected;
    const updated = db.prepare("UPDATE harness_nodes SET status='submitted', result_json=?, submitted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=? AND version=?")
      .run(JSON.stringify(input.result), node.id, node.version);
    if (updated.changes !== 1) throw Object.assign(new Error('节点版本冲突，请读取最新状态后重试'), { status: 409, code: 'version_conflict' });
    const data = { node_id: node.id, status: 'submitted' };
    appendHarnessEvent({ runId: payload.run_id, type: 'node.submitted', fromNodeId: node.id, requestId: input.request_id, payload: data });
    return { ok: true, data };
  });
  return transaction.immediate();
}

export function failHarnessNode(payload: HarnessInternalTokenPayload, nodeId: string, raw: unknown): HarnessActionResult {
  const input = parseHarnessInternalFail(raw);
  const transaction = db.transaction(() => {
    const replay = eventForRequest(payload.run_id, input.request_id);
    if (replay) return { ok: true, replayed: true, data: replay.payload };
    const { run, node } = assertTokenNode(payload, payload.run_id, nodeId);
    const rejected = rejectTransition(payload.run_id, node, 'failed', 'agent', input.request_id);
    if (rejected) return rejected;
    const retryable = node.node_type !== 'root' && input.retryable === true
      && Number(node.attempt) < Number(node.max_attempts);
    const failure = { reason: input.reason, category: input.category || 'business', retryable };
    const updated = db.prepare("UPDATE harness_nodes SET status='failed', failure_json=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=? AND version=?")
      .run(JSON.stringify(failure), node.id, node.version);
    if (updated.changes !== 1) throw Object.assign(new Error('节点版本冲突，请读取最新状态后重试'), { status: 409, code: 'version_conflict' });
    appendHarnessEvent({ runId: payload.run_id, type: 'node.failed', fromNodeId: node.id, requestId: input.request_id, payload: { node_id: node.id, failure } });
    if (node.node_type === 'root') {
      const transition = evaluateRunTransition({ from: run.status, to: 'failed', actor: 'system' });
      if (transition.accepted) {
        db.prepare("UPDATE harness_runs SET status='failed', failure_json=?, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?")
          .run(JSON.stringify(failure), run.id, run.version);
        appendHarnessEvent({ runId: run.id, type: 'run.failed', fromNodeId: node.id, payload: failure });
      }
    } else if (!retryable) {
      enqueueRootResultNotification({
        run,
        childNode: node,
        outcome: 'failed',
        result: null,
        failureSource: 'agent_reported',
        reasons: [{
          code: 'agent_reported_failure',
          message: input.reason,
          category: input.category || 'business',
          retryable,
        }],
      });
    }
    return {
      ok: true,
      data: {
        node_id: node.id,
        status: 'failed',
        retry_pending: retryable,
      },
    };
  });
  return transaction.immediate();
}

export function acknowledgeHarnessResultEvent(
  payload: HarnessInternalTokenPayload,
  runId: string,
  eventId: string,
  raw: unknown,
): HarnessActionResult {
  const input = parseHarnessInternalResultAck(raw);
  const transaction = db.transaction(() => {
    const { node: rootNode, member } = assertTokenNode(payload, runId);
    rootOnly(payload, rootNode, member);

    const requestEvent = db.prepare(
      'SELECT * FROM harness_events WHERE run_id=? AND request_id=?',
    ).get(runId, input.request_id) as AnyRow | undefined;
    if (requestEvent) {
      if (requestEvent.type !== 'member.task_result_acknowledged') {
        throw Object.assign(new Error('request_id 已用于其他 Harness 操作'), {
          status: 409,
          code: 'request_id_conflict',
        });
      }
      return {
        ok: true,
        replayed: true,
        data: parseJsonColumn(
          requestEvent.payload_json,
          'harness_events.payload_json',
          parseHarnessRecord,
        ),
      };
    }

    const resultEvent = db.prepare(
      'SELECT * FROM harness_events WHERE run_id=? AND event_id=?',
    ).get(runId, eventId) as AnyRow | undefined;
    if (!resultEvent) {
      throw Object.assign(new Error('结果事件不属于此 Run 或不存在'), {
        status: 404,
        code: 'result_event_not_found',
      });
    }
    if (!['member.task_completed', 'member.task_failed'].includes(resultEvent.type)) {
      throw Object.assign(new Error('只能 ACK member task 终态结果事件'), {
        status: 400,
        code: 'result_event_type_invalid',
      });
    }
    if (resultEvent.to_node_id !== rootNode.id) {
      throw Object.assign(new Error('结果事件未定向到当前 root Main'), {
        status: 403,
        code: 'result_event_target_invalid',
      });
    }
    if (input.last_seen_seq < Number(resultEvent.seq)) {
      throw Object.assign(new Error(`last_seen_seq 不能小于结果事件 seq ${resultEvent.seq}`), {
        status: 400,
        code: 'last_seen_seq_too_small',
      });
    }
    const childNode = db.prepare(
      "SELECT * FROM harness_nodes WHERE run_id=? AND id=? AND node_type!='root'",
    ).get(runId, resultEvent.from_node_id) as AnyRow | undefined;
    if (!childNode || childNode.id === rootNode.id) {
      throw Object.assign(new Error('结果事件来源不是同 Run 子节点'), {
        status: 400,
        code: 'result_event_child_invalid',
      });
    }

    const existingAck = db.prepare(`SELECT * FROM harness_events
      WHERE run_id=? AND type='member.task_result_acknowledged' AND causation_id=?
      ORDER BY seq LIMIT 1`).get(runId, resultEvent.event_id) as AnyRow | undefined;
    if (existingAck) {
      return {
        ok: true,
        replayed: true,
        data: parseJsonColumn(
          existingAck.payload_json,
          'harness_events.payload_json',
          parseHarnessRecord,
        ),
      };
    }

    const data = {
      child_node_id: childNode.id,
      result_event_id: resultEvent.event_id,
      last_seen_seq: input.last_seen_seq,
    };
    appendHarnessEvent({
      runId,
      type: 'member.task_result_acknowledged',
      fromNodeId: rootNode.id,
      toNodeId: childNode.id,
      causationId: resultEvent.event_id,
      requestId: input.request_id,
      payload: data,
    });
    return { ok: true, data };
  });
  return transaction.immediate();
}

export function internalRunEvents(payload: HarnessInternalTokenPayload, runId: string, afterSeq: number): AnyRow[] {
  assertTokenNode(payload, runId);
  return (db.prepare('SELECT * FROM harness_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200').all(runId, Math.max(0, afterSeq)) as AnyRow[])
    .map((event) => ({ ...event, payload: parseJsonColumn(event.payload_json, 'harness_events.payload_json', parseHarnessRecord) }));
}

export async function waitForInternalRunEvents(
  payload: HarnessInternalTokenPayload,
  runId: string,
  afterSeq: number,
  waitMs: number,
): Promise<AnyRow[]> {
  const boundedWaitMs = Math.min(30_000, Math.max(0, waitMs));
  const initial = internalRunEvents(payload, runId, afterSeq);
  if (initial.length > 0 || boundedWaitMs === 0) return initial;
  const deadline = Date.now() + boundedWaitMs;
  return new Promise((resolve) => {
    const poll = () => {
      const events = internalRunEvents(payload, runId, afterSeq);
      if (events.length > 0 || Date.now() >= deadline) {
        resolve(events);
        return;
      }
      const timer = setTimeout(poll, Math.min(250, deadline - Date.now()));
      timer.unref();
    };
    poll();
  });
}

export function internalRoster(payload: HarnessInternalTokenPayload, runId: string): AnyRow[] {
  const { node, member } = assertTokenNode(payload, runId);
  rootOnly(payload, node, member);
  return (getHarnessRunSnapshot(runId)?.members || []).map((item: AnyRow) => ({
    id: item.id, role: item.role, display_name: item.display_name, member_key: item.config_snapshot.member_key,
    profile_id: item.config_snapshot.profile_id, capabilities: item.config_snapshot.definition.capabilities,
  }));
}
