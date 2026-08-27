const assert = require('assert')
const express = require('express')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-parallel-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.HARNESS_ORCHESTRATOR_ENABLED = '0'
process.env.HARNESS_MAX_PARALLEL_SUBS = '4'
process.env.HARNESS_MAX_CODEX_SUBS = '4'
process.env.HARNESS_MAX_CLAUDE_SUBS = '4'
process.env.HARNESS_MAX_DEEPSEEK_SUBS = '4'

const { db } = require('../db')
const { Sessions } = require('../backend/repositories/sessions')
const { setup, contract, cleanup } = require('./harness/phase1-fixture')
const { createHarnessRun, getHarnessRunSnapshot, resolveRoster } = require('../backend/repositories/harness')
const { estimateHarnessRun, normalizedPhase1Policy } = require('../backend/services/harness-estimator')
const { createNodeBatch, createTaskForMember } = require('../backend/services/harness-actions')
const {
  claimNextHarnessDispatch,
  deliverClaimedHarnessDispatch,
  deliverClaimedHarnessDispatchBatch,
  queueReadyHarnessNodes,
} = require('../backend/services/harness-dispatcher')
const { HarnessExecutorRegistry } = require('../backend/services/harness-executor')
const { FakeHarnessExecutor } = require('./harness/fake-executor')
const { internalRouter } = require('../backend/routes/harnesses')
const { buildHarnessContext } = require('../backend/services/harness-context')
const { runHarnessScanOnce } = require('../backend/services/harness-orchestrator')
const { mintHarnessNodeToken, verifyHarnessNodeToken } = require('../backend/services/harness-token')
const { getHarnessSchedulingState } = require('../backend/services/harness-scheduling')

class OverlapExecutor extends FakeHarnessExecutor {
  constructor() {
    super({ providesDeliveryConfirmation: true })
    this.activeTurns = 0
    this.maxActiveTurns = 0
  }

  async startSession(spec) {
    const session = await super.startSession(spec)
    const node = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(spec.nodeId)
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(spec.runId)
    Sessions.insert({
      session_id: session.sessionId,
      issue_id: run.issue_id,
      project_id: run.project_id,
      scope_type: 'issue',
      user_id: run.owner_user_id,
      name: `Overlap ${node.path}`,
      session_key: `overlap:${node.id}`,
      model: node.model,
    })
    db.prepare(`INSERT INTO harness_node_sessions (node_id, session_id, generation, status)
      VALUES (?, ?, 0, 'active')`).run(node.id, session.sessionId)
    return session
  }

  async dispatch(input) {
    this.dispatches.push({ ...input })
    // Model execution continues after the prompt has been durably queued. Keep
    // the synthetic turn active so sequential control-plane delivery still
    // proves overlapping Agent execution.
    this.activeTurns += 1
    this.maxActiveTurns = Math.max(this.maxActiveTurns, this.activeTurns)
    return { delivered: true, evidence: 'observed', sessionId: input.sessionId }
  }

  settleAll() {
    this.activeTurns = 0
  }
}

class ConcurrentStartupExecutor extends OverlapExecutor {
  constructor() {
    super()
    this.activeDeliveries = 0
    this.maxConcurrentDeliveries = 0
  }

  async dispatch(input) {
    this.dispatches.push({ ...input })
    this.activeDeliveries += 1
    this.maxConcurrentDeliveries = Math.max(this.maxConcurrentDeliveries, this.activeDeliveries)
    await new Promise((resolve) => setTimeout(resolve, 25))
    this.activeDeliveries -= 1
    return { delivered: true, evidence: 'observed', sessionId: input.sessionId }
  }
}

function draftFor(fixture, requestId, concurrency = 2, workerCount = 2, adaptive = true, shape = 'adaptive', autoExpand = false) {
  const members = [{ member_key: 'main', profile_id: 'system-codex-readonly-v1' }]
  for (let index = 1; index <= workerCount; index += 1) {
    members.push({ member_key: `worker_${index}`, profile_id: 'system-codex-readonly-v1', purpose: 'worker' })
  }
  return {
    anchor_type: 'issue',
    issue_id: fixture.issueId,
    goal: `Parallel scheduling scenario ${requestId}`,
    execution_mode: 'multi',
    roster: { main_member_key: 'main', members, ...(autoExpand ? { auto_expand: true } : {}) },
    policy: {
      schema_version: '1.1',
      topology_selection_mode: adaptive ? 'auto_safe' : 'explicit',
      collaboration_shape: adaptive ? shape : 'pipeline',
      max_concurrent_subharnesses: adaptive ? concurrency : 1,
      parallel_read_only_only: true,
    },
  }
}

