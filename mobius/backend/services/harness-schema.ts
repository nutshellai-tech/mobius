import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { MAX_HARNESS_AGENTS } from '../types/harness';
import type {
  HarnessCreateRunRequestV1,
  HarnessEstimateRequestV1,
  HarnessNodeBatchRequestV1,
  HarnessNodeResult,
  HarnessProfileDefinitionV1,
  HarnessResultAckRequestV1,
  HarnessRunCreatedEventPayloadV1,
  HarnessRunPolicyV1,
  HarnessTaskContractV1,
} from '../types/harness';

const ajv = new Ajv({ allErrors: true, strict: true });
const capabilityTag = { enum: ['private_data_read', 'untrusted_ingest', 'outbound_network'] } as const;
const stringArray = { type: 'array', items: { type: 'string' } } as const;

const profileSchema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'backend', 'model', 'capabilities', 'model_traits', 'skills', 'tools', 'cost_profile', 'default_context_policy', 'default_tool_policy'],
  properties: {
    schema_version: { const: '1.1' },
    backend: { enum: ['codex', 'claude-code', 'deepseek-harness'] },
    model: { type: 'string', minLength: 1 },
    capabilities: {
      type: 'object', additionalProperties: false,
      required: ['can_main', 'can_work', 'can_evaluate', 'supports_write', 'supports_network', 'supports_runtime_verification', 'max_concurrency'],
      properties: {
        can_main: { type: 'boolean' }, can_work: { type: 'boolean' }, can_evaluate: { type: 'boolean' },
        supports_write: { type: 'boolean' }, supports_network: { type: 'boolean' },
        supports_runtime_verification: { type: 'boolean' }, max_concurrency: { type: 'integer', minimum: 1, maximum: 64 },
      },
    },
    model_traits: {
      type: 'object', additionalProperties: false,
      required: ['needs_context_reset', 'context_window_tokens', 'supports_auto_compaction'],
      properties: {
        needs_context_reset: { type: 'boolean' }, context_window_tokens: { type: 'integer', minimum: 0 },
        supports_auto_compaction: { type: 'boolean' }, calibrated: { type: 'boolean' },
      },
    },
    skills: stringArray,
    tools: {
      type: 'object', additionalProperties: false, required: ['allow', 'deny', 'capability_tags'],
      properties: { allow: stringArray, deny: stringArray, capability_tags: { type: 'array', uniqueItems: true, items: capabilityTag } },
    },
    cost_profile: { type: 'object', additionalProperties: false, required: ['relative_cost_factor'], properties: { relative_cost_factor: { type: 'number', exclusiveMinimum: 0 } } },
    default_context_policy: { type: 'object' }, default_tool_policy: { type: 'object' },
  },
} as const;

const rosterMember = {
  type: 'object', additionalProperties: false, required: ['member_key', 'profile_id'],
  properties: {
    member_key: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
    profile_id: { type: 'string', minLength: 1, maxLength: 128 },
    purpose: { enum: ['worker', 'evaluator'] },
  },
} as const;

const estimateSchema = {
  type: 'object', additionalProperties: false,
  required: ['anchor_type', 'issue_id', 'goal', 'execution_mode', 'roster'],
  properties: {
    anchor_type: { const: 'issue' }, issue_id: { type: 'string', minLength: 1, maxLength: 128 },
    session_name: { type: 'string', minLength: 1, maxLength: 500 }, language: { enum: ['zh', 'en'] },
    excluded_skill_ids: { ...stringArray, uniqueItems: true, maxItems: 512 },
    excluded_memory_ids: { ...stringArray, uniqueItems: true, maxItems: 512 },
    goal: { type: 'string', minLength: 1, maxLength: 12000 }, execution_mode: { enum: ['single', 'multi'] },
    roster: {
      type: 'object', additionalProperties: false, required: ['main_member_key', 'members'],
      properties: {
        main_member_key: { type: 'string', minLength: 1, maxLength: 32 },
        members: { type: 'array', minItems: 1, maxItems: MAX_HARNESS_AGENTS, items: rosterMember },
        auto_expand: { type: 'boolean' },
      },
    },
    policy: { type: 'object' },
  },
} as const;

