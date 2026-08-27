const assert = require('assert')
const express = require('express')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-result-ack-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.HARNESS_ORCHESTRATOR_ENABLED = '0'

const { db } = require('../db')
const { setup, rosterRequest, contract, result, cleanup } = require('./harness/phase1-fixture')
const { appendHarnessEvent, createHarnessRun, resolveRoster } = require('../backend/repositories/harness')
const { estimateHarnessRun } = require('../backend/services/harness-estimator')
const { internalRouter } = require('../backend/routes/harnesses')
const {
  acknowledgeHarnessResultEvent,
  completeHarnessNode,
  createTaskForMember,
  failHarnessNode,
} = require('../backend/services/harness-actions')
const { verifySubmittedHarnessNode } = require('../backend/services/harness-orchestrator')
const { mintHarnessNodeToken, verifyHarnessNodeToken } = require('../backend/services/harness-token')

function createMulti(fixture, requestId) {
  const draft = rosterRequest(fixture, 'multi')
  const roster = resolveRoster(fixture.userId, fixture.projectId, draft)
  const estimate = estimateHarnessRun(
    fixture.userId,
    draft,
    roster.map((member) => ({ id: member.profile.id, definition: member.profile.definition })),
  )
  return createHarnessRun(fixture.userId, fixture.projectId, {
    ...draft,
    request_id: requestId,
    acknowledged_estimate: {
      estimate_id: estimate.estimate_id,
      shown_cost_usd_range: estimate.estimated_cost_usd_range,
    },
  })
}

function prepareChild(suffix, mode = 'success') {
  const fixture = setup(db, tempRoot, suffix)
  const snapshot = createMulti(fixture, `${suffix}-create`)
  const root = snapshot.nodes[0]
  const main = snapshot.members.find((member) => member.role === 'main')
  const worker = snapshot.members.find((member) => member.role === 'worker')
  db.prepare("UPDATE harness_nodes SET status='running', version=version+1 WHERE id=?").run(root.id)
  db.prepare("UPDATE harness_runs SET status='running', version=version+1 WHERE id=?").run(snapshot.run.id)
  db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE run_id=?").run(snapshot.run.id)

  const mainToken = mintHarnessNodeToken({
    runId: snapshot.run.id,
    nodeId: root.id,
    memberId: main.id,
    role: 'main',
    allowedMemberIds: snapshot.members.map((member) => member.id),
  })
  const mainPayload = verifyHarnessNodeToken(mainToken)
  const created = createTaskForMember(mainPayload, {
    request_id: `${suffix}-task`,
    assignee_member_id: worker.id,
    task_contract: contract(),
  })
  const childId = created.data.node_id
  db.prepare("UPDATE harness_nodes SET status='running', version=version+1 WHERE id=?").run(childId)
  db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE node_id=? AND kind='start'").run(childId)
  const workerToken = mintHarnessNodeToken({
    runId: snapshot.run.id,
    nodeId: childId,
    memberId: worker.id,
    role: 'worker',
    allowedMemberIds: [worker.id],
  })
  const workerPayload = verifyHarnessNodeToken(workerToken)
  if (mode === 'success') {
    completeHarnessNode(workerPayload, childId, {
      request_id: `${suffix}-complete`,
      result: result(),
    })
    verifySubmittedHarnessNode(childId)
  } else if (mode === 'failed') {
    failHarnessNode(workerPayload, childId, {
      request_id: `${suffix}-fail`,
      reason: 'worker reported a blocking failure',
      category: 'contract',
      retryable: false,
    })
  }
  const child = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(childId)
  const resultEvent = db.prepare(`SELECT * FROM harness_events
    WHERE run_id=? AND from_node_id=? AND type IN ('member.task_completed','member.task_failed')
    ORDER BY seq DESC LIMIT 1`).get(snapshot.run.id, childId)
  return {
    fixture,
    snapshot,
    root,
    child,
    mainToken,
    mainPayload,
    workerToken,
    workerPayload,
    resultEvent,
  }
}

function deliverNotifications(runId) {
  db.prepare(`UPDATE harness_dispatches SET status='delivered',
    delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE run_id=? AND kind='message'`).run(runId)
}

