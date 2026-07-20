export const OPERATIONAL_EVENT_NAMES = [
  'pipeline.invocation_started', 'pipeline.invocation_completed',
  'pipeline.invocation_failed', 'pipeline.checkpoint_state',
  'pipeline.recovery_outcome', 'pipeline.deletion_state',
  'pipeline.scheduler_signal', 'pipeline.reconciliation_signal',
  'pipeline.provider_boundary',
] as const;

export type OperationalEventName = typeof OPERATIONAL_EVENT_NAMES[number];
export const OPERATIONAL_FAILURE_CLASSES = [
  'transient', 'safe_retry', 'permanent', 'ambiguous_external_effect',
  'cancellation', 'unknown',
] as const;
export type OperationalFailureClass = typeof OPERATIONAL_FAILURE_CLASSES[number];

export const OPERATIONAL_FAILURE_CODES = [
  'unclassified_failure', 'job_operation_deadline_exceeded',
  'ambiguous_external_effect', 'invalid_checkpoint_result',
  'external_effect_not_started', 'operational_fault_injected',
  'operational_invocation_start_failed',
  'operational_invocation_completion_failed', 'recovery_internal_error',
  'recovery_budget_exhausted', 'publishing_recovery_forbidden',
  'idempotency_key_reused', 'user_not_found', 'job_not_found',
  'invalid_payload', 'access_denied', 'lineage_invalid', 'source_not_found',
  'resource_deleted', 'deletion_requested', 'relationship_changed',
  'relationship_mismatch',
  'active_successor_exists', 'job_not_failed', 'media_unavailable',
  'failure_not_retryable', 'resume_required', 'durable_checkpoint_missing',
  'new_generation_not_supported', 'stale_generation', 'invalid_request',
  'facecam_timeout', 'facecam_aborted', 'facecam_network_error',
  'facecam_http_error', 'facecam_invalid_response',
  'transcribe_source_asset_unclassified_failure',
  'extract_source_asset_thumbnail_unclassified_failure',
  'ingest_youtube_source_asset_unclassified_failure',
  'generate_short_form_pack_unclassified_failure',
  'render_clip_candidate_unclassified_failure',
  'format_rendered_clip_short_form_unclassified_failure',
  'detect_clip_facecam_unclassified_failure',
] as const;
export type OperationalFailureCode = typeof OPERATIONAL_FAILURE_CODES[number];

const INVALID_INVOCATION_ID = '00000000-0000-4000-8000-000000000000';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COUNT = 1_000_000;
const MAX_DURATION_MS = 86_400_000;

export const OPERATIONAL_STRING_FIELD_VALUES: Readonly<Record<string, readonly string[]>> = {
  origin: ['internal', 'cron', 'request', 'recovery'],
  stopReason: ['queue_empty', 'max_jobs', 'max_runtime', 'reconciliation_budget', 'capacity_blocked', 'concurrent_claim', 'processor_busy', 'kill_switch', 'fatal_error'],
  failureClass: OPERATIONAL_FAILURE_CLASSES,
  failureCode: OPERATIONAL_FAILURE_CODES,
  checkpointState: ['prepared', 'prepared_reset', 'ambiguous', 'completed', 'completed_reused'],
  recoveryOutcome: ['accepted', 'duplicate', 'rejected'],
  deletionState: ['not_found', 'requested', 'waiting_for_leases', 'finalized', 'finalization_lost'],
  schedulerSignal: ['queue_empty', 'max_jobs', 'max_runtime', 'reconciliation_budget', 'capacity_blocked', 'concurrent_claim', 'processor_busy', 'kill_switch', 'fatal_error', 'release_failed', 'follow_up_failed', 'trigger_failed'],
  reconciliationSignal: ['advanced', 'no_progress'],
  provider: ['openai', 's3', 'media', 'render', 'facecam'],
  boundary: ['before_send', 'after_send_before_response', 'after_provider_success_before_persistence', 'after_checkpoint_persistence_before_finalization', 'fetch_failed', 'compensation_failed', 'compensation_classification_failed', 'multipart_compensation_failed'],
  jobType: ['transcribe_source_asset', 'extract_source_asset_thumbnail', 'ingest_youtube_source_asset', 'generate_short_form_pack', 'render_clip_candidate', 'format_rendered_clip_short_form', 'detect_clip_facecam', 'publish_rendered_clip'],
  effectKind: ['transcription', 'thumbnail', 'youtube_ingestion', 'generation', 'render_upload', 'format_render_upload', 'facecam'],
};
const STRING_VALUES = Object.fromEntries(Object.entries(OPERATIONAL_STRING_FIELD_VALUES)
  .map(([field, values]) => [field, new Set(values)])) as Readonly<Record<string, ReadonlySet<string>>>;