const createSchema = {
  ...estimateSchema,
  required: [...estimateSchema.required, 'request_id'],
  properties: {
    ...estimateSchema.properties,
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    acknowledged_estimate: {
      type: 'object', additionalProperties: false, required: ['estimate_id', 'shown_cost_usd_range'],
      properties: {
        estimate_id: { type: 'string', minLength: 8, maxLength: 4096 },
        shown_cost_usd_range: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
      },
    },
  },
} as const;

const criterionSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'description', 'verification', 'required'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 }, description: { type: 'string', minLength: 1, maxLength: 2000 },
    verification: { enum: ['deterministic', 'runtime_check', 'evaluator', 'parent_review'] }, required: { type: 'boolean' },
    threshold: { type: 'number', minimum: 0, maximum: 1 }, weight: { type: 'number', exclusiveMinimum: 0 },
    check: {
      type: 'object', additionalProperties: false, minProperties: 1,
      properties: { command: { type: 'string', minLength: 1 }, expect_exit_code: { type: 'integer' }, expect_artifact_kind: { type: 'string', minLength: 1 } },
    },
  },
  allOf: [
    {
      if: { properties: { verification: { enum: ['deterministic', 'runtime_check'] } }, required: ['verification'] },
      then: { properties: { check: {} }, required: ['check'] },
    },
    {
      if: { properties: { verification: { enum: ['runtime_check', 'evaluator'] } }, required: ['verification'] },
      then: { properties: { threshold: {} }, required: ['threshold'] },
    },
  ],
} as const;

const toolPolicySchema = {
  type: 'object', additionalProperties: false, required: ['profile', 'capability_tags'],
  properties: {
    profile: { enum: ['research', 'coding', 'review', 'custom'] },
    allow: stringArray,
    deny: stringArray,
    capability_tags: { type: 'array', uniqueItems: true, items: capabilityTag },
  },
} as const;

const taskContractBaseProperties = {
  objective: { type: 'string', minLength: 1, maxLength: 12000 }, risk_level: { enum: ['low', 'medium', 'high'] },
  acceptance_criteria: { type: 'array', minItems: 1, items: criterionSchema },
  inputs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'ref', 'trust'], properties: { kind: { enum: ['artifact', 'file', 'session', 'research', 'url', 'text'] }, ref: { type: 'string' }, description: { type: 'string' }, trust: { enum: ['instruction', 'data_only'] } } } },
  deliverables: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'name', 'required'], properties: { kind: { enum: ['report', 'patch', 'commit', 'file', 'test_result', 'structured_data'] }, name: { type: 'string', minLength: 1 }, required: { type: 'boolean' } } } },
  dependencies: { ...stringArray, uniqueItems: true },
  workspace: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'read_only' }, allowed_paths: stringArray } },
  tools: toolPolicySchema,
  budget: { type: 'object', additionalProperties: false, required: ['timeout_seconds'], properties: { timeout_seconds: { type: 'integer', minimum: 30, maximum: 86400 }, max_turns: { type: 'integer', minimum: 1 }, max_cost_usd: { type: 'number', exclusiveMinimum: 0 }, max_attempts: { type: 'integer', minimum: 1, maximum: 3 } } },
  communication: { type: 'object', additionalProperties: false, required: ['parent_only'], properties: { parent_only: { const: true }, progress_interval_seconds: { type: 'integer', minimum: 5 } } },
} as const;

const taskContractV1_1Schema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'objective', 'risk_level', 'acceptance_criteria', 'inputs', 'deliverables', 'dependencies', 'workspace', 'tools', 'budget', 'communication'],
  properties: {
    schema_version: { const: '1.1' },
    ...taskContractBaseProperties,
  },
} as const;