function rootResult(prepared, base = result('root-delivery', 'Root synthesis'), manifest = {}) {
  const requiredEvents = db.prepare(`SELECT e.* FROM harness_events e
    JOIN harness_nodes n ON n.id=e.from_node_id AND n.run_id=e.run_id
    WHERE e.run_id=? AND e.to_node_id=? AND n.required=1
      AND e.type IN ('member.task_completed','member.task_failed')
    ORDER BY e.seq`).all(prepared.snapshot.run.id, prepared.root.id)
  const eventIds = requiredEvents.map((event) => event.event_id)
  const rootContract = JSON.parse(db.prepare('SELECT task_contract_json FROM harness_nodes WHERE id=?')
    .get(prepared.root.id).task_contract_json)
  const gapNodes = db.prepare(`SELECT id, status FROM harness_nodes
    WHERE run_id=? AND node_type!='root' AND status IN ('failed','cancelled','timed_out')`).all(
    prepared.snapshot.run.id,
  )
  return {
    ...base,
    schema_version: '1.2',
    outputs: [{
      kind: 'report',
      name: '最终结果',
      mime_type: 'text/markdown',
      content: '# Final synthesis\n\nVerified final result.',
    }],
    synthesis_manifest: {
      included_result_event_ids: eventIds,
      excluded_results: [],
      criterion_sources: rootContract.acceptance_criteria.map((criterion) => ({
        criterion_id: criterion.id,
        source_event_ids: eventIds,
      })),
      deduplication_keys: eventIds,
      conflicts: [],
      coverage_gaps: gapNodes.map((node) => `${node.id}: ${node.status} child left a coverage gap`),
      ...manifest,
    },
  }
}

function submitRoot(prepared, requestId, submittedResult) {
  const completion = completeHarnessNode(prepared.mainPayload, prepared.root.id, {
    request_id: requestId,
    result: submittedResult || rootResult(prepared),
  })
  if (completion.ok) verifySubmittedHarnessNode(prepared.root.id)
  return {
    completion,
    run: db.prepare('SELECT * FROM harness_runs WHERE id=?').get(prepared.snapshot.run.id),
    root: db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(prepared.root.id),
  }
}