function createRun(fixture, requestId, concurrency = 2, workerCount = 2, adaptive = true, shape = 'adaptive', autoExpand = false) {
  const draft = draftFor(fixture, requestId, concurrency, workerCount, adaptive, shape, autoExpand)
  const roster = resolveRoster(fixture.userId, fixture.projectId, draft)
  const estimate = estimateHarnessRun(
    fixture.userId,
    draft,
    roster.map((member) => ({ id: member.profile.id, definition: member.profile.definition })),
  )
  const snapshot = createHarnessRun(fixture.userId, fixture.projectId, {
    ...draft,
    request_id: requestId,
    acknowledged_estimate: {
      estimate_id: estimate.estimate_id,
      shown_cost_usd_range: estimate.estimated_cost_usd_range,
    },
  })
  const root = snapshot.nodes.find((node) => node.node_type === 'root')
  const main = snapshot.members.find((member) => member.role === 'main')
  db.prepare("UPDATE harness_nodes SET status='running', version=version+1 WHERE id=?").run(root.id)
  db.prepare("UPDATE harness_runs SET status='running', version=version+1 WHERE id=?").run(snapshot.run.id)
  db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE run_id=? AND node_id=?").run(snapshot.run.id, root.id)
  const token = mintHarnessNodeToken({
    runId: snapshot.run.id,
    nodeId: root.id,
    memberId: main.id,
    role: 'main',
    allowedMemberIds: snapshot.members.map((member) => member.id),
  })
  return { snapshot, root, workers: snapshot.members.filter((member) => member.role !== 'main'), token, payload: verifyHarnessNodeToken(token) }
}

function parallelContract(name, dependencies = [], overrides = {}) {
  return {
    ...contract(`Inspect ${name}`, dependencies),
    schema_version: '1.2',
    deliverables: [{ kind: 'report', name, required: true }],
    parallelism: {
      mode: 'parallel_safe',
      independence_key: `code-area:${name}`,
      reason: `Reads only the independent ${name} scope.`,
      estimated_duration_seconds: 300,
      read_scopes: [`${name}/**`],
      mutable_resources: [],
      failure_policy: 'continue_siblings',
    },
    ...overrides,
  }
}

function settleRun(runId) {
  db.prepare("UPDATE harness_nodes SET status='succeeded' WHERE run_id=? AND node_type!='root'").run(runId)
  db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE run_id=?").run(runId)
}

