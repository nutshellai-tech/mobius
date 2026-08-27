import { db } from '../../db';
import { harnessResultAckRequired } from './harness-features';
import { parseHarnessRunPolicy, parseHarnessTaskContract, parseJsonColumn } from './harness-schema';

type AnyRow = Record<string, any>;

export interface HarnessFinalizePreconditionReason {
  code:
    | 'required_child_not_ready'
    | 'child_result_missing'
    | 'child_result_ack_missing'
    | 'active_sub'
    | 'approval_pending'
    | 'dispatch_pending'
    | 'synthesis_manifest_missing'
    | 'synthesis_result_event_unmapped'
    | 'synthesis_result_event_invalid'
    | 'synthesis_criterion_unmapped'
    | 'synthesis_conflict_unresolved_missing'
    | 'synthesis_coverage_gap_missing'
    | 'evaluator_required';
  message: string;
  child_node_id?: string;
  result_event_id?: string;
  criterion_id?: string;
  approval_id?: string;
  dispatch_id?: string;
  status?: string;
}

function synthesisManifestReasons(
  run: AnyRow,
  rootNode: AnyRow,
  result: AnyRow | undefined,
): HarnessFinalizePreconditionReason[] {
  const reasons: HarnessFinalizePreconditionReason[] = [];
  const manifest = result?.schema_version === '1.2' ? result.synthesis_manifest : null;
  if (!manifest) {
    return [{
      code: 'synthesis_manifest_missing',
      message: 'Root Result 1.2 必须提供完整的 synthesis_manifest',
    }];
  }

  const requiredNodes = db.prepare(
    'SELECT * FROM harness_nodes WHERE run_id=? AND required=1 AND id!=?',
  ).all(run.id, rootNode.id) as AnyRow[];
  const terminalEvents = db.prepare(`SELECT * FROM harness_events
    WHERE run_id=? AND to_node_id=? AND type IN ('member.task_completed','member.task_failed')
    ORDER BY seq`).all(run.id, rootNode.id) as AnyRow[];
  const eventById = new Map(terminalEvents.map((event) => [event.event_id, event]));
  const included = new Set<string>(manifest.included_result_event_ids);
  const excluded = new Map<string, string>();
  for (const item of manifest.excluded_results) {
    if (excluded.has(item.event_id) || !item.reason.trim()) {
      reasons.push({
        code: 'synthesis_result_event_invalid',
        message: `synthesis_manifest 对结果事件 ${item.event_id} 的排除记录重复或缺少有效理由`,
        result_event_id: item.event_id,
      });
    }
    excluded.set(item.event_id, item.reason);
  }
  for (const eventId of included) {
    if (excluded.has(eventId)) {
      reasons.push({
        code: 'synthesis_result_event_invalid',
        message: `结果事件 ${eventId} 不能同时 included 和 excluded`,
        result_event_id: eventId,
      });
    }
  }

  const referencedEventIds = new Set<string>([
    ...included,
    ...excluded.keys(),
    ...manifest.criterion_sources.flatMap((item: AnyRow) => item.source_event_ids),
    ...manifest.conflicts.flatMap((item: AnyRow) => item.source_event_ids),
  ]);
  for (const eventId of referencedEventIds) {
    if (!eventById.has(eventId)) {
      reasons.push({
        code: 'synthesis_result_event_invalid',
        message: `synthesis_manifest 引用了不属于当前 Run root 的终态结果事件 ${eventId}`,
        result_event_id: eventId,
      });
    }
  }

  for (const node of requiredNodes) {
    const resultEvent = terminalEvents.filter((event) => event.from_node_id === node.id).at(-1);
    if (resultEvent && !included.has(resultEvent.event_id) && !excluded.has(resultEvent.event_id)) {
      reasons.push({
        code: 'synthesis_result_event_unmapped',
        message: `必需节点 ${node.id} 的结果事件 ${resultEvent.event_id} 未 included 或带理由 excluded`,
        child_node_id: node.id,
        result_event_id: resultEvent.event_id,
      });
    }
  }

  const rootContract = parseJsonColumn(
    rootNode.task_contract_json,
    'harness_nodes.task_contract_json',
    parseHarnessTaskContract,
  );
  const criterionSources = new Map<string, AnyRow>();
  for (const source of manifest.criterion_sources) {
    if (criterionSources.has(source.criterion_id)) {
      reasons.push({
        code: 'synthesis_criterion_unmapped',
        message: `synthesis_manifest 重复记录 root 验收项 ${source.criterion_id}`,
        criterion_id: source.criterion_id,
      });
    }
    criterionSources.set(source.criterion_id, source);
  }
  const knownCriteria = new Set(rootContract.acceptance_criteria.map((criterion) => criterion.id));
  for (const source of manifest.criterion_sources) {
    if (!knownCriteria.has(source.criterion_id)) {
      reasons.push({
        code: 'synthesis_criterion_unmapped',
        message: `synthesis_manifest 包含合同外 root 验收项 ${source.criterion_id}`,
        criterion_id: source.criterion_id,
      });
    }
  }
  for (const criterion of rootContract.acceptance_criteria) {
    const source = criterionSources.get(criterion.id);
    const deterministic = ['deterministic', 'runtime_check'].includes(criterion.verification)
      && Boolean(criterion.check);
    const directRootWork = requiredNodes.length === 0;
    const validSources = source?.source_event_ids.filter((eventId: string) => included.has(eventId)) || [];
    if (!source || (validSources.length === 0 && !deterministic && !directRootWork)) {
      reasons.push({
        code: 'synthesis_criterion_unmapped',
        message: `Root 验收项 ${criterion.id} 未追溯到 included 结果事件或确定性检查`,
        criterion_id: criterion.id,
      });
    }
  }

  for (const conflict of manifest.conflicts) {
    if (conflict.unresolved && !(result?.unresolved || []).includes(conflict.resolution)) {
      reasons.push({
        code: 'synthesis_conflict_unresolved_missing',
        message: `未解决冲突必须以相同 resolution 写入 root.unresolved: ${conflict.resolution}`,
      });
    }
  }

  const gapNodes = db.prepare(`SELECT id, status FROM harness_nodes
    WHERE run_id=? AND node_type!='root'
      AND status IN ('failed','cancelled','timed_out','interrupted','orphaned')`).all(run.id) as AnyRow[];
  for (const node of gapNodes) {
    const nodeEventIds = terminalEvents
      .filter((event) => event.from_node_id === node.id)
      .map((event) => event.event_id);
    const explicit = manifest.coverage_gaps.some((gap: string) => (
      gap.includes(node.id) || nodeEventIds.some((eventId) => gap.includes(eventId))
    ));
    if (!explicit) {
      reasons.push({
        code: 'synthesis_coverage_gap_missing',
        message: `${node.status} 节点 ${node.id} 造成的覆盖缺口未在 coverage_gaps 中显式记录`,
        child_node_id: node.id,
        status: node.status,
      });
    }
  }
  return reasons;
}

