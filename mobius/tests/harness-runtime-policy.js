const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-runtime-policy-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.HARNESS_ROOT_RESULT_WAKE_ENABLED = '0'

const { db } = require('../db')
const { Sessions } = require('../backend/repositories/sessions')
const { setup, cleanup } = require('./harness/phase1-fixture')
const { createHarnessRun, resolveRoster } = require('../backend/repositories/harness')
const { estimateHarnessRun } = require('../backend/services/harness-estimator')
const { createNodeBatch, reportHarnessProgress } = require('../backend/services/harness-actions')
const { queueReadyHarnessNodes } = require('../backend/services/harness-dispatcher')
const { HarnessExecutorRegistry } = require('../backend/services/harness-executor')
const { FakeHarnessExecutor } = require('./harness/fake-executor')
const { mintHarnessNodeToken, verifyHarnessNodeToken } = require('../backend/services/harness-token')
const { enforceHarnessCostLimits, enforceHarnessNodeTimeouts } = require('../backend/services/harness-runtime-policy')
const {
  applyHarnessFailurePolicies,
  processHarnessCancellations,
  retryHarnessNodeByUser,
  waiveHarnessNodeByUser,
} = require('../backend/services/harness-control')

function draft(fixture, requestId) {
  return {
    anchor_type: 'issue',
    issue_id: fixture.issueId,
    goal: `Runtime policy ${requestId}`,
    execution_mode: 'multi',
    roster: {
      main_member_key: 'main',
      members: [
        { member_key: 'main', profile_id: 'system-codex-readonly-v1' },
        { member_key: 'worker_1', profile_id: 'system-codex-readonly-v1', purpose: 'worker' },
        { member_key: 'worker_2', profile_id: 'system-codex-readonly-v1', purpose: 'worker' },
      ],
    },
    policy: {
      schema_version: '1.1',
      topology_selection_mode: 'auto_safe',
      collaboration_shape: 'adaptive',
      max_concurrent_subharnesses: 2,
      parallel_read_only_only: true,
    },
  }
}

function createRun(fixture, requestId) {
  const input = draft(fixture, requestId)
  const roster = resolveRoster(fixture.userId, fixture.projectId, input)
  const estimate = estimateHarnessRun(
    fixture.userId,
    input,
    roster.map((member) => ({ id: member.profile.id, definition: member.profile.definition })),
  )
  const snapshot = createHarnessRun(fixture.userId, fixture.projectId, {
    ...input,
    request_id: requestId,
    acknowledged_estimate: {
      estimate_id: estimate.estimate_id,
      shown_cost_usd_range: estimate.estimated_cost_usd_range,
    },
  })
  const root = snapshot.nodes.find((node) => node.node_type === 'root')
  const main = snapshot.members.find((member) => member.role === 'main')
  db.prepare("UPDATE harness_nodes SET status='running', started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=?").run(root.id)
  db.prepare("UPDATE harness_runs SET status='running', version=version+1 WHERE id=?").run(snapshot.run.id)
  db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE node_id=?").run(root.id)
  const token = verifyHarnessNodeToken(mintHarnessNodeToken({
    runId: snapshot.run.id,
    nodeId: root.id,
    memberId: main.id,
    role: 'main',
    allowedMemberIds: snapshot.members.map((member) => member.id),
  }))
  return { snapshot, root, workers: snapshot.members.filter((member) => member.role === 'worker'), token }
}

function parallelContract(name, dependencies = [], failurePolicy = 'continue_siblings', aggregationKey) {
  return {
    schema_version: '1.2',
    objective: `Inspect ${name}`,
    risk_level: 'low',
    acceptance_criteria: [{ id: `${name}-done`, description: `${name} completed`, verification: 'parent_review', required: true, threshold: 1 }],
    inputs: [],
    deliverables: [{ kind: 'report', name, required: true }],
    dependencies,
    workspace: { mode: 'read_only' },
    tools: { profile: 'research', capability_tags: [] },
    budget: { timeout_seconds: 30, max_cost_usd: 1, max_attempts: 2 },
    communication: { parent_only: true, progress_interval_seconds: 10 },
    parallelism: {
      mode: 'parallel_safe',
      independence_key: `scope:${name}`,
      reason: `${name} is an independent bounded read-only scope.`,
      estimated_duration_seconds: 30,
      read_scopes: [`${name}/**`],
      mutable_resources: [],
      failure_policy: failurePolicy,
      ...(aggregationKey ? { aggregation_key: aggregationKey } : {}),
    },
  }
}

