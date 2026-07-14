export const RECONCILIATION_DEFAULT_PAGE_SIZE = 20;
export const RECONCILIATION_MAX_PAGE_SIZE = 50;

export type ReconciliationDecision<Action extends string> = {
  action: Action;
  reason: ReconciliationReason;
};

export type ReconciliationReason =
  | 'job_payload_malformed'
  | 'project_deleting'
  | 'source_deleting'
  | 'source_deleted'
  | 'source_expired'
  | 'source_media_unavailable'
  | 'source_not_processable'
  | 'transcript_job_missing'
  | 'transcript_job_active'
  | 'transcript_ready_projection_missing'
  | 'transcript_completed_result_replay'
  | 'transcript_completed_result_missing'
  | 'transcript_ready_content_missing'
  | 'transcript_terminal'
  | 'generation_superseded'
  | 'generation_job_missing'
  | 'generation_job_active'
  | 'generation_completed_result_replay'
  | 'generation_completed_result_missing'
  | 'generation_missing_candidate_rebuild'
  | 'generation_missing_candidate_rebuild_consumed'
  | 'generation_terminal'
  | 'facecam_not_required'
  | 'facecam_job_missing'
  | 'facecam_job_active'
  | 'facecam_terminal_projection_replay'
  | 'facecam_terminal_result_missing'
  | 'facecam_terminal'
  | 'render_superseded'
  | 'render_job_missing'
  | 'render_job_active'
  | 'render_artifact_projection_replay'
  | 'render_completed_artifact_missing'
  | 'render_terminal'
  | 'pack_outputs_ready'
  | 'pack_outputs_partially_ready'
  | 'pack_outputs_failed'
  | 'pack_work_active'
  | 'pack_status_current';

type LifecycleObservation = {
  projectDeleting: boolean;
  sourceDeleting: boolean;
  sourceDeleted: boolean;
  sourceExpired: boolean;
  mediaAvailable: boolean;
};

export type SourceReconciliationObservation = LifecycleObservation & {
  processable: boolean;
  transcriptStatus: 'missing' | 'pending' | 'processing' | 'ready' | 'failed';
  sourceProjectionReady: boolean;
  jobStatus: 'missing' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  hasPersistedTranscript: boolean;
};

export type SourceReconciliationAction =
  | 'refuse'
  | 'enqueue'
  | 'replay_projection'
  | 'terminalize'
  | 'noop';

function decideLifecycleRefusal(
  observation: LifecycleObservation
): ReconciliationDecision<'refuse'> | null {
  if (observation.projectDeleting) return { action: 'refuse', reason: 'project_deleting' };
  if (observation.sourceDeleting) return { action: 'refuse', reason: 'source_deleting' };
  if (observation.sourceDeleted) return { action: 'refuse', reason: 'source_deleted' };
  if (observation.sourceExpired) return { action: 'refuse', reason: 'source_expired' };
  if (!observation.mediaAvailable) {
    return { action: 'refuse', reason: 'source_media_unavailable' };
  }
  return null;
}

export function decideSourceReconciliation(
  observation: SourceReconciliationObservation
): ReconciliationDecision<SourceReconciliationAction> {
  const refusal = decideLifecycleRefusal(observation);
  if (refusal) return refusal;
  if (!observation.processable) return { action: 'noop', reason: 'source_not_processable' };
  if (observation.transcriptStatus === 'ready') {
    if (!observation.hasPersistedTranscript) {
      return { action: 'terminalize', reason: 'transcript_ready_content_missing' };
    }
    if (!observation.sourceProjectionReady) {
      return {
        action: 'replay_projection',
        reason:
          observation.jobStatus === 'completed'
            ? 'transcript_completed_result_replay'
            : 'transcript_ready_projection_missing',
      };
    }
    return { action: 'noop', reason: 'pack_status_current' };
  }
  if (observation.transcriptStatus === 'failed') {
    return { action: 'noop', reason: 'transcript_terminal' };
  }
  if (observation.jobStatus === 'pending' || observation.jobStatus === 'processing') {
    return { action: 'noop', reason: 'transcript_job_active' };
  }
  if (observation.jobStatus === 'completed') {
    return observation.hasPersistedTranscript
      ? { action: 'replay_projection', reason: 'transcript_completed_result_replay' }
      : { action: 'terminalize', reason: 'transcript_completed_result_missing' };
  }
  if (observation.jobStatus === 'failed' || observation.jobStatus === 'cancelled') {
    return { action: 'noop', reason: 'transcript_terminal' };
  }
  return { action: 'enqueue', reason: 'transcript_job_missing' };
}