async function main() {
  const app = express()
  app.use(express.json())
  app.use('/api/harness-internal', internalRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const serialFixture = setup(db, tempRoot, 'parallel_serial')
    const defaultAutoDraft = draftFor(serialFixture, 'parallel-default-auto', 2, 2, true)
    delete defaultAutoDraft.policy
    const defaultAutoPolicy = normalizedPhase1Policy(defaultAutoDraft)
    assert.equal(defaultAutoPolicy.schema_version, '1.1')
    assert.equal(defaultAutoPolicy.topology_selection_mode, 'auto_safe')
    assert.equal(defaultAutoPolicy.collaboration_shape, 'adaptive')
    assert.equal(defaultAutoPolicy.max_concurrent_subharnesses, 2)
    const serialEstimateDraft = draftFor(serialFixture, 'parallel-estimate-serial', 2, 2, false)
    const serialEstimateRoster = resolveRoster(serialFixture.userId, serialFixture.projectId, serialEstimateDraft)
    const serialEstimate = estimateHarnessRun(serialFixture.userId, serialEstimateDraft,
      serialEstimateRoster.map((member) => ({ id: member.profile.id, definition: member.profile.definition })))
    const adaptiveEstimateDraft = draftFor(serialFixture, 'parallel-estimate-adaptive', 2, 2, true)
    const adaptiveEstimateRoster = resolveRoster(serialFixture.userId, serialFixture.projectId, adaptiveEstimateDraft)
    const adaptiveEstimate = estimateHarnessRun(serialFixture.userId, adaptiveEstimateDraft,
      adaptiveEstimateRoster.map((member) => ({ id: member.profile.id, definition: member.profile.definition })))
    assert.ok(adaptiveEstimate.estimated_duration_seconds_range[1] < serialEstimate.estimated_duration_seconds_range[1])
    assert.deepEqual(adaptiveEstimate.estimated_cost_usd_range, serialEstimate.estimated_cost_usd_range)
    assert.ok(adaptiveEstimate.estimated_parallel_speedup > 1)
    const serial = createRun(serialFixture, 'parallel-serial-create', 2, 2, false)
    assert.equal(serial.snapshot.run.policy.schema_version, '1.1')
    assert.equal(serial.snapshot.run.policy.collaboration_shape, 'adaptive')
    assert.equal(serial.snapshot.run.policy.topology_selection_mode, 'auto_safe')
    assert.equal(serial.snapshot.run.policy.max_concurrent_subharnesses, 1)
    const serialBatch = createNodeBatch(serial.payload, {
      request_id: 'parallel-serial-batch',
      nodes: [
        { client_ref: 'first', assignee_member_id: serial.workers[0].id, task_contract: contract('First serial task', []) },
        { client_ref: 'second', assignee_member_id: serial.workers[1].id, task_contract: contract('Second serial task', ['first']) },
      ],
    })
    assert.deepEqual(serialBatch.data.nodes.map((node) => node.queued), [true, false])
    settleRun(serial.snapshot.run.id)

    const adaptiveFixture = setup(db, tempRoot, 'parallel_adaptive')
    const adaptive = createRun(adaptiveFixture, 'parallel-adaptive-create', 2, 2)
    const adaptiveContext = buildHarnessContext(adaptive.root.id).prompt
    assert.match(adaptiveContext, /Collaboration shape: adaptive/)
    assert.match(adaptiveContext, new RegExp(`/runs/${adaptive.snapshot.run.id}/node-batches`))
    assert.match(adaptiveContext, new RegExp(`/runs/${adaptive.snapshot.run.id}/scheduling`))
    assert.match(adaptiveContext, /first full independent wave/)
    assert.match(adaptiveContext, /"mode": "parallel_safe"/)
    const response = await fetch(`${base}/api/harness-internal/runs/${adaptive.snapshot.run.id}/node-batches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adaptive.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: 'parallel-adaptive-batch',
        nodes: [
          { client_ref: 'backend', assignee_member_id: adaptive.workers[0].id, task_contract: parallelContract('backend') },
          { client_ref: 'frontend', assignee_member_id: adaptive.workers[1].id, task_contract: parallelContract('frontend') },
        ],
      }),
    })
    const responseBody = await response.json()
    assert.equal(response.status, 200, JSON.stringify(responseBody))
    assert.deepEqual(responseBody.data.nodes.map((node) => node.queued), [true, true])
    assert.equal(responseBody.data.scheduling.idle_slots, 0)
    const schedulingResponse = await fetch(`${base}/api/harness-internal/runs/${adaptive.snapshot.run.id}/scheduling`, {
      headers: { Authorization: `Bearer ${adaptive.token}` },
    }).then((item) => item.json())
    assert.equal(schedulingResponse.ok, true)
    assert.equal(schedulingResponse.scheduling.active_sub_count, 2)
    assert.equal(schedulingResponse.scheduling.recommended_action, 'continue_main_work_or_wait')
    const replay = await fetch(`${base}/api/harness-internal/runs/${adaptive.snapshot.run.id}/node-batches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adaptive.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: 'parallel-adaptive-batch', nodes: [
        { client_ref: 'backend', assignee_member_id: adaptive.workers[0].id, task_contract: parallelContract('backend') },
      ] }),
    }).then((item) => item.json())
    assert.equal(replay.replayed, true)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=? AND node_type!='root'").get(adaptive.snapshot.run.id).count, 2)
    assert.ok(claimNextHarnessDispatch('parallel-claim-1'))
    assert.ok(claimNextHarnessDispatch('parallel-claim-2'))
    assert.equal(claimNextHarnessDispatch('parallel-claim-3'), null)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=? AND status='starting'").get(adaptive.snapshot.run.id).count, 2)
    settleRun(adaptive.snapshot.run.id)

    const overlapFixture = setup(db, tempRoot, 'parallel_overlap')
    const overlap = createRun(overlapFixture, 'parallel-overlap-create', 2, 2)
    createNodeBatch(overlap.payload, {
      request_id: 'parallel-overlap-batch',
      nodes: [
        { client_ref: 'left', assignee_member_id: overlap.workers[0].id, task_contract: parallelContract('overlap_left') },
        { client_ref: 'right', assignee_member_id: overlap.workers[1].id, task_contract: parallelContract('overlap_right') },
      ],
    })
    const overlapClaim1 = claimNextHarnessDispatch('parallel-overlap-1')
    const overlapClaim2 = claimNextHarnessDispatch('parallel-overlap-2')
    const overlapExecutor = new OverlapExecutor()
    const overlapRegistry = new HarnessExecutorRegistry()
    overlapRegistry.register(overlapExecutor)
    await deliverClaimedHarnessDispatch(overlapClaim1, overlapRegistry)
    await deliverClaimedHarnessDispatch(overlapClaim2, overlapRegistry)
    assert.equal(overlapExecutor.maxActiveTurns, 2, 'sequential prompt delivery must not serialize Agent execution')
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=? AND node_type!='root' AND status='running'").get(overlap.snapshot.run.id).count, 2)
    overlapExecutor.settleAll()
    settleRun(overlap.snapshot.run.id)

    const startupFixture = setup(db, tempRoot, 'parallel_startup_batch')
    const startup = createRun(startupFixture, 'parallel-startup-create', 2, 2)
    createNodeBatch(startup.payload, {
      request_id: 'parallel-startup-batch',
      nodes: [
        { client_ref: 'startup_left', assignee_member_id: startup.workers[0].id, task_contract: parallelContract('startup_left') },
        { client_ref: 'startup_right', assignee_member_id: startup.workers[1].id, task_contract: parallelContract('startup_right') },
      ],
    })
    const startupClaims = [
      claimNextHarnessDispatch('parallel-startup-1'),
      claimNextHarnessDispatch('parallel-startup-2'),
    ]
    assert.ok(startupClaims.every(Boolean))
    const startupExecutor = new ConcurrentStartupExecutor()
    const startupRegistry = new HarnessExecutorRegistry()
    startupRegistry.register(startupExecutor)
    await deliverClaimedHarnessDispatchBatch(startupClaims, startupRegistry)
    assert.equal(startupExecutor.maxConcurrentDeliveries, 2, 'different nodes in one dispatch wave must start concurrently')
    settleRun(startup.snapshot.run.id)

    const fillFixture = setup(db, tempRoot, 'parallel_fill_wave')
    const fill = createRun(fillFixture, 'parallel-fill-create', 4, 4, true, 'adaptive', true)
    const single = createTaskForMember(fill.payload, {
      request_id: 'parallel-fill-single',
      assignee_member_id: fill.workers[0].id,
      task_contract: parallelContract('only_first_scope'),
    })
    assert.equal(single.data.scheduling.underfilled, true)
    assert.equal(single.data.scheduling.idle_slots, 3)
    assert.equal(single.data.scheduling.recommended_action, 'fill_parallel_wave')
    assert.equal(getHarnessSchedulingState(fill.snapshot.run.id).available_member_ids.length, 3)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_events WHERE run_id=? AND type='scheduler.wave_underfilled'").get(fill.snapshot.run.id).count, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_dispatches WHERE run_id=? AND kind='followup' AND status='queued'").get(fill.snapshot.run.id).count, 1)
    const refillClaim = claimNextHarnessDispatch('parallel-refill-nudge')
    assert.equal(refillClaim.dispatch.kind, 'followup')
    const refillExecutor = new OverlapExecutor()
    const refillRegistry = new HarnessExecutorRegistry()
    refillRegistry.register(refillExecutor)
    await deliverClaimedHarnessDispatch(refillClaim, refillRegistry)
    assert.match(refillExecutor.dispatches[0].prompt, /Do not passively wait/)
    assert.match(refillExecutor.dispatches[0].prompt, /fill_parallel_wave/)
    settleRun(fill.snapshot.run.id)

    const fanoutFixture = setup(db, tempRoot, 'parallel_fanout')
    const fanout = createRun(fanoutFixture, 'parallel-fanout-create', 4, 4, true, 'fanout')
    const fanoutBatch = createNodeBatch(fanout.payload, {
      request_id: 'parallel-fanout-batch',
      nodes: fanout.workers.map((worker, index) => ({
        client_ref: `fanout_${index + 1}`,
        assignee_member_id: worker.id,
        task_contract: parallelContract(`fanout_${index + 1}`),
      })),
    })
    assert.equal(fanoutBatch.data.nodes.filter((node) => node.queued).length, 4)
    settleRun(fanout.snapshot.run.id)

    process.env.HARNESS_MAX_CODEX_SUBS = '1'
    const backendFixture = setup(db, tempRoot, 'parallel_backend_capacity')
    const backendLimited = createRun(backendFixture, 'parallel-backend-create', 2, 2)
    const backendBatch = createNodeBatch(backendLimited.payload, {
      request_id: 'parallel-backend-batch',
      nodes: backendLimited.workers.map((worker, index) => ({
        client_ref: `backend_${index + 1}`,
        assignee_member_id: worker.id,
        task_contract: parallelContract(`backend_${index + 1}`),
      })),
    })
    assert.equal(backendBatch.data.nodes.filter((node) => node.queued).length, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=? AND waiting_reason='resource:backend_capacity:codex'").get(backendLimited.snapshot.run.id).count, 1)
    settleRun(backendLimited.snapshot.run.id)
    process.env.HARNESS_MAX_CODEX_SUBS = '4'

    process.env.HARNESS_MAX_PARALLEL_SUBS = '2'
    const capacityFixture = setup(db, tempRoot, 'parallel_capacity')
    const capacity = createRun(capacityFixture, 'parallel-capacity-create', 4, 4)
    const capacityBatch = createNodeBatch(capacity.payload, {
      request_id: 'parallel-capacity-batch',
      nodes: capacity.workers.map((worker, index) => ({
        client_ref: `scope_${index + 1}`,
        assignee_member_id: worker.id,
        task_contract: parallelContract(`scope_${index + 1}`),
      })),
    })
    assert.equal(capacityBatch.data.nodes.filter((node) => node.queued).length, 2)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=? AND waiting_reason='resource:host_capacity'").get(capacity.snapshot.run.id).count, 2)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_events WHERE run_id=? AND type='node.resource_blocked'").get(capacity.snapshot.run.id).count, 2)
    const firstWave = capacityBatch.data.nodes.filter((node) => node.queued)
    db.prepare("UPDATE harness_nodes SET status='succeeded' WHERE id=?").run(firstWave[0].node_id)
    db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE node_id=?").run(firstWave[0].node_id)
    assert.equal(queueReadyHarnessNodes(capacity.snapshot.run.id), 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=? AND node_type!='root'
      AND status IN ('queued','starting','running','waiting_input','submitted','verifying')`).get(capacity.snapshot.run.id).count, 2)
    db.prepare("UPDATE harness_nodes SET status='succeeded' WHERE id=?").run(firstWave[1].node_id)
    db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE node_id=?").run(firstWave[1].node_id)
    assert.equal(queueReadyHarnessNodes(capacity.snapshot.run.id), 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=? AND node_type!='root' AND status='created'").get(capacity.snapshot.run.id).count, 0)
    settleRun(capacity.snapshot.run.id)
    process.env.HARNESS_MAX_PARALLEL_SUBS = '4'

    const conflictFixture = setup(db, tempRoot, 'parallel_member')
    const conflict = createRun(conflictFixture, 'parallel-member-create', 2, 2)
    assert.throws(() => createNodeBatch(conflict.payload, {
      request_id: 'parallel-member-batch',
      nodes: [
        { client_ref: 'one', assignee_member_id: conflict.workers[0].id, task_contract: parallelContract('one') },
        { client_ref: 'two', assignee_member_id: conflict.workers[0].id, task_contract: parallelContract('two') },
      ],
    }), (error) => error.code === 'parallel_member_conflict')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=?').get(conflict.snapshot.run.id).count, 1)

    const cycleFixture = setup(db, tempRoot, 'parallel_cycle')
    const cycle = createRun(cycleFixture, 'parallel-cycle-create', 2, 2)
    assert.throws(() => createNodeBatch(cycle.payload, {
      request_id: 'parallel-cycle-batch',
      nodes: [
        { client_ref: 'left', assignee_member_id: cycle.workers[0].id, task_contract: parallelContract('left', ['right']) },
        { client_ref: 'right', assignee_member_id: cycle.workers[1].id, task_contract: parallelContract('right', ['left']) },
      ],
    }), (error) => error.code === 'dependency_cycle')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=?').get(cycle.snapshot.run.id).count, 1)
    assert.throws(() => createNodeBatch(cycle.payload, {
      request_id: 'parallel-self-batch',
      nodes: [{ client_ref: 'self', assignee_member_id: cycle.workers[0].id, task_contract: parallelContract('self', ['self']) }],
    }), (error) => error.code === 'self_dependency')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=?').get(cycle.snapshot.run.id).count, 1)

    const rollbackFixture = setup(db, tempRoot, 'parallel_rollback')
    const rollback = createRun(rollbackFixture, 'parallel-rollback-create', 2, 2)
    assert.throws(() => createNodeBatch(rollback.payload, {
      request_id: 'parallel-risk-batch',
      nodes: [
        { client_ref: 'valid', assignee_member_id: rollback.workers[0].id, task_contract: parallelContract('valid') },
        { client_ref: 'risky', assignee_member_id: rollback.workers[1].id, task_contract: parallelContract('risky', [], { risk_level: 'medium' }) },
      ],
    }), (error) => error.code === 'phase1_risk_forbidden')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=?').get(rollback.snapshot.run.id).count, 1)
    assert.throws(() => createNodeBatch(rollback.payload, {
      request_id: 'parallel-cross-run-batch',
      nodes: [{
        client_ref: 'foreign',
        assignee_member_id: rollback.workers[0].id,
        task_contract: parallelContract('foreign', [fanoutBatch.data.nodes[0].node_id]),
      }],
    }), (error) => error.code === 'cross_run_dependency')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=?').get(rollback.snapshot.run.id).count, 1)
    assert.throws(() => createNodeBatch(rollback.payload, {
      request_id: 'parallel-workspace-batch',
      nodes: [{
        client_ref: 'writer',
        assignee_member_id: rollback.workers[0].id,
        task_contract: { ...parallelContract('writer'), workspace: { mode: 'isolated_worktree' } },
      }],
    }), (error) => error.code === 'invalid_harness_schema')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=?').get(rollback.snapshot.run.id).count, 1)
    const overlapLeft = parallelContract('overlap_area')
    const overlapRight = parallelContract('overlap_services')
    overlapRight.parallelism.read_scopes = ['overlap_area/services/**']
    assert.throws(() => createNodeBatch(rollback.payload, {
      request_id: 'parallel-overlap-scope-batch',
      nodes: [
        { client_ref: 'overlap-left', assignee_member_id: rollback.workers[0].id, task_contract: overlapLeft },
        { client_ref: 'overlap-right', assignee_member_id: rollback.workers[1].id, task_contract: overlapRight },
      ],
    }), (error) => error.code === 'parallel_read_scope_overlap')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=?').get(rollback.snapshot.run.id).count, 1)

    const blockedFixture = setup(db, tempRoot, 'parallel_blocked')
    const blocked = createRun(blockedFixture, 'parallel-blocked-create', 2, 2)
    const blockedBatch = createNodeBatch(blocked.payload, {
      request_id: 'parallel-blocked-batch',
      nodes: [
        { client_ref: 'source', assignee_member_id: blocked.workers[0].id, task_contract: parallelContract('source') },
        { client_ref: 'dependent', assignee_member_id: blocked.workers[1].id, task_contract: parallelContract('dependent', ['source']) },
      ],
    })
    const source = blockedBatch.data.nodes.find((node) => node.client_ref === 'source')
    const dependent = blockedBatch.data.nodes.find((node) => node.client_ref === 'dependent')
    db.prepare("UPDATE harness_nodes SET status='failed' WHERE id=?").run(source.node_id)
    db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE node_id=?").run(source.node_id)
    assert.equal(queueReadyHarnessNodes(blocked.snapshot.run.id), 0)
    const blockedSnapshot = getHarnessRunSnapshot(blocked.snapshot.run.id)
    assert.deepEqual(blockedSnapshot.nodes.find((node) => node.id === dependent.node_id).blocked_by, [source.node_id])
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_events WHERE run_id=? AND type='node.dependency_blocked'").get(blocked.snapshot.run.id).count, 1)

    process.env.HARNESS_MAX_PARALLEL_SUBS = '3'
    const stressRuns = []
    const stressNodeIds = new Set()
    for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
      const fixture = setup(db, tempRoot, `parallel_stress_${runIndex}`)
      const run = createRun(fixture, `parallel-stress-create-${runIndex}`, 4, 4)
      const batch = createNodeBatch(run.payload, {
        request_id: `parallel-stress-batch-${runIndex}`,
        nodes: run.workers.map((worker, workerIndex) => ({
          client_ref: `stress_${runIndex}_${workerIndex + 1}`,
          assignee_member_id: worker.id,
          task_contract: parallelContract(`stress_${runIndex}_${workerIndex + 1}`),
        })),
      })
      stressRuns.push(run)
      batch.data.nodes.forEach((node) => stressNodeIds.add(node.node_id))
    }

    const activeStates = "'queued','starting','running','waiting_input','submitted','verifying'"
    const seenActive = new Set()
    const assertStressCaps = () => {
      const activeRows = db.prepare(`SELECT run_id, id, assignee_member_id FROM harness_nodes
        WHERE node_type!='root' AND status IN (${activeStates})`).all()
      assert.ok(activeRows.length <= 3, `host cap exceeded: ${activeRows.length}`)
      for (const row of activeRows) {
        if (stressNodeIds.has(row.id)) seenActive.add(row.id)
      }
      for (const run of stressRuns) {
        const runActive = activeRows.filter((row) => row.run_id === run.snapshot.run.id)
        assert.ok(runActive.length <= 4, `run cap exceeded for ${run.snapshot.run.id}`)
        assert.equal(new Set(runActive.map((row) => row.assignee_member_id)).size, runActive.length,
          `member double-occupied in ${run.snapshot.run.id}`)
      }
      const duplicateDispatch = db.prepare(`SELECT node_id, COUNT(*) AS count FROM harness_dispatches
        WHERE kind='start' GROUP BY node_id HAVING COUNT(*) > 1 LIMIT 1`).get()
      assert.equal(duplicateDispatch, undefined, 'stress scans must not create duplicate start dispatches')
      const activeCodex = db.prepare(`SELECT COUNT(*) AS count FROM harness_nodes n
        JOIN harness_run_members m ON m.id=n.assignee_member_id AND m.run_id=n.run_id
        WHERE n.node_type!='root' AND n.status IN (${activeStates})
          AND json_extract(m.config_snapshot_json, '$.definition.backend')='codex'`).get().count
      assert.ok(activeCodex <= 4, `backend cap exceeded: ${activeCodex}`)
    }

    process.env.HARNESS_ORCHESTRATOR_ENABLED = '1'
    process.env.HARNESS_DISPATCH_ENABLED = '0'
    process.env.HARNESS_VERIFICATION_ENABLED = '0'
    let stressScans = 0
    for (let round = 0; round < 10; round += 1) {
      await Promise.all([runHarnessScanOnce(), runHarnessScanOnce()])
      stressScans += 2
      assertStressCaps()
      const released = db.prepare(`SELECT id FROM harness_nodes
        WHERE node_type!='root' AND status IN (${activeStates}) ORDER BY created_at, id LIMIT 1`).get()
      assert.ok(released, `stress round ${round + 1} had no active slot to release`)
      db.prepare("UPDATE harness_nodes SET status='succeeded' WHERE id=?").run(released.id)
      db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE node_id=? AND kind='start'").run(released.id)
    }
    assert.equal(stressScans, 20)
    assert.equal(seenActive.size, stressNodeIds.size, 'slot release should eventually schedule every stress node')
    assertStressCaps()
    for (const run of stressRuns) settleRun(run.snapshot.run.id)
    delete process.env.HARNESS_DISPATCH_ENABLED
    delete process.env.HARNESS_VERIFICATION_ENABLED
    process.env.HARNESS_ORCHESTRATOR_ENABLED = '0'
    process.env.HARNESS_MAX_PARALLEL_SUBS = '4'

    console.log('harness adaptive DAG and batch scheduling tests passed')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    cleanup(fs, db, tempRoot)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