async function main() {
  const app = express()
  app.use(express.json())
  app.use('/api/harness-internal', internalRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (url, token, body) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { response, body: await response.json() }
  }

  try {
    const api = prepareChild('ack_api')
    deliverNotifications(api.snapshot.run.id)
    const ackPath = `/api/harness-internal/runs/${api.snapshot.run.id}/result-events/${api.resultEvent.event_id}/ack`
    const first = await request(ackPath, api.mainToken, {
      request_id: 'ack-api-result-first',
      last_seen_seq: api.resultEvent.seq,
    })
    assert.equal(first.response.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.ok, true)
    assert.equal(first.body.data.child_node_id, api.child.id)
    assert.equal(first.body.data.result_event_id, api.resultEvent.event_id)

    const replay = await request(ackPath, api.mainToken, {
      request_id: 'ack-api-result-first',
      last_seen_seq: api.resultEvent.seq,
    })
    assert.equal(replay.response.status, 200)
    assert.equal(replay.body.replayed, true)

    const duplicate = await request(ackPath, api.mainToken, {
      request_id: 'ack-api-result-second',
      last_seen_seq: api.resultEvent.seq + 10,
    })
    assert.equal(duplicate.response.status, 200)
    assert.equal(duplicate.body.replayed, true)
    assert.equal(duplicate.body.data.last_seen_seq, api.resultEvent.seq)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM harness_events
      WHERE run_id=? AND type='member.task_result_acknowledged' AND causation_id=?`)
      .get(api.snapshot.run.id, api.resultEvent.event_id).count, 1)

    const subDenied = await request(ackPath, api.workerToken, {
      request_id: 'ack-api-sub-denied',
      last_seen_seq: api.resultEvent.seq,
    })
    assert.equal(subDenied.response.status, 403)
    assert.equal(subDenied.body.code, 'harness_action_forbidden')

    const nonRootMainToken = mintHarnessNodeToken({
      runId: api.snapshot.run.id,
      nodeId: api.child.id,
      memberId: api.child.assignee_member_id,
      role: 'main',
      allowedMemberIds: [api.child.assignee_member_id],
    })
    const nonRootDenied = await request(ackPath, nonRootMainToken, {
      request_id: 'ack-api-non-root-denied',
      last_seen_seq: api.resultEvent.seq,
    })
    assert.equal(nonRootDenied.response.status, 403)
    assert.equal(nonRootDenied.body.code, 'root_main_required')

    const other = prepareChild('ack_other')
    deliverNotifications(other.snapshot.run.id)
    const crossRun = await request(ackPath, other.mainToken, {
      request_id: 'ack-api-cross-run',
      last_seen_seq: api.resultEvent.seq,
    })
    assert.equal(crossRun.response.status, 403)
    assert.equal(crossRun.body.code, 'harness_scope_violation')

    const foreignEvent = await request(
      `/api/harness-internal/runs/${api.snapshot.run.id}/result-events/${other.resultEvent.event_id}/ack`,
      api.mainToken,
      { request_id: 'ack-api-foreign-event', last_seen_seq: 9999 },
    )
    assert.equal(foreignEvent.response.status, 404)
    assert.equal(foreignEvent.body.code, 'result_event_not_found')

    const progressEventId = appendHarnessEvent({
      runId: api.snapshot.run.id,
      type: 'node.progress',
      fromNodeId: api.child.id,
      toNodeId: api.root.id,
      payload: { message: 'not a terminal result' },
    })
    const progressAck = await request(
      `/api/harness-internal/runs/${api.snapshot.run.id}/result-events/${progressEventId}/ack`,
      api.mainToken,
      { request_id: 'ack-api-progress-event', last_seen_seq: 9999 },
    )
    assert.equal(progressAck.response.status, 400)
    assert.equal(progressAck.body.code, 'result_event_type_invalid')

    const wrongTargetEventId = appendHarnessEvent({
      runId: api.snapshot.run.id,
      type: 'member.task_completed',
      fromNodeId: api.child.id,
      toNodeId: api.child.id,
      payload: { node_id: api.child.id, result: null, reasons: [] },
    })
    const wrongTarget = await request(
      `/api/harness-internal/runs/${api.snapshot.run.id}/result-events/${wrongTargetEventId}/ack`,
      api.mainToken,
      { request_id: 'ack-api-wrong-target', last_seen_seq: 9999 },
    )
    assert.equal(wrongTarget.response.status, 403)
    assert.equal(wrongTarget.body.code, 'result_event_target_invalid')

    const invalidChildEventId = appendHarnessEvent({
      runId: api.snapshot.run.id,
      type: 'member.task_completed',
      fromNodeId: api.root.id,
      toNodeId: api.root.id,
      payload: { node_id: api.root.id, result: null, reasons: [] },
    })
    const invalidChild = await request(
      `/api/harness-internal/runs/${api.snapshot.run.id}/result-events/${invalidChildEventId}/ack`,
      api.mainToken,
      { request_id: 'ack-api-invalid-child', last_seen_seq: 9999 },
    )
    assert.equal(invalidChild.response.status, 400)
    assert.equal(invalidChild.body.code, 'result_event_child_invalid')

    const lowCursorRun = prepareChild('ack_low_cursor')
    deliverNotifications(lowCursorRun.snapshot.run.id)
    const lowCursor = await request(
      `/api/harness-internal/runs/${lowCursorRun.snapshot.run.id}/result-events/${lowCursorRun.resultEvent.event_id}/ack`,
      lowCursorRun.mainToken,
      { request_id: 'ack-api-low-cursor', last_seen_seq: lowCursorRun.resultEvent.seq - 1 },
    )
    assert.equal(lowCursor.response.status, 400)
    assert.equal(lowCursor.body.code, 'last_seen_seq_too_small')

    const missingManifest = prepareChild('finalize_manifest_missing')
    deliverNotifications(missingManifest.snapshot.run.id)
    acknowledgeHarnessResultEvent(
      missingManifest.mainPayload,
      missingManifest.snapshot.run.id,
      missingManifest.resultEvent.event_id,
      { request_id: 'finalize-manifest-missing-ack', last_seen_seq: missingManifest.resultEvent.seq },
    )
    const missingManifestResult = rootResult(missingManifest)
    delete missingManifestResult.synthesis_manifest
    const missingManifestFinal = submitRoot(
      missingManifest,
      'finalize-manifest-missing-root',
      missingManifestResult,
    )
    assert.equal(missingManifestFinal.completion.ok, false)
    assert.equal(missingManifestFinal.completion.rejected.code, 'finalize_not_ready')
    assert.ok(missingManifestFinal.completion.rejected.details.reasons.some(
      (reason) => reason.code === 'synthesis_manifest_missing',
    ))
    assert.equal(missingManifestFinal.root.status, 'running')
    assert.equal(missingManifestFinal.run.status, 'running')

    const missingMapping = prepareChild('finalize_manifest_mapping')
    deliverNotifications(missingMapping.snapshot.run.id)
    acknowledgeHarnessResultEvent(
      missingMapping.mainPayload,
      missingMapping.snapshot.run.id,
      missingMapping.resultEvent.event_id,
      { request_id: 'finalize-manifest-mapping-ack', last_seen_seq: missingMapping.resultEvent.seq },
    )
    const missingMappingFinal = submitRoot(
      missingMapping,
      'finalize-manifest-mapping-root',
      rootResult(missingMapping, undefined, { included_result_event_ids: [] }),
    )
    assert.equal(missingMappingFinal.completion.ok, false)
    assert.ok(missingMappingFinal.completion.rejected.details.reasons.some(
      (reason) => reason.code === 'synthesis_result_event_unmapped'
        && reason.result_event_id === missingMapping.resultEvent.event_id,
    ))
    assert.equal(missingMappingFinal.root.status, 'running')
    assert.equal(missingMappingFinal.run.status, 'running')

    const unresolvedConflict = prepareChild('finalize_manifest_conflict')
    deliverNotifications(unresolvedConflict.snapshot.run.id)
    acknowledgeHarnessResultEvent(
      unresolvedConflict.mainPayload,
      unresolvedConflict.snapshot.run.id,
      unresolvedConflict.resultEvent.event_id,
      { request_id: 'finalize-manifest-conflict-ack', last_seen_seq: unresolvedConflict.resultEvent.seq },
    )
    const unresolvedConflictFinal = submitRoot(
      unresolvedConflict,
      'finalize-manifest-conflict-root',
      rootResult(unresolvedConflict, undefined, {
        conflicts: [{
          source_event_ids: [unresolvedConflict.resultEvent.event_id],
          resolution: 'Conflicting evidence remains unresolved',
          unresolved: true,
        }],
      }),
    )
    assert.equal(unresolvedConflictFinal.completion.ok, false)
    assert.ok(unresolvedConflictFinal.completion.rejected.details.reasons.some(
      (reason) => reason.code === 'synthesis_conflict_unresolved_missing',
    ))
    assert.equal(unresolvedConflictFinal.root.status, 'running')
    assert.equal(unresolvedConflictFinal.run.status, 'running')

    const apiFinal = submitRoot(api, 'ack-api-root-complete')
    assert.equal(apiFinal.root.status, 'succeeded')
    assert.equal(apiFinal.run.status, 'completed')

    const unacked = prepareChild('finalize_unacked')
    deliverNotifications(unacked.snapshot.run.id)
    const unackedResponse = await request(
      `/api/harness-internal/nodes/${unacked.root.id}/complete`,
      unacked.mainToken,
      {
        request_id: 'finalize-unacked-root',
        result: rootResult(unacked),
      },
    )
    assert.equal(unackedResponse.response.status, 409)
    assert.equal(unackedResponse.body.rejected.code, 'finalize_not_ready')
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(unacked.root.id).status, 'running')
    assert.equal(db.prepare('SELECT status FROM harness_runs WHERE id=?').get(unacked.snapshot.run.id).status, 'running')
    assert.ok(unackedResponse.body.rejected.details.reasons.some(
      (reason) => reason.code === 'child_result_ack_missing'
        && reason.child_node_id === unacked.child.id
        && reason.result_event_id === unacked.resultEvent.event_id,
    ))
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM harness_events WHERE run_id=? AND request_id=?',
    ).get(unacked.snapshot.run.id, 'finalize-unacked-root').count, 0)
    acknowledgeHarnessResultEvent(
      unacked.mainPayload,
      unacked.snapshot.run.id,
      unacked.resultEvent.event_id,
      { request_id: 'finalize-unacked-ack', last_seen_seq: unacked.resultEvent.seq },
    )
    const unackedRetry = submitRoot(unacked, 'finalize-unacked-root-retry')
    assert.equal(unackedRetry.root.status, 'succeeded')
    assert.equal(unackedRetry.run.status, 'completed')

    const ackDisabled = prepareChild('finalize_ack_disabled')
    deliverNotifications(ackDisabled.snapshot.run.id)
    process.env.HARNESS_RESULT_ACK_REQUIRED = '0'
    const ackDisabledFinal = submitRoot(ackDisabled, 'finalize-ack-disabled-root')
    delete process.env.HARNESS_RESULT_ACK_REQUIRED
    assert.equal(ackDisabledFinal.root.status, 'succeeded')
    assert.equal(ackDisabledFinal.run.status, 'completed')

    const waivedUnacked = prepareChild('finalize_waived_unacked', 'failed')
    db.prepare(`UPDATE harness_nodes SET waived_at='2026-08-27T00:00:00.000Z',
      waived_by_user_id=?, waiver_reason='accepted worker failure' WHERE id=?`)
      .run(waivedUnacked.fixture.userId, waivedUnacked.child.id)
    deliverNotifications(waivedUnacked.snapshot.run.id)
    const waivedUnackedFinal = submitRoot(waivedUnacked, 'finalize-waived-unacked-root')
    assert.equal(waivedUnackedFinal.completion.ok, false)
    assert.equal(waivedUnackedFinal.completion.rejected.code, 'finalize_not_ready')
    assert.equal(waivedUnackedFinal.root.status, 'running')
    assert.equal(waivedUnackedFinal.run.status, 'running')
    acknowledgeHarnessResultEvent(
      waivedUnacked.mainPayload,
      waivedUnacked.snapshot.run.id,
      waivedUnacked.resultEvent.event_id,
      { request_id: 'finalize-waived-unacked-ack', last_seen_seq: waivedUnacked.resultEvent.seq },
    )
    const waivedUnackedRetry = submitRoot(waivedUnacked, 'finalize-waived-unacked-retry')
    assert.equal(waivedUnackedRetry.root.status, 'succeeded')
    assert.equal(waivedUnackedRetry.run.status, 'completed')

    const waivedAcked = prepareChild('finalize_waived_acked', 'failed')
    db.prepare(`UPDATE harness_nodes SET waived_at='2026-08-27T00:00:00.000Z',
      waived_by_user_id=?, waiver_reason='accepted worker failure' WHERE id=?`)
      .run(waivedAcked.fixture.userId, waivedAcked.child.id)
    deliverNotifications(waivedAcked.snapshot.run.id)
    acknowledgeHarnessResultEvent(
      waivedAcked.mainPayload,
      waivedAcked.snapshot.run.id,
      waivedAcked.resultEvent.event_id,
      { request_id: 'finalize-waived-ack', last_seen_seq: waivedAcked.resultEvent.seq },
    )
    const waivedAckedFinal = submitRoot(waivedAcked, 'finalize-waived-acked-root')
    assert.equal(waivedAckedFinal.root.status, 'succeeded')
    assert.equal(waivedAckedFinal.run.status, 'completed')

    const pending = prepareChild('finalize_pending')
    acknowledgeHarnessResultEvent(
      pending.mainPayload,
      pending.snapshot.run.id,
      pending.resultEvent.event_id,
      { request_id: 'finalize-pending-ack', last_seen_seq: pending.resultEvent.seq },
    )
    const pendingFinal = submitRoot(pending, 'finalize-pending-root')
    assert.equal(pendingFinal.completion.ok, false)
    assert.equal(pendingFinal.completion.rejected.code, 'finalize_not_ready')
    assert.equal(pendingFinal.root.status, 'running')
    assert.equal(pendingFinal.run.status, 'running')
    assert.ok(pendingFinal.completion.rejected.details.reasons.some(
      (reason) => reason.code === 'dispatch_pending' && reason.status === 'queued',
    ))
    deliverNotifications(pending.snapshot.run.id)
    const pendingRetry = submitRoot(pending, 'finalize-pending-root-retry')
    assert.equal(pendingRetry.root.status, 'succeeded')
    assert.equal(pendingRetry.run.status, 'completed')

    const active = prepareChild('finalize_active', 'active')
    db.prepare('UPDATE harness_nodes SET required=0 WHERE id=?').run(active.child.id)
    db.prepare("UPDATE harness_dispatches SET status='delivered' WHERE run_id=?").run(active.snapshot.run.id)
    const activeFinal = submitRoot(active, 'finalize-active-root')
    assert.equal(activeFinal.completion.ok, false)
    assert.equal(activeFinal.completion.rejected.code, 'finalize_not_ready')
    assert.equal(activeFinal.root.status, 'running')
    assert.equal(activeFinal.run.status, 'running')
    assert.ok(activeFinal.completion.rejected.details.reasons.some(
      (reason) => reason.code === 'active_sub'
        && reason.child_node_id === active.child.id
        && reason.status === 'running',
    ))
    db.prepare("UPDATE harness_nodes SET status='succeeded' WHERE id=?").run(active.child.id)
    const activeRetry = submitRoot(active, 'finalize-active-root-retry')
    assert.equal(activeRetry.root.status, 'succeeded')
    assert.equal(activeRetry.run.status, 'completed')

    const invalidResult = prepareChild('finalize_invalid_result')
    deliverNotifications(invalidResult.snapshot.run.id)
    acknowledgeHarnessResultEvent(
      invalidResult.mainPayload,
      invalidResult.snapshot.run.id,
      invalidResult.resultEvent.event_id,
      { request_id: 'finalize-invalid-result-ack', last_seen_seq: invalidResult.resultEvent.seq },
    )
    const invalidRootResult = rootResult(
      invalidResult,
      result('unknown-root-criterion', 'Invalid root synthesis'),
    )
    const invalidFinal = submitRoot(
      invalidResult,
      'finalize-invalid-result-root',
      invalidRootResult,
    )
    assert.equal(invalidFinal.completion.ok, true)
    assert.equal(invalidFinal.root.status, 'failed')
    assert.equal(invalidFinal.run.status, 'failed')
    assert.match(invalidFinal.root.failure_json, /结果包含合同外验收项/)

    const raced = prepareChild('finalize_race')
    deliverNotifications(raced.snapshot.run.id)
    acknowledgeHarnessResultEvent(
      raced.mainPayload,
      raced.snapshot.run.id,
      raced.resultEvent.event_id,
      { request_id: 'finalize-race-ack', last_seen_seq: raced.resultEvent.seq },
    )
    const raceSubmission = completeHarnessNode(raced.mainPayload, raced.root.id, {
      request_id: 'finalize-race-root',
      result: rootResult(raced, result('root-delivery', 'Race-safe synthesis')),
    })
    assert.equal(raceSubmission.ok, true)
    db.prepare(`UPDATE harness_dispatches SET status='queued', delivered_at=NULL
      WHERE run_id=? AND kind='message'`).run(raced.snapshot.run.id)
    verifySubmittedHarnessNode(raced.root.id)
    const racedRoot = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(raced.root.id)
    const racedRun = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(raced.snapshot.run.id)
    assert.equal(racedRoot.status, 'running')
    assert.equal(racedRun.status, 'running')
    assert.equal(racedRoot.result_json, null)
    const raceEvent = db.prepare(`SELECT * FROM harness_events
      WHERE run_id=? AND type='node.finalize_not_ready' ORDER BY seq DESC LIMIT 1`)
      .get(raced.snapshot.run.id)
    assert.ok(raceEvent)
    assert.equal(JSON.parse(raceEvent.payload_json).retry_requires_new_request_id, true)
    deliverNotifications(raced.snapshot.run.id)
    const raceRetry = submitRoot(raced, 'finalize-race-root-retry')
    assert.equal(raceRetry.root.status, 'succeeded')
    assert.equal(raceRetry.run.status, 'completed')

    console.log('harness result ACK and finalize gate tests passed')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    cleanup(fs, db, tempRoot)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