export type GenerationReconciliationObservation = LifecycleObservation & {
  currentGeneration: boolean;
  packStatus: 'pending' | 'generating' | 'ready' | 'partially_ready' | 'failed';
  transcriptReady: boolean;
  jobStatus: 'missing' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  hasCurrentOutput: boolean;
  hasMissingCandidateCancellation: boolean;
  rebuildConsumed: boolean;
};

export type GenerationReconciliationAction =
  | 'refuse'
  | 'enqueue'
  | 'replay_projection'
  | 'rebuild'
  | 'terminalize'
  | 'noop';

export function decideGenerationReconciliation(
  observation: GenerationReconciliationObservation
): ReconciliationDecision<GenerationReconciliationAction> {
  const refusal = decideLifecycleRefusal(observation);
  if (refusal) return refusal;
  if (!observation.currentGeneration) {
    return { action: 'refuse', reason: 'generation_superseded' };
  }
  if (observation.packStatus === 'ready' || observation.packStatus === 'partially_ready' || observation.packStatus === 'failed') {
    return { action: 'noop', reason: 'generation_terminal' };
  }
  if (!observation.transcriptReady) return { action: 'noop', reason: 'generation_terminal' };
  if (observation.hasCurrentOutput) {
    return { action: 'replay_projection', reason: 'generation_completed_result_replay' };
  }
  if (observation.jobStatus === 'pending' || observation.jobStatus === 'processing') {
    return { action: 'noop', reason: 'generation_job_active' };
  }
  if (observation.jobStatus === 'completed') {
    if (observation.hasMissingCandidateCancellation) {
      return observation.rebuildConsumed
        ? { action: 'terminalize', reason: 'generation_missing_candidate_rebuild_consumed' }
        : { action: 'rebuild', reason: 'generation_missing_candidate_rebuild' };
    }
    return { action: 'terminalize', reason: 'generation_completed_result_missing' };
  }
  if (observation.jobStatus === 'failed' || observation.jobStatus === 'cancelled') {
    return { action: 'noop', reason: 'generation_terminal' };
  }
  return { action: 'enqueue', reason: 'generation_job_missing' };
}

export type FacecamReconciliationObservation = LifecycleObservation & {
  currentGeneration: boolean;
  required: boolean;
  candidateStatus: 'not_started' | 'pending' | 'detecting' | 'ready' | 'not_found' | 'failed';
  jobStatus: 'missing' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  terminalRun: boolean;
  terminalProjectionComplete: boolean;
};

export function decideFacecamReconciliation(
  observation: FacecamReconciliationObservation
): ReconciliationDecision<'refuse' | 'enqueue' | 'replay_projection' | 'terminalize' | 'noop'> {
  const refusal = decideLifecycleRefusal(observation);
  if (refusal) return refusal;
  if (!observation.currentGeneration) return { action: 'refuse', reason: 'generation_superseded' };
  if (!observation.required) return { action: 'noop', reason: 'facecam_not_required' };
  if (observation.terminalRun) {
    return observation.terminalProjectionComplete
      ? { action: 'noop', reason: 'facecam_terminal' }
      : { action: 'replay_projection', reason: 'facecam_terminal_projection_replay' };
  }
  if (observation.jobStatus === 'pending' || observation.jobStatus === 'processing') {
    return { action: 'noop', reason: 'facecam_job_active' };
  }
  if (observation.jobStatus === 'completed') {
    return { action: 'terminalize', reason: 'facecam_terminal_result_missing' };
  }
  if (observation.jobStatus === 'failed' || observation.jobStatus === 'cancelled') {
    return { action: 'terminalize', reason: 'facecam_terminal_result_missing' };
  }
  return { action: 'enqueue', reason: 'facecam_job_missing' };
}

