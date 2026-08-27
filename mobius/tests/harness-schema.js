const assert = require('assert')
const {
  HarnessSchemaError,
  assertNoLethalTrifecta,
  harnessNodeResultDeliverableReasons,
  parseHarnessCreateRunRequest,
  parseHarnessEstimateRequest,
  parseHarnessInternalComplete,
  parseHarnessInternalCreateNodeBatch,
  parseHarnessInternalCreateTask,
  parseHarnessInternalFail,
  parseHarnessInternalProgress,
  parseHarnessInternalResultAck,
  parseHarnessNodeResult,
  parseHarnessProfile,
  parseHarnessRunPolicy,
  parseHarnessTaskContract,
} = require('../backend/services/harness-schema')
const { MAX_HARNESS_AGENTS } = require('../backend/types/harness')
const { contract, result, resultV12 } = require('./harness/phase1-fixture')

function assertRequestIdValidation(parser, validValue) {
  assert.doesNotThrow(() => parser(validValue))
  const missing = { ...validValue }
  delete missing.request_id
  assert.throws(() => parser(missing), HarnessSchemaError)
  assert.throws(() => parser({ ...validValue, request_id: 'short' }), HarnessSchemaError)
  assert.throws(() => parser({ ...validValue, request_id: 'invalid request id' }), HarnessSchemaError)
}