const taskContractV1_2Schema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'objective', 'risk_level', 'acceptance_criteria', 'inputs', 'deliverables', 'dependencies', 'workspace', 'tools', 'budget', 'communication'],
  properties: {
    schema_version: { const: '1.2' },
    ...taskContractBaseProperties,
    parallelism: {
      type: 'object', additionalProperties: false, required: ['mode'],
      properties: {
        mode: { enum: ['serial', 'parallel_safe'] },
        independence_key: { type: 'string', minLength: 1, maxLength: 256 },
        reason: { type: 'string', minLength: 1, maxLength: 2000 },
        estimated_duration_seconds: { type: 'integer', minimum: 1, maximum: 86400 },
        read_scopes: { ...stringArray, uniqueItems: true, maxItems: 128 },
        mutable_resources: { ...stringArray, uniqueItems: true, maxItems: 128 },
        aggregation_key: { type: 'string', minLength: 1, maxLength: 256 },
        expected_output_size_bytes: { type: 'integer', minimum: 0, maximum: 262144 },
        failure_policy: { enum: ['continue_siblings', 'stop_group'] },
      },
    },
  },
} as const;

const taskContractSchema = { anyOf: [taskContractV1_1Schema, taskContractV1_2Schema] } as const;

const resultBaseProperties = {
  status: { enum: ['succeeded', 'failed', 'partial'] }, summary: { type: 'string', minLength: 1 },
  acceptance_results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['criterion_id', 'score', 'evidence_artifact_ids'], properties: { criterion_id: { type: 'string', minLength: 1 }, score: { type: 'number', minimum: 0, maximum: 1 }, evidence_artifact_ids: stringArray, detail: { type: 'string' } } } },
  artifact_ids: stringArray,
  tests: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['status'], properties: { command: { type: 'string' }, status: { enum: ['passed', 'failed', 'not_run'] }, artifact_id: { type: 'string' }, detail: { type: 'string' } } } },
  risks: stringArray, unresolved: stringArray, recommended_followups: stringArray,
} as const;

const resultV1_1Schema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'status', 'summary', 'acceptance_results', 'artifact_ids', 'tests', 'risks', 'unresolved', 'recommended_followups'],
  properties: {
    schema_version: { const: '1.1' },
    ...resultBaseProperties,
  },
} as const;

const synthesisManifestSchema = {
  type: 'object', additionalProperties: false,
  required: ['included_result_event_ids', 'excluded_results', 'criterion_sources', 'deduplication_keys', 'conflicts', 'coverage_gaps'],
  properties: {
    included_result_event_ids: { ...stringArray, uniqueItems: true },
    excluded_results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['event_id', 'reason'],
        properties: {
          event_id: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
    criterion_sources: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['criterion_id', 'source_event_ids'],
        properties: {
          criterion_id: { type: 'string', minLength: 1 },
          source_event_ids: { ...stringArray, uniqueItems: true },
        },
      },
    },
    deduplication_keys: { ...stringArray, uniqueItems: true },
    conflicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['source_event_ids', 'resolution', 'unresolved'],
        properties: {
          source_event_ids: { ...stringArray, uniqueItems: true },
          resolution: { type: 'string', minLength: 1 },
          unresolved: { type: 'boolean' },
        },
      },
    },
    coverage_gaps: stringArray,
  },
} as const;

const resultV1_2Schema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'status', 'summary', 'acceptance_results', 'artifact_ids', 'tests', 'risks', 'unresolved', 'recommended_followups', 'outputs'],
  properties: {
    schema_version: { const: '1.2' },
    ...resultBaseProperties,
    outputs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'name', 'mime_type', 'content'],
        properties: {
          kind: { enum: ['report', 'structured_data'] },
          name: { type: 'string', minLength: 1, maxLength: 256 },
          mime_type: { enum: ['text/markdown', 'application/json'] },
          content: { type: 'string' },
        },
      },
    },
    synthesis_manifest: synthesisManifestSchema,
  },
} as const;

const resultSchema = { anyOf: [resultV1_1Schema, resultV1_2Schema] } as const;

const runPolicyV1_0Schema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'collaboration_shape', 'max_concurrent_subharnesses', 'max_depth', 'max_nodes', 'default_timeout_seconds', 'workspace_policy', 'evaluator_policy', 'context_reset_policy', 'cost_soft_limit_usd', 'cost_hard_limit_usd'],
  properties: {
    schema_version: { const: '1.0' }, collaboration_shape: { const: 'pipeline' }, max_concurrent_subharnesses: { const: 1 },
    max_depth: { enum: [0, 1] }, max_nodes: { type: 'integer', minimum: 1, maximum: MAX_HARNESS_AGENTS },
    default_timeout_seconds: { type: 'integer', minimum: 60, maximum: 3600 }, workspace_policy: { const: 'read_only' },
    evaluator_policy: { enum: ['by_risk', 'always', 'off'] }, context_reset_policy: { const: 'off' },
    cost_soft_limit_usd: { type: 'number', minimum: 0 }, cost_hard_limit_usd: { type: 'number', exclusiveMinimum: 0 },
  },
} as const;