export type RenderReconciliationObservation = LifecycleObservation & {
  currentGeneration: boolean;
  artifactStatus: 'missing' | 'pending' | 'rendering' | 'ready' | 'failed';
  jobStatus: 'missing' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  packProjectionComplete: boolean;
};

export function decideRenderReconciliation(
  observation: RenderReconciliationObservation
): ReconciliationDecision<'refuse' | 'enqueue' | 'replay_projection' | 'terminalize' | 'noop'> {
  const refusal = decideLifecycleRefusal(observation);
  if (refusal) return refusal;
  if (!observation.currentGeneration) return { action: 'refuse', reason: 'render_superseded' };
  if (observation.artifactStatus === 'ready' || observation.artifactStatus === 'failed') {
    return observation.packProjectionComplete
      ? { action: 'noop', reason: 'render_terminal' }
      : { action: 'replay_projection', reason: 'render_artifact_projection_replay' };
  }
  if (observation.jobStatus === 'pending' || observation.jobStatus === 'processing') {
    return { action: 'noop', reason: 'render_job_active' };
  }
  if (observation.jobStatus === 'completed') {
    return { action: 'terminalize', reason: 'render_completed_artifact_missing' };
  }
  if (observation.jobStatus === 'failed' || observation.jobStatus === 'cancelled') {
    return { action: 'terminalize', reason: 'render_terminal' };
  }
  return { action: 'enqueue', reason: 'render_job_missing' };
}

export type PackFinalizationObservation = {
  ready: number;
  terminalFailed: number;
  activeRepairable: number;
  required: number;
  currentStatus: 'pending' | 'generating' | 'ready' | 'partially_ready' | 'failed';
};

export function decidePackFinalization(
  observation: PackFinalizationObservation
): ReconciliationDecision<'set_ready' | 'set_partially_ready' | 'set_failed' | 'set_generating' | 'noop'> {
  const decided =
    observation.required > 0 && observation.ready === observation.required
      ? ({ action: 'set_ready', reason: 'pack_outputs_ready' } as const)
      : observation.ready > 0 && observation.ready + observation.terminalFailed === observation.required
        ? ({ action: 'set_partially_ready', reason: 'pack_outputs_partially_ready' } as const)
        : observation.ready === 0 && observation.activeRepairable === 0 && observation.terminalFailed === observation.required
          ? ({ action: 'set_failed', reason: 'pack_outputs_failed' } as const)
          : ({ action: 'set_generating', reason: 'pack_work_active' } as const);

  const target = decided.action.replace('set_', '');
  return target === observation.currentStatus
    ? { action: 'noop', reason: 'pack_status_current' }
    : decided;
}

export function normalizeReconciliationPageSize(pageSize?: number) {
  if (pageSize === undefined) return RECONCILIATION_DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(pageSize) || !Number.isInteger(pageSize) || pageSize <= 0) {
    throw new TypeError('pageSize must be a finite positive integer.');
  }
  return Math.min(RECONCILIATION_MAX_PAGE_SIZE, pageSize);
}

export function normalizeReconciliationCursor(afterProjectId?: number) {
  if (afterProjectId === undefined) return undefined;
  if (!Number.isFinite(afterProjectId) || !Number.isInteger(afterProjectId) || afterProjectId < 0) {
    throw new TypeError('afterProjectId must be a finite nonnegative integer.');
  }
  return afterProjectId;
}