const deepseek = parseHarnessProfile({
  schema_version: '1.1',
  backend: 'deepseek-harness',
  model: 'deepseek-harness:test',
  capabilities: {
    can_main: true, can_work: true, can_evaluate: true, supports_write: false,
    supports_network: false, supports_runtime_verification: false, max_concurrency: 1,
  },
  model_traits: { needs_context_reset: false, context_window_tokens: 64000, supports_auto_compaction: false },
  skills: [],
  tools: { allow: [], deny: [], capability_tags: [] },
  cost_profile: { relative_cost_factor: 0.8 },
  default_context_policy: {},
  default_tool_policy: {},
})
assert.equal(deepseek.backend, 'deepseek-harness')
const rosterLimitRequest = {
  anchor_type: 'issue',
  issue_id: 'issue-roster-limit',
  goal: 'Validate the maximum Harness roster size',
  execution_mode: 'multi',
  roster: {
    main_member_key: 'member_1',
    members: Array.from({ length: MAX_HARNESS_AGENTS }, (_, index) => ({
      member_key: `member_${index + 1}`,
      profile_id: `profile-${index + 1}`,
      ...(index > 0 ? { purpose: 'worker' } : {}),
    })),
  },
}
assert.doesNotThrow(() => parseHarnessEstimateRequest(rosterLimitRequest))
assert.throws(
  () => parseHarnessEstimateRequest({
    ...rosterLimitRequest,
    roster: {
      ...rosterLimitRequest.roster,
      members: [...rosterLimitRequest.roster.members, {
        member_key: 'member_6',
        profile_id: 'profile-6',
        purpose: 'worker',
      }],
    },
  }),
  HarnessSchemaError,
)
assert.equal(parseHarnessTaskContract(contract()).workspace.mode, 'read_only')
const parallelContract = {
  ...contract(),
  schema_version: '1.2',
  parallelism: {
    mode: 'parallel_safe',
    independence_key: 'code-area:backend',
    reason: 'Reads an independent backend scope.',
    estimated_duration_seconds: 300,
    read_scopes: ['backend/**'],
    mutable_resources: [],
    failure_policy: 'continue_siblings',
  },
}
assert.equal(parseHarnessTaskContract(parallelContract).parallelism.mode, 'parallel_safe')
const adaptivePolicy = {
  schema_version: '1.1',
  topology_selection_mode: 'explicit',
  collaboration_shape: 'adaptive',
  max_concurrent_subharnesses: 2,
  parallel_read_only_only: true,
  max_depth: 1,
  max_nodes: 5,
  default_timeout_seconds: 1800,
  workspace_policy: 'read_only',
  evaluator_policy: 'by_risk',
  context_reset_policy: 'off',
  cost_soft_limit_usd: 2,
  cost_hard_limit_usd: 5,
}
assert.equal(parseHarnessRunPolicy(adaptivePolicy).collaboration_shape, 'adaptive')
assert.throws(
  () => parseHarnessRunPolicy({ ...adaptivePolicy, collaboration_shape: 'pipeline', max_concurrent_subharnesses: 2 }),
  HarnessSchemaError,
)
assert.doesNotThrow(() => parseHarnessInternalCreateNodeBatch({
  request_id: 'schema-batch-request',
  nodes: [{ client_ref: 'backend', assignee_member_id: 'member-backend', task_contract: parallelContract }],
}))
assert.throws(() => parseHarnessTaskContract({ ...contract(), workspace: { mode: 'isolated_worktree' } }), HarnessSchemaError)
assert.doesNotThrow(() => assertNoLethalTrifecta(['private_data_read', 'untrusted_ingest']))
assert.throws(
  () => assertNoLethalTrifecta(['private_data_read', 'untrusted_ingest', 'outbound_network']),
  /不能同时拥有/,
)
assertRequestIdValidation(parseHarnessCreateRunRequest, {
  anchor_type: 'issue',
  issue_id: 'issue-schema',
  goal: 'Validate request ids',
  execution_mode: 'single',
  roster: {
    main_member_key: 'main',
    members: [{ member_key: 'main', profile_id: 'system-codex-readonly-v1' }],
  },
  request_id: 'schema-create-request',
})
const namedRun = parseHarnessCreateRunRequest({
  anchor_type: 'issue',
  issue_id: 'issue-schema',
  session_name: 'Review deployment readiness',
  language: 'en',
  excluded_skill_ids: ['skill-disabled'],
  excluded_memory_ids: ['memory-disabled'],
  goal: 'Validate session metadata',
  execution_mode: 'single',
  roster: {
    main_member_key: 'main',
    members: [{ member_key: 'main', profile_id: 'system-codex-readonly-v1' }],
  },
  request_id: 'schema-named-create',
})
assert.equal(namedRun.session_name, 'Review deployment readiness')
assert.equal(namedRun.language, 'en')
assert.deepEqual(namedRun.excluded_skill_ids, ['skill-disabled'])
assert.deepEqual(namedRun.excluded_memory_ids, ['memory-disabled'])
assert.throws(() => parseHarnessCreateRunRequest({ ...namedRun, language: 'fr' }), HarnessSchemaError)
assert.throws(() => parseHarnessCreateRunRequest({ ...namedRun, excluded_skill_ids: ['duplicate', 'duplicate'] }), HarnessSchemaError)
assertRequestIdValidation(parseHarnessInternalCreateTask, {
  request_id: 'schema-task-request',
  assignee_member_id: 'member-schema',
  task_contract: contract(),
})
assertRequestIdValidation(parseHarnessInternalProgress, {
  request_id: 'schema-progress-request',
  message: 'Validated progress',
})
assertRequestIdValidation(parseHarnessInternalComplete, {
  request_id: 'schema-complete-request',
  result: result(),
})
assert.doesNotThrow(() => parseHarnessNodeResult(result()), 'stored Result 1.1 remains supported')
const reportResult = resultV12()
assert.deepEqual(parseHarnessNodeResult(reportResult), reportResult)
const synthesisResult = {
  ...reportResult,
  synthesis_manifest: {
    included_result_event_ids: ['event-one'],
    excluded_results: [{ event_id: 'event-two', reason: 'Superseded by event-one' }],
    criterion_sources: [{ criterion_id: 'facts', source_event_ids: ['event-one'] }],
    deduplication_keys: ['event-one'],
    conflicts: [{ source_event_ids: ['event-one', 'event-two'], resolution: 'Use newer evidence', unresolved: false }],
    coverage_gaps: [],
  },
}
assert.deepEqual(parseHarnessNodeResult(synthesisResult), synthesisResult)
assert.throws(
  () => parseHarnessNodeResult({
    ...synthesisResult,
    synthesis_manifest: { ...synthesisResult.synthesis_manifest, coverage_gaps: undefined },
  }),
  HarnessSchemaError,
  'malformed synthesis manifest remains an invalid Result Contract shape',
)
const structuredResult = resultV12('facts', 'Structured findings', [{
  kind: 'structured_data',
  name: 'facts-json',
  mime_type: 'application/json',
  content: JSON.stringify({ facts: ['one', 'two'] }),
}])
assert.deepEqual(parseHarnessNodeResult(structuredResult), structuredResult)
assert.deepEqual(
  harnessNodeResultDeliverableReasons(reportResult, contract()),
  [],
)
assert.match(
  harnessNodeResultDeliverableReasons(
    { ...reportResult, outputs: [] },
    contract(),
  )[0],
  /缺少必需交付物 output: findings/,
)
assert.match(
  harnessNodeResultDeliverableReasons(
    { ...reportResult, outputs: [{ ...reportResult.outputs[0], kind: 'structured_data', mime_type: 'application/json', content: '{}' }] },
    contract(),
  )[0],
  /output 类型不匹配/,
)
assert.deepEqual(
  harnessNodeResultDeliverableReasons(result(), contract()),
  [],
  'stored Result 1.1 keeps its existing deliverable verification semantics',
)
assert.throws(
  () => parseHarnessNodeResult({ ...reportResult, outputs: [...reportResult.outputs, { ...reportResult.outputs[0] }] }),
  HarnessSchemaError,
)
assert.throws(
  () => parseHarnessNodeResult({
    ...structuredResult,
    outputs: [{ ...structuredResult.outputs[0], content: '{not-json}' }],
  }),
  HarnessSchemaError,
)
assert.throws(
  () => parseHarnessNodeResult({
    ...reportResult,
    outputs: [{ ...reportResult.outputs[0], content: 'x'.repeat((128 * 1024) + 1) }],
  }),
  HarnessSchemaError,
)
assert.throws(
  () => parseHarnessNodeResult({
    ...reportResult,
    outputs: [
      { ...reportResult.outputs[0], name: 'first', content: 'x'.repeat(128 * 1024) },
      { ...reportResult.outputs[0], name: 'second', content: 'y'.repeat(128 * 1024) },
    ],
  }),
  HarnessSchemaError,
)
assert.throws(
  () => parseHarnessNodeResult({ ...reportResult, unknown: true }),
  HarnessSchemaError,
)
assertRequestIdValidation(parseHarnessInternalFail, {
  request_id: 'schema-failure-request',
  reason: 'Validated failure',
})
assertRequestIdValidation(parseHarnessInternalResultAck, {
  request_id: 'schema-result-ack',
  last_seen_seq: 12,
})
assert.throws(
  () => parseHarnessInternalResultAck({ request_id: 'schema-result-ack', last_seen_seq: 1.5 }),
  HarnessSchemaError,
)
console.log('harness Phase 1 schema tests passed')
