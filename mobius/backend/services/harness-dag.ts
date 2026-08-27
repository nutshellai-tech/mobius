import { db } from '../../db';

type AnyRow = Record<string, any>;

export interface HarnessDagNodeState {
  node_id: string;
  ready: boolean;
  blocked_by: string[];
  failed_dependencies: string[];
}

function parsedObject(raw: unknown): Record<string, any> {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value && typeof value === 'object' ? value as Record<string, any> : {};
  } catch {
    return {};
  }
}

export function harnessNodeRetryPending(node: AnyRow): boolean {
  if (!['failed', 'timed_out', 'interrupted'].includes(String(node.status))) return false;
  if (node.waived_at) return false;
  const failure = parsedObject(node.failure_json);
  return failure.retryable === true && Number(node.attempt) < Number(node.max_attempts);
}

function dagError(message: string, code: string): Error {
  return Object.assign(new Error(message), { status: 400, code });
}

function graphRows(runId: string): { nodes: AnyRow[]; dependencies: AnyRow[] } {
  const nodes = db.prepare('SELECT id, node_type, status FROM harness_nodes WHERE run_id=?').all(runId) as AnyRow[];
  const dependencies = db.prepare(`SELECT d.run_id, d.node_id, d.depends_on_node_id,
      node.run_id AS node_run_id, node.node_type, dependency.run_id AS dependency_run_id
    FROM harness_dependencies d
    LEFT JOIN harness_nodes node ON node.id=d.node_id
    LEFT JOIN harness_nodes dependency ON dependency.id=d.depends_on_node_id
    WHERE d.run_id=?`).all(runId) as AnyRow[];
  return { nodes, dependencies };
}

export function assertHarnessDag(runId: string): void {
  const { nodes, dependencies } = graphRows(runId);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const dependents = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of dependencies) {
    if (!nodeIds.has(edge.node_id) || !nodeIds.has(edge.depends_on_node_id)
      || edge.node_run_id !== runId || edge.dependency_run_id !== runId) {
      throw dagError(`依赖节点不属于此 Run: ${edge.depends_on_node_id}`, 'cross_run_dependency');
    }
    if (edge.node_id === edge.depends_on_node_id) {
      throw dagError(`节点不能依赖自身: ${edge.node_id}`, 'self_dependency');
    }
    if (edge.node_type === 'root') {
      throw dagError('Root 节点不能依赖 child 节点', 'root_dependency_forbidden');
    }
    indegree.set(edge.node_id, (indegree.get(edge.node_id) || 0) + 1);
    dependents.get(edge.depends_on_node_id)!.push(edge.node_id);
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([nodeId]) => nodeId);
  let visited = 0;
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    visited += 1;
    for (const dependentId of dependents.get(nodeId) || []) {
      const next = (indegree.get(dependentId) || 0) - 1;
      indegree.set(dependentId, next);
      if (next === 0) ready.push(dependentId);
    }
  }
  if (visited !== nodes.length) throw dagError('Harness 节点依赖图包含环', 'dependency_cycle');
}

export function harnessDagNodeStates(runId: string): Map<string, HarnessDagNodeState> {
  const nodes = db.prepare(`SELECT id, status, attempt, max_attempts, failure_json, waived_at
    FROM harness_nodes WHERE run_id=?`).all(runId) as AnyRow[];
  const statusById = new Map(nodes.map((node) => [node.id, node.status]));
  const retryPendingById = new Map(nodes.map((node) => [node.id, harnessNodeRetryPending(node)]));
  const dependencies = db.prepare(`SELECT node_id, depends_on_node_id FROM harness_dependencies
    WHERE run_id=? ORDER BY created_at, depends_on_node_id`).all(runId) as AnyRow[];
  const dependenciesByNode = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const values = dependenciesByNode.get(dependency.node_id) || [];
    values.push(dependency.depends_on_node_id);
    dependenciesByNode.set(dependency.node_id, values);
  }
  return new Map(nodes.map((node) => {
    const blockedBy = (dependenciesByNode.get(node.id) || [])
      .filter((dependencyId) => statusById.get(dependencyId) !== 'succeeded');
    const failedDependencies = blockedBy.filter((dependencyId) => !retryPendingById.get(dependencyId) && [
      'failed', 'timed_out', 'interrupted', 'orphaned', 'cancelled',
    ].includes(String(statusById.get(dependencyId))));
    return [node.id, {
      node_id: node.id,
      ready: (node.status === 'created' || retryPendingById.get(node.id) === true) && blockedBy.length === 0,
      blocked_by: blockedBy,
      failed_dependencies: failedDependencies,
    }];
  }));
}

/**
 * Estimated remaining critical-path duration for each node. The scheduler uses
 * this only as a stable priority hint; malformed estimates fall back to one
 * second and never change dependency correctness.
 */
export function harnessDagCriticalPathSeconds(runId: string): Map<string, number> {
  const nodes = db.prepare('SELECT id, task_contract_json FROM harness_nodes WHERE run_id=?').all(runId) as AnyRow[];
  const dependents = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of db.prepare(`SELECT node_id, depends_on_node_id FROM harness_dependencies
    WHERE run_id=?`).all(runId) as AnyRow[]) {
    dependents.get(edge.depends_on_node_id)?.push(edge.node_id);
  }
  const durationById = new Map(nodes.map((node) => {
    const contract = parsedObject(node.task_contract_json);
    const estimate = Number(contract?.parallelism?.estimated_duration_seconds);
    return [node.id, Number.isFinite(estimate) && estimate > 0 ? estimate : 1];
  }));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const score = (nodeId: string): number => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return durationById.get(nodeId) || 1;
    visiting.add(nodeId);
    const downstream = (dependents.get(nodeId) || []).map(score);
    visiting.delete(nodeId);
    const value = (durationById.get(nodeId) || 1) + (downstream.length > 0 ? Math.max(...downstream) : 0);
    memo.set(nodeId, value);
    return value;
  };
  for (const node of nodes) score(node.id);
  return memo;
}

export function harnessNodesHaveDependencyPath(runId: string, firstNodeId: string, secondNodeId: string): boolean {
  if (firstNodeId === secondNodeId) return true;
  const dependencies = db.prepare('SELECT node_id, depends_on_node_id FROM harness_dependencies WHERE run_id=?').all(runId) as AnyRow[];
  const ancestors = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const values = ancestors.get(dependency.node_id) || [];
    values.push(dependency.depends_on_node_id);
    ancestors.set(dependency.node_id, values);
  }
  const reaches = (start: string, target: string): boolean => {
    const pending = [...(ancestors.get(start) || [])];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(ancestors.get(current) || []));
    }
    return false;
  };
  return reaches(firstNodeId, secondNodeId) || reaches(secondNodeId, firstNodeId);
}
