import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { MAX_HARNESS_AGENTS } from '../types/harness';
import type { HarnessEstimateRequestV1, HarnessProfileDefinitionV1, HarnessRunPolicyV1 } from '../types/harness';
import { harnessCapacity } from './harness-features';

export interface HarnessEstimateProfile {
  id: string;
  definition: HarnessProfileDefinitionV1;
}

export interface HarnessEstimateV1 {
  estimate_id: string;
  expires_at: string;
  estimated_duration_seconds_range: [number, number];
  estimated_serial_duration_seconds_range: [number, number];
  estimated_cost_usd_range: [number, number];
  relative_to_single: number;
  estimated_parallel_speedup: number;
  assumptions: string[];
}

interface EstimateTokenPayload {
  kind: 'harness-estimate';
  user_id: string;
  digest: string;
  cost_range: [number, number];
  duration_range: [number, number];
  relative_to_single: number;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizedPhase1Policy(
  request: HarnessEstimateRequestV1,
  effectiveMemberCount = request.roster.members.length,
): HarnessRunPolicyV1 {
  const memberCount = Math.max(1, effectiveMemberCount);
  const base = {
    schema_version: '1.0',
    collaboration_shape: 'pipeline',
    max_concurrent_subharnesses: 1,
    max_depth: request.execution_mode === 'single' ? 0 : 1,
    max_nodes: Math.max(1, Math.min(MAX_HARNESS_AGENTS, memberCount)) as HarnessRunPolicyV1['max_nodes'],
    default_timeout_seconds: Math.max(60, Math.min(3600, Number(request.policy?.default_timeout_seconds) || 1800)),
    workspace_policy: 'read_only',
    evaluator_policy: ['always', 'off'].includes(String(request.policy?.evaluator_policy))
      ? request.policy!.evaluator_policy as 'always' | 'off'
      : 'off',
    context_reset_policy: 'off',
    cost_soft_limit_usd: 2,
    cost_hard_limit_usd: 5,
  } satisfies HarnessRunPolicyV1;
  if (request.execution_mode !== 'multi') return base;
  const requestedPolicy = request.policy?.schema_version === '1.1' ? request.policy : undefined;
  const workerCount = Math.max(1, memberCount - 1);
  const defaultConcurrency = Math.min(4, workerCount, harnessCapacity('HARNESS_MAX_PARALLEL_SUBS', 4));
  const requestedConcurrency = Number(requestedPolicy?.max_concurrent_subharnesses)
    || defaultConcurrency;
  const concurrency = Math.max(1, Math.min(4, workerCount, requestedConcurrency)) as 1 | 2 | 3 | 4;
  return {
    ...base,
    schema_version: '1.1',
    topology_selection_mode: 'auto_safe',
    collaboration_shape: 'adaptive',
    max_concurrent_subharnesses: concurrency,
    parallel_read_only_only: true,
  };
}

export function estimateDigest(request: HarnessEstimateRequestV1, policy: HarnessRunPolicyV1): string {
  return crypto.createHash('sha256').update(stable({
    anchor_type: request.anchor_type,
    issue_id: request.issue_id,
    session_name: request.session_name?.trim() || null,
    language: request.language || 'zh',
    excluded_skill_ids: request.excluded_skill_ids || [],
    excluded_memory_ids: request.excluded_memory_ids || [],
    goal: request.goal.trim(),
    execution_mode: request.execution_mode,
    roster: request.roster,
    policy,
  })).digest('hex');
}

export function estimateHarnessRun(userId: string, request: HarnessEstimateRequestV1, profiles: HarnessEstimateProfile[]): HarnessEstimateV1 {
  const policy = normalizedPhase1Policy(request, profiles.length);
  const factors = profiles.map((profile) => profile.definition.cost_profile.relative_cost_factor);
  const baseTotalFactor = factors.reduce((sum, factor) => sum + factor, 0);
  const parallelMultiplier = policy.schema_version === '1.1' && policy.collaboration_shape !== 'pipeline'
    ? policy.collaboration_shape === 'fanout' ? 1.12 : 1.08
    : 1;
  const totalFactor = baseTotalFactor * parallelMultiplier;
  const baselineFactor = factors[0] || 1;
  const relative = Number((totalFactor / baselineFactor).toFixed(2));
  const lowerCost = Number((0.08 * totalFactor).toFixed(2));
  const upperCost = Number((0.35 * totalFactor).toFixed(2));
  const durationBase = Math.max(240, Math.min(policy.default_timeout_seconds, 1200));
  const costRange: [number, number] = [lowerCost, upperCost];
  const serialDurationRange: [number, number] = [durationBase, durationBase * profiles.length];
  const parallel = policy.schema_version === '1.1' && policy.collaboration_shape !== 'pipeline'
    && policy.max_concurrent_subharnesses > 1;
  const subCount = Math.max(1, profiles.length - 1);
  const waves = Math.ceil(subCount / Number(policy.max_concurrent_subharnesses));
  const synthesisSeconds = Math.max(60, Math.round(durationBase * 0.2));
  const durationRange: [number, number] = parallel
    ? [durationBase + synthesisSeconds, Math.ceil((waves * durationBase + synthesisSeconds) * 1.15)]
    : serialDurationRange;
  const estimatedParallelSpeedup = parallel
    ? Number((serialDurationRange[1] / durationRange[1]).toFixed(2))
    : 1;
  const token = jwt.sign({
    kind: 'harness-estimate',
    user_id: userId,
    digest: estimateDigest(request, policy),
    cost_range: costRange,
    duration_range: durationRange,
    relative_to_single: relative,
  } satisfies EstimateTokenPayload, JWT_SECRET, { expiresIn: '15m', audience: 'mobius-harness-create' });
  const decoded = jwt.decode(token) as { exp?: number } | null;
  return {
    estimate_id: token,
    expires_at: new Date((decoded?.exp || Math.floor(Date.now() / 1000) + 900) * 1000).toISOString(),
    estimated_duration_seconds_range: durationRange,
    estimated_serial_duration_seconds_range: serialDurationRange,
    estimated_cost_usd_range: costRange,
    relative_to_single: relative,
    estimated_parallel_speedup: estimatedParallelSpeedup,
    assumptions: parallel ? [
      `仅低风险、只读且无依赖的任务按最多 ${policy.max_concurrent_subharnesses} 路并发分 wave 估算`,
      request.roster.auto_expand
        ? `系统已从所选 Profile 预留 ${Math.max(1, profiles.length - 1)} 个 Worker 实例；仅实际派发的实例产生运行成本`
        : '使用显式锁定的 Worker 阵容估算',
      '成本包含 Main 综合和并行上下文重复开销；实际并发还受主机与 backend 容量限制',
    ] : [
      '当前阵容按单路执行估算，Run 策略仍保持智能调度',
      '估算按 Profile 相对成本系数计算，实际成本会记录用于后续校准',
    ],
  };
}

export function verifyHarnessEstimate(
  userId: string,
  request: HarnessEstimateRequestV1,
  policy: HarnessRunPolicyV1,
  estimateId: string,
  shownRange: [number, number],
): Pick<EstimateTokenPayload, 'cost_range' | 'duration_range' | 'relative_to_single'> {
  let payload: EstimateTokenPayload;
  try {
    payload = jwt.verify(estimateId, JWT_SECRET, { audience: 'mobius-harness-create' }) as EstimateTokenPayload;
  } catch {
    throw Object.assign(new Error('成本预估已失效，请重新查看并确认'), { code: 'estimate_expired', status: 409 });
  }
  const digest = estimateDigest(request, policy);
  if (payload.kind !== 'harness-estimate' || payload.user_id !== userId || payload.digest !== digest) {
    throw Object.assign(new Error('Roster 或运行策略已变化，请重新确认成本预估'), { code: 'estimate_mismatch', status: 409 });
  }
  if (!Array.isArray(payload.cost_range) || payload.cost_range.length !== 2
    || payload.cost_range[0] !== shownRange[0] || payload.cost_range[1] !== shownRange[1]) {
    throw Object.assign(new Error('提交的成本区间与已展示预估不一致'), { code: 'estimate_range_mismatch', status: 409 });
  }
  if (!Array.isArray(payload.duration_range) || payload.duration_range.length !== 2
    || !payload.duration_range.every((value) => Number.isFinite(value) && value >= 0)
    || !Number.isFinite(payload.relative_to_single) || payload.relative_to_single <= 0) {
    throw Object.assign(new Error('成本预估内容不完整，请重新查看并确认'), { code: 'estimate_payload_invalid', status: 409 });
  }
  return {
    cost_range: payload.cost_range,
    duration_range: payload.duration_range,
    relative_to_single: payload.relative_to_single,
  };
}