export function finalizePreconditionReasons(
  run: AnyRow,
  rootNode: AnyRow,
  result?: AnyRow,
): HarnessFinalizePreconditionReason[] {
  const reasons: HarnessFinalizePreconditionReason[] = synthesisManifestReasons(run, rootNode, result);
  const policy = parseJsonColumn(run.policy_json, 'harness_runs.policy_json', parseHarnessRunPolicy);
  if (policy.evaluator_policy === 'always') {
    const evaluator = db.prepare(`SELECT id FROM harness_nodes
      WHERE run_id=? AND node_type='evaluator' AND status='succeeded' LIMIT 1`).get(run.id) as AnyRow | undefined;
    if (!evaluator) {
      reasons.push({
        code: 'evaluator_required',
        message: 'Run evaluator_policy=always，但尚无成功的 Evaluator 节点',
      });
    }
  }
  const requiredNodes = db.prepare(
    'SELECT * FROM harness_nodes WHERE run_id=? AND required=1 AND id!=?',
  ).all(run.id, rootNode.id) as AnyRow[];
  for (const node of requiredNodes) {
    const waived = ['failed', 'cancelled', 'timed_out', 'interrupted', 'orphaned'].includes(node.status)
      && node.waived_at
      && node.waiver_reason;
    if (node.status !== 'succeeded' && !waived) {
      reasons.push({
        code: 'required_child_not_ready',
        message: `必需节点 ${node.id} 尚未成功且没有 waiver`,
        child_node_id: node.id,
        status: node.status,
      });
    }
    const resultEvent = db.prepare(`SELECT * FROM harness_events
      WHERE run_id=? AND from_node_id=? AND to_node_id=?
        AND type IN ('member.task_completed','member.task_failed')
      ORDER BY seq DESC LIMIT 1`).get(run.id, node.id, rootNode.id) as AnyRow | undefined;
    if (!resultEvent) {
      reasons.push({
        code: 'child_result_missing',
        message: `必需节点 ${node.id} 缺少定向 root 的终态 member result event`,
        child_node_id: node.id,
      });
      continue;
    }
    if (harnessResultAckRequired()) {
      const ack = db.prepare(`SELECT event_id FROM harness_events
        WHERE run_id=? AND type='member.task_result_acknowledged'
          AND causation_id=? AND from_node_id=? AND to_node_id=?
        LIMIT 1`).get(run.id, resultEvent.event_id, rootNode.id, node.id) as AnyRow | undefined;
      if (!ack) {
        reasons.push({
          code: 'child_result_ack_missing',
          message: `必需节点 ${node.id} 的结果事件 ${resultEvent.event_id} 尚未 ACK`,
          child_node_id: node.id,
          result_event_id: resultEvent.event_id,
        });
      }
    }
  }

  const activeSub = db.prepare(`SELECT id, status FROM harness_nodes
    WHERE run_id=? AND node_type!='root'
      AND status IN ('created','queued','starting','running','waiting_input','submitted','verifying','cancelling')
    ORDER BY created_at LIMIT 1`).get(run.id) as AnyRow | undefined;
  if (activeSub) {
    reasons.push({
      code: 'active_sub',
      message: `Sub 节点 ${activeSub.id} 仍处于活动状态 ${activeSub.status}`,
      child_node_id: activeSub.id,
      status: activeSub.status,
    });
  }

  const approval = db.prepare(
    "SELECT id FROM harness_approvals WHERE run_id=? AND status='pending' LIMIT 1",
  ).get(run.id) as AnyRow | undefined;
  if (approval) {
    reasons.push({
      code: 'approval_pending',
      message: `仍有待审批项 ${approval.id}`,
      approval_id: approval.id,
    });
  }

  const pendingDispatch = db.prepare(`SELECT id, status FROM harness_dispatches
    WHERE run_id=? AND status IN ('queued','leased','dispatching','uncertain')
    ORDER BY created_at LIMIT 1`).get(run.id) as AnyRow | undefined;
  if (pendingDispatch) {
    reasons.push({
      code: 'dispatch_pending',
      message: `Dispatch ${pendingDispatch.id} 仍处于 ${pendingDispatch.status}`,
      dispatch_id: pendingDispatch.id,
      status: pendingDispatch.status,
    });
  }
  return reasons;
}

export function finalizeTerminalVerificationReasons(run: AnyRow, result: AnyRow): string[] {
  const reasons: string[] = [];
  if (result.artifact_ids.length > 0) {
    const placeholders = result.artifact_ids.map(() => '?').join(',');
    const owned = db.prepare(
      `SELECT COUNT(*) AS count FROM harness_artifacts WHERE run_id=? AND id IN (${placeholders})`,
    ).get(run.id, ...result.artifact_ids) as AnyRow;
    if (Number(owned.count) !== result.artifact_ids.length) {
      reasons.push('最终结果引用了不属于本 Run 的 Artifact');
    }
  }
  const highRisk = db.prepare(
    "SELECT id FROM harness_nodes WHERE run_id=? AND risk_level='high' LIMIT 1",
  ).get(run.id) as AnyRow | undefined;
  if (highRisk) reasons.push(`Phase 1 无法满足高风险节点 ${highRisk.id} 的验收层级`);
  return reasons;
}