const runPolicyV1_1Schema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'topology_selection_mode', 'collaboration_shape', 'max_concurrent_subharnesses', 'parallel_read_only_only', 'max_depth', 'max_nodes', 'default_timeout_seconds', 'workspace_policy', 'evaluator_policy', 'context_reset_policy', 'cost_soft_limit_usd', 'cost_hard_limit_usd'],
  properties: {
    schema_version: { const: '1.1' },
    topology_selection_mode: { enum: ['explicit', 'recommend', 'auto_safe'] },
    collaboration_shape: { enum: ['pipeline', 'adaptive', 'fanout'] },
    max_concurrent_subharnesses: { type: 'integer', minimum: 1, maximum: 4 },
    parallel_read_only_only: { const: true },
    max_depth: { enum: [0, 1] }, max_nodes: { type: 'integer', minimum: 1, maximum: MAX_HARNESS_AGENTS },
    default_timeout_seconds: { type: 'integer', minimum: 60, maximum: 3600 }, workspace_policy: { const: 'read_only' },
    evaluator_policy: { enum: ['by_risk', 'always', 'off'] }, context_reset_policy: { const: 'off' },
    cost_soft_limit_usd: { type: 'number', minimum: 0 }, cost_hard_limit_usd: { type: 'number', exclusiveMinimum: 0 },
  },
  allOf: [{
    if: { properties: { collaboration_shape: { const: 'pipeline' } }, required: ['collaboration_shape'] },
    then: { properties: { max_concurrent_subharnesses: { const: 1 } } },
  }],
} as const;

const runPolicySchema = { anyOf: [runPolicyV1_0Schema, runPolicyV1_1Schema] } as const;

const storedEstimateAcknowledgementSchema = {
  type: 'object', additionalProperties: false,
  required: ['cost_range', 'duration_range', 'relative_to_single'],
  properties: {
    cost_range: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
    duration_range: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
    relative_to_single: { type: 'number', exclusiveMinimum: 0 },
  },
} as const;

const runCreatedEventPayloadSchema = {
  type: 'object', additionalProperties: false,
  required: ['execution_mode', 'policy', 'acknowledged_estimate'],
  properties: {
    execution_mode: { enum: ['single', 'multi'] },
    policy: runPolicySchema,
    acknowledged_estimate: { anyOf: [{ type: 'null' }, storedEstimateAcknowledgementSchema] },
  },
} as const;

const memberSnapshotSchema = {
  type: 'object', additionalProperties: false,
  required: ['member_key', 'profile_id', 'profile_version', 'definition'],
  properties: {
    member_key: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
    profile_id: { type: 'string', minLength: 1, maxLength: 128 },
    profile_version: { type: 'integer', minimum: 1 },
    definition: profileSchema,
  },
} as const;

const recordSchema = { type: 'object' } as const;

const internalCreateTaskSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'assignee_member_id', 'task_contract'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    assignee_member_id: { type: 'string', minLength: 1, maxLength: 128 },
    task_contract: taskContractSchema,
  },
} as const;

const internalCreateNodeBatchSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'nodes'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    nodes: {
      type: 'array', minItems: 1, maxItems: 4,
      items: {
        type: 'object', additionalProperties: false,
        required: ['client_ref', 'assignee_member_id', 'task_contract'],
        properties: {
          client_ref: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9._:-]*$' },
          assignee_member_id: { type: 'string', minLength: 1, maxLength: 128 },
          task_contract: taskContractSchema,
        },
      },
    },
  },
} as const;

const internalProgressSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'message'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    message: { type: 'string', minLength: 1, maxLength: 8000 },
    percent: { type: 'number', minimum: 0, maximum: 100 },
    detail: { type: 'object' },
  },
} as const;

const internalCompleteSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'result'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    result: resultSchema,
  },
} as const;

const internalFailSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'reason'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    reason: { type: 'string', minLength: 1, maxLength: 8000 },
    category: { enum: ['business', 'permission', 'contract', 'backend', 'unknown'] },
    retryable: { type: 'boolean' },
  },
} as const;

const internalResultAckSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'last_seen_seq'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    last_seen_seq: { type: 'integer', minimum: 0 },
  },
} as const;

const controlActionSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'reason'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    reason: { type: 'string', minLength: 3, maxLength: 2000 },
  },
} as const;

const validators = {
  profile: ajv.compile(profileSchema), estimate: ajv.compile(estimateSchema), create: ajv.compile(createSchema),
  task: ajv.compile(taskContractSchema), result: ajv.compile(resultSchema),
  runPolicy: ajv.compile(runPolicySchema), memberSnapshot: ajv.compile(memberSnapshotSchema),
  runCreatedEventPayload: ajv.compile(runCreatedEventPayloadSchema),
  toolPolicy: ajv.compile(toolPolicySchema), record: ajv.compile(recordSchema),
  internalCreateTask: ajv.compile(internalCreateTaskSchema), internalProgress: ajv.compile(internalProgressSchema),
  internalCreateNodeBatch: ajv.compile(internalCreateNodeBatchSchema),
  internalComplete: ajv.compile(internalCompleteSchema), internalFail: ajv.compile(internalFailSchema),
  internalResultAck: ajv.compile(internalResultAckSchema),
  controlAction: ajv.compile(controlActionSchema),
};

export class HarnessSchemaError extends Error {
  readonly code = 'invalid_harness_schema';
  constructor(readonly schemaName: string, readonly details: string[]) {
    super(`${schemaName} 校验失败: ${details.join('; ')}`);
  }
}

