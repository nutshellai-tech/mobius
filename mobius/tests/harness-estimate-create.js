const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-estimate-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')

const { db } = require('../db')
const { setup, rosterRequest, cleanup } = require('./harness/phase1-fixture')
const { resolveRoster, createHarnessRun, getHarnessRunSnapshot } = require('../backend/repositories/harness')
const { estimateHarnessRun } = require('../backend/services/harness-estimator')

try {
  const fixture = setup(db, tempRoot, 'estimate')
  const draft = {
    ...rosterRequest(fixture, 'multi'),
    excluded_skill_ids: ['skill-disabled'],
    excluded_memory_ids: ['memory-disabled'],
  }
  const roster = resolveRoster(fixture.userId, fixture.projectId, draft)
  const estimate = estimateHarnessRun(fixture.userId, draft, roster.map((member) => ({ id: member.profile.id, definition: member.profile.definition })))
  assert.ok(estimate.estimate_id)
  assert.deepEqual(estimate.estimated_cost_usd_range.length, 2)
  assert.throws(
    () => createHarnessRun(fixture.userId, fixture.projectId, { ...draft, request_id: 'create-no-estimate' }),
    (error) => error.code === 'estimate_required',
  )
  const request = {
    ...draft,
    request_id: 'create-with-estimate',
    acknowledged_estimate: {
      estimate_id: estimate.estimate_id,
      shown_cost_usd_range: estimate.estimated_cost_usd_range,
    },
  }
  const first = createHarnessRun(fixture.userId, fixture.projectId, request)
  const replay = createHarnessRun(fixture.userId, fixture.projectId, request)
  assert.equal(first.run.id, replay.run.id)
  assert.equal(first.members.length, 2)
  assert.equal(first.nodes.length, 1)
  assert.equal(first.dispatches.length, 1)
  assert.deepEqual(JSON.parse(first.run.excluded_skill_ids), draft.excluded_skill_ids)
  assert.deepEqual(JSON.parse(first.run.excluded_memory_ids), draft.excluded_memory_ids)
  assert.equal(getHarnessRunSnapshot(first.run.id).members[0].config_snapshot.profile_version, 1)
  assert.throws(
    () => createHarnessRun(fixture.userId, fixture.projectId, {
      ...request,
      request_id: 'changed-roster',
      goal: `${request.goal} changed`,
    }),
    (error) => error.code === 'estimate_mismatch',
  )
  assert.throws(
    () => createHarnessRun(fixture.userId, fixture.projectId, {
      ...request,
      request_id: 'changed-context-selection',
      excluded_skill_ids: ['different-skill'],
    }),
    (error) => error.code === 'estimate_mismatch',
  )
  const originalPolicy = db.prepare('SELECT policy_json FROM harness_runs WHERE id=?').get(first.run.id).policy_json
  db.prepare("UPDATE harness_runs SET policy_json='[]' WHERE id=?").run(first.run.id)
  assert.throws(
    () => getHarnessRunSnapshot(first.run.id),
    (error) => error.code === 'invalid_harness_schema',
  )
  db.prepare('UPDATE harness_runs SET policy_json=? WHERE id=?').run(originalPolicy, first.run.id)
  const createdEvent = db.prepare("SELECT event_id, payload_json FROM harness_events WHERE run_id=? AND type='run.created'").get(first.run.id)
  const malformedCreatedPayload = JSON.parse(createdEvent.payload_json)
  malformedCreatedPayload.acknowledged_estimate.cost_range = ['not-a-number', 1]
  db.prepare('UPDATE harness_events SET payload_json=? WHERE event_id=?').run(JSON.stringify(malformedCreatedPayload), createdEvent.event_id)
  assert.throws(
    () => getHarnessRunSnapshot(first.run.id),
    (error) => error.code === 'invalid_harness_schema',
  )
  db.prepare('UPDATE harness_events SET payload_json=? WHERE event_id=?').run(createdEvent.payload_json, createdEvent.event_id)

  const repeatedProfileDraft = {
    ...rosterRequest(fixture, 'multi'),
    goal: 'Run two independent agents with the same model profile.',
    roster: {
      main_member_key: 'sol-main',
      members: [
        { member_key: 'sol-main', profile_id: 'system-codex-readonly-v1' },
        { member_key: 'sol-worker', profile_id: 'system-codex-readonly-v1', purpose: 'worker' },
      ],
    },
  }
  const repeatedRoster = resolveRoster(fixture.userId, fixture.projectId, repeatedProfileDraft)
  assert.equal(repeatedRoster.length, 2)
  assert.throws(
    () => resolveRoster(fixture.userId, fixture.projectId, {
      ...repeatedProfileDraft,
      roster: {
        main_member_key: 'duplicate',
        members: [
          { member_key: 'duplicate', profile_id: 'system-codex-readonly-v1' },
          { member_key: 'duplicate', profile_id: 'system-codex-readonly-v1', purpose: 'worker' },
        ],
      },
    }),
    (error) => error.code === 'duplicate_member_key',
  )
  const repeatedEstimate = estimateHarnessRun(
    fixture.userId,
    repeatedProfileDraft,
    repeatedRoster.map((member) => ({ id: member.profile.id, definition: member.profile.definition })),
  )
  const repeatedRun = createHarnessRun(fixture.userId, fixture.projectId, {
    ...repeatedProfileDraft,
    request_id: 'create-repeated-profile',
    acknowledged_estimate: {
      estimate_id: repeatedEstimate.estimate_id,
      shown_cost_usd_range: repeatedEstimate.estimated_cost_usd_range,
    },
  })
  assert.deepEqual(repeatedRun.members.map((member) => member.profile_id), [
    'system-codex-readonly-v1',
    'system-codex-readonly-v1',
  ])
  assert.deepEqual(repeatedRun.members.map((member) => member.display_name), [
    'Codex Read-only #1',
    'Codex Read-only #2',
  ])
  console.log('harness Phase 1 estimate/create tests passed')
} finally {
  cleanup(fs, db, tempRoot)
}