function childToken(run, node, worker) {
  return verifyHarnessNodeToken(mintHarnessNodeToken({
    runId: run.snapshot.run.id,
    nodeId: node.id,
    memberId: worker.id,
    role: 'worker',
    allowedMemberIds: [worker.id],
  }))
}

function bindFakeSession(run, node, executor) {
  const sessionId = `runtime_${node.id}`
  Sessions.insert({
    session_id: sessionId,
    issue_id: run.snapshot.run.issue_id,
    project_id: run.snapshot.run.project_id,
    scope_type: 'issue',
    user_id: run.snapshot.run.owner_user_id,
    name: `Runtime ${node.path}`,
    session_key: `runtime:${node.id}`,
    model: node.model,
  })
  db.prepare(`INSERT INTO harness_node_sessions (node_id, session_id, generation, status)
    VALUES (?, ?, 0, 'active')`).run(node.id, sessionId)
  executor.sessions.set(sessionId, { nodeId: node.id })
  return sessionId
}

async function main() {
  try {
    const executor = new FakeHarnessExecutor()
    executor.kind = 'mobius-session'
    const registry = new HarnessExecutorRegistry()
    registry.register(executor)

    const fixture = setup(db, tempRoot, 'runtime_timeout')
    const run = createRun(fixture, 'runtime-timeout-create')
    const batch = createNodeBatch(run.token, {
      request_id: 'runtime-timeout-batch',
      nodes: [
        { client_ref: 'source', assignee_member_id: run.workers[0].id, task_contract: parallelContract('source') },
        { client_ref: 'dependent', assignee_member_id: run.workers[1].id, task_contract: parallelContract('dependent', ['source']) },
      ],
    })
    const sourceId = batch.data.nodes.find((node) => node.client_ref === 'source').node_id
    const dependentId = batch.data.nodes.find((node) => node.client_ref === 'dependent').node_id
    db.prepare(`UPDATE harness_nodes SET status='running', attempt=1,
      started_at=datetime('now','-2 minutes'), heartbeat_at=datetime('now','-2 minutes'), version=version+1 WHERE id=?`).run(sourceId)
    db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE node_id=?").run(sourceId)
    const source = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(sourceId)
    const sourceToken = childToken(run, source, run.workers[0])
    const oldHeartbeat = source.heartbeat_at
    reportHarnessProgress(sourceToken, sourceId, {
      request_id: 'runtime-heartbeat-progress',
      message: 'Still processing bounded evidence.',
      percent: 25,
    })
    assert.notEqual(db.prepare('SELECT heartbeat_at FROM harness_nodes WHERE id=?').get(sourceId).heartbeat_at, oldHeartbeat)
    db.prepare("UPDATE harness_nodes SET started_at=datetime('now','-2 minutes') WHERE id=?").run(sourceId)
    const sourceSessionId = bindFakeSession(run, source, executor)

    assert.equal(await enforceHarnessNodeTimeouts(registry), 1)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(sourceId).status, 'timed_out')
    assert.equal(executor.sessions.get(sourceSessionId).interrupted, true)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_events WHERE run_id=? AND type='member.task_failed'").get(run.snapshot.run.id).count, 0)
    assert.equal(queueReadyHarnessNodes(run.snapshot.run.id), 1)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(sourceId).status, 'queued')

    db.prepare(`UPDATE harness_nodes SET status='running', attempt=2,
      started_at=datetime('now','-2 minutes'), heartbeat_at=datetime('now','-2 minutes'), version=version+1 WHERE id=?`).run(sourceId)
    db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE node_id=?").run(sourceId)
    assert.equal(await enforceHarnessNodeTimeouts(registry), 1)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(sourceId).status, 'timed_out')
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_events WHERE run_id=? AND type='member.task_failed'").get(run.snapshot.run.id).count, 1)
    assert.equal(applyHarnessFailurePolicies(), 1)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(dependentId).status, 'cancelled')

    waiveHarnessNodeByUser(fixture.userId, run.snapshot.run.id, sourceId, {
      request_id: 'runtime-timeout-waive',
      reason: 'Accept the documented timeout coverage gap.',
    })
    assert.ok(db.prepare('SELECT waived_at FROM harness_nodes WHERE id=?').get(sourceId).waived_at)

    const retryFixture = setup(db, tempRoot, 'runtime_retry')
    const retryRun = createRun(retryFixture, 'runtime-retry-create')
    const retryBatch = createNodeBatch(retryRun.token, {
      request_id: 'runtime-retry-batch',
      nodes: [{ client_ref: 'retry', assignee_member_id: retryRun.workers[0].id, task_contract: parallelContract('retry') }],
    })
    const retryId = retryBatch.data.nodes[0].node_id
    db.prepare(`UPDATE harness_nodes SET status='failed', attempt=1, failure_json='{"category":"business","retryable":false}',
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=?`).run(retryId)
    db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE node_id=?").run(retryId)
    const retryResult = retryHarnessNodeByUser(retryFixture.userId, retryRun.snapshot.run.id, retryId, {
      request_id: 'runtime-user-retry',
      reason: 'The missing read-only input is now available.',
    })
    assert.equal(retryResult.data.retry_pending, true)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(retryId).status, 'queued')

    const costFixture = setup(db, tempRoot, 'runtime_cost')
    const costRun = createRun(costFixture, 'runtime-cost-create')
    const costBatch = createNodeBatch(costRun.token, {
      request_id: 'runtime-cost-batch',
      nodes: [{ client_ref: 'cost', assignee_member_id: costRun.workers[0].id, task_contract: parallelContract('cost') }],
    })
    const costRoot = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(costRun.root.id)
    const costRootSession = bindFakeSession(costRun, costRoot, executor)
    db.prepare('UPDATE sessions_v2 SET total_cost_usd=6 WHERE session_id=?').run(costRootSession)
    assert.equal(enforceHarnessCostLimits(), 1)
    assert.equal(db.prepare('SELECT status FROM harness_runs WHERE id=?').get(costRun.snapshot.run.id).status, 'failed')
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(costBatch.data.nodes[0].node_id).status, 'cancelling')
    assert.equal(await processHarnessCancellations(registry), 2)
    assert.equal(executor.sessions.get(costRootSession).interrupted, true)

    const stopFixture = setup(db, tempRoot, 'runtime_stop_group')
    const stopRun = createRun(stopFixture, 'runtime-stop-create')
    const stopBatch = createNodeBatch(stopRun.token, {
      request_id: 'runtime-stop-batch',
      nodes: [
        { client_ref: 'left', assignee_member_id: stopRun.workers[0].id, task_contract: parallelContract('left', [], 'stop_group', 'comparison') },
        { client_ref: 'right', assignee_member_id: stopRun.workers[1].id, task_contract: parallelContract('right', [], 'stop_group', 'comparison') },
      ],
    })
    const leftId = stopBatch.data.nodes.find((node) => node.client_ref === 'left').node_id
    const rightId = stopBatch.data.nodes.find((node) => node.client_ref === 'right').node_id
    db.prepare(`UPDATE harness_nodes SET status='failed', attempt=2, failure_json='{"category":"business","retryable":false}',
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=?`).run(leftId)
    db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE node_id=?").run(leftId)
    assert.equal(applyHarnessFailurePolicies(), 1)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(rightId).status, 'cancelling')
    assert.equal(await processHarnessCancellations(registry), 1)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(rightId).status, 'cancelled')

    console.log('harness runtime policy tests passed')
  } finally {
    cleanup(fs, db, tempRoot)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