function errorDetails(errors: ErrorObject[] | null | undefined): string[] {
  return (errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'invalid'}`);
}

function parse<T>(value: unknown, name: string, validate: ValidateFunction): T {
  if (!validate(value)) throw new HarnessSchemaError(name, errorDetails(validate.errors));
  return value as T;
}

const MAX_HARNESS_OUTPUT_BYTES = 128 * 1024;
const MAX_HARNESS_RESULT_BYTES = 256 * 1024;

function validateHarnessNodeResultContent(value: HarnessNodeResult): HarnessNodeResult {
  const details: string[] = [];
  if (value.schema_version === '1.2') {
    const serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (serializedBytes > MAX_HARNESS_RESULT_BYTES) {
      details.push(`/ exceeds ${MAX_HARNESS_RESULT_BYTES} serialized bytes`);
    }
    const names = new Set<string>();
    value.outputs.forEach((output, index) => {
      if (names.has(output.name)) details.push(`/outputs/${index}/name must be unique`);
      names.add(output.name);
      if (Buffer.byteLength(output.content, 'utf8') > MAX_HARNESS_OUTPUT_BYTES) {
        details.push(`/outputs/${index}/content exceeds ${MAX_HARNESS_OUTPUT_BYTES} bytes`);
      }
      if (output.mime_type === 'application/json') {
        try {
          JSON.parse(output.content);
        } catch {
          details.push(`/outputs/${index}/content must contain valid JSON for application/json`);
        }
      }
    });
  }
  if (details.length > 0) throw new HarnessSchemaError('HarnessNodeResult', details);
  return value;
}

export function harnessNodeResultDeliverableReasons(
  result: HarnessNodeResult,
  contract: HarnessTaskContractV1,
): string[] {
  if (result.schema_version === '1.1') return [];
  const reasons: string[] = [];
  const outputsByName = new Map(result.outputs.map((output) => [output.name, output]));
  for (const deliverable of contract.deliverables) {
    if (!deliverable.required || !['report', 'structured_data'].includes(deliverable.kind)) continue;
    const output = outputsByName.get(deliverable.name);
    if (!output) {
      reasons.push(`缺少必需交付物 output: ${deliverable.name}`);
    } else if (output.kind !== deliverable.kind) {
      reasons.push(`交付物 output 类型不匹配: ${deliverable.name} 应为 ${deliverable.kind}`);
    }
  }
  return reasons;
}

export const parseHarnessProfile = (value: unknown) => parse<HarnessProfileDefinitionV1>(value, 'HarnessProfileDefinitionV1', validators.profile);
export const parseHarnessEstimateRequest = (value: unknown) => parse<HarnessEstimateRequestV1>(value, 'HarnessEstimateRequestV1', validators.estimate);
export const parseHarnessCreateRunRequest = (value: unknown) => parse<HarnessCreateRunRequestV1>(value, 'HarnessCreateRunRequestV1', validators.create);
export const parseHarnessTaskContract = (value: unknown) => parse<HarnessTaskContractV1>(value, 'HarnessTaskContractV1', validators.task);
export const parseHarnessNodeResult = (value: unknown) => validateHarnessNodeResultContent(parse<HarnessNodeResult>(value, 'HarnessNodeResult', validators.result));
export const parseHarnessRunPolicy = (value: unknown) => parse<HarnessRunPolicyV1>(value, 'HarnessRunPolicyV1', validators.runPolicy);
export const parseHarnessRunCreatedEventPayload = (value: unknown) => parse<HarnessRunCreatedEventPayloadV1>(value, 'HarnessRunCreatedEventPayloadV1', validators.runCreatedEventPayload);
export const parseHarnessMemberSnapshot = (value: unknown) => parse<{ member_key: string; profile_id: string; profile_version: number; definition: HarnessProfileDefinitionV1 }>(value, 'HarnessMemberSnapshot', validators.memberSnapshot);
export const parseHarnessToolPolicy = (value: unknown) => parse<HarnessTaskContractV1['tools']>(value, 'HarnessToolPolicy', validators.toolPolicy);
export const parseHarnessRecord = (value: unknown) => parse<Record<string, unknown>>(value, 'HarnessRecord', validators.record);
export const parseHarnessInternalCreateTask = (value: unknown) => parse<{ request_id: string; assignee_member_id: string; task_contract: HarnessTaskContractV1 }>(value, 'HarnessInternalCreateTask', validators.internalCreateTask);
export const parseHarnessInternalCreateNodeBatch = (value: unknown) => parse<HarnessNodeBatchRequestV1>(value, 'HarnessNodeBatchRequestV1', validators.internalCreateNodeBatch);
export const parseHarnessInternalProgress = (value: unknown) => parse<{ request_id: string; message: string; percent?: number; detail?: Record<string, unknown> }>(value, 'HarnessInternalProgress', validators.internalProgress);
export const parseHarnessInternalComplete = (value: unknown) => {
  const parsed = parse<{ request_id: string; result: HarnessNodeResult }>(value, 'HarnessInternalComplete', validators.internalComplete);
  validateHarnessNodeResultContent(parsed.result);
  return parsed;
};
export const parseHarnessInternalFail = (value: unknown) => parse<{ request_id: string; reason: string; category?: string; retryable?: boolean }>(value, 'HarnessInternalFail', validators.internalFail);
export const parseHarnessInternalResultAck = (value: unknown) => parse<HarnessResultAckRequestV1>(value, 'HarnessResultAckRequestV1', validators.internalResultAck);
export const parseHarnessControlAction = (value: unknown) => parse<{ request_id: string; reason: string }>(value, 'HarnessControlAction', validators.controlAction);

export function parseJsonColumn<T>(raw: unknown, name: string, parser: (value: unknown) => T): T {
  let value: unknown;
  try { value = JSON.parse(String(raw)); } catch { throw new HarnessSchemaError(name, ['数据库 JSON 不是合法 JSON']); }
  return parser(value);
}

export function assertNoLethalTrifecta(tags: string[]): void {
  const granted = new Set(tags);
  if (['private_data_read', 'untrusted_ingest', 'outbound_network'].every((tag) => granted.has(tag))) {
    throw new HarnessSchemaError('tool_policy', ['节点不能同时拥有 private_data_read、untrusted_ingest 和 outbound_network；请移除联网、私有数据读取或不可信输入中的至少一项']);
  }
}