export const OPERATIONAL_STRING_FIELDS = Object.freeze(Object.keys(STRING_VALUES));
const INTEGER_FIELDS = new Set([
  'durationMs', 'processedJobs', 'recoveredJobs', 'reconciledProjects',
  'reconciliationCycle', 'queueDepth', 'queueAgeSeconds', 'expiredLeases',
  'ambiguousCheckpoints', 'deletionBacklog', 'auditRows', 'jobId',
  'projectId', 'sourceAssetId', 'deletedObjects',
]);
const BOOLEAN_FIELDS = new Set([
  'followUpTriggered', 'processorOwned', 'capacityBlocked', 'lockContended',
]);

export type SafeOperationalEvent = Readonly<Record<string, string | number | boolean>> & {
  event: OperationalEventName;
  invocationId: string;
};

export function sanitizeOperationalEvent(
  event: OperationalEventName,
  fields: Record<string, unknown>
): SafeOperationalEvent {
  if (!(OPERATIONAL_EVENT_NAMES as readonly string[]).includes(event)) {
    throw new Error('Operational event is not allowlisted.');
  }
  const safe: Record<string, string | number | boolean> = {
    event,
    invocationId: typeof fields.invocationId === 'string' && UUID_PATTERN.test(fields.invocationId)
      ? fields.invocationId
      : INVALID_INVOCATION_ID,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (field === 'invocationId') continue;
    const values = STRING_VALUES[field];
    if (values) {
      if (typeof value === 'string' && values.has(value)) safe[field] = value;
      else if (field === 'failureCode') safe.failureCode = 'unclassified_failure';
      else if (field === 'failureClass') safe.failureClass = 'unknown';
      continue;
    }
    if (INTEGER_FIELDS.has(field)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const upper = field === 'durationMs' ? MAX_DURATION_MS : MAX_COUNT;
      safe[field] = Math.min(upper, Math.max(0, Math.floor(value)));
      continue;
    }
    if (BOOLEAN_FIELDS.has(field) && typeof value === 'boolean') safe[field] = value;
  }
  return safe as SafeOperationalEvent;
}

export function emitOperationalEvent(
  event: OperationalEventName,
  fields: Record<string, unknown>,
  sink: (serialized: string) => void = console.info
) {
  const safe = sanitizeOperationalEvent(event, fields);
  sink(JSON.stringify(safe));
  return safe;
}

export function classifyOperationalFailure(error: unknown): {
  failureClass: OperationalFailureClass;
  failureCode: OperationalFailureCode;
} {
  const code = typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' ? error.code : '';
  if (code === 'job_operation_deadline_exceeded') {
    return { failureClass: 'transient', failureCode: code };
  }
  if (code === 'ambiguous_external_effect') {
    return { failureClass: 'ambiguous_external_effect', failureCode: code };
  }
  if (code === 'external_effect_not_started') {
    return { failureClass: 'safe_retry', failureCode: code };
  }
  if (code === 'invalid_checkpoint_result') {
    return { failureClass: 'permanent', failureCode: code };
  }
  if (code === 'operational_fault_injected') {
    return { failureClass: 'transient', failureCode: code };
  }
  return { failureClass: 'unknown', failureCode: 'unclassified_failure' };
}
