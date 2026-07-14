import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideFacecamReconciliation,
  decideGenerationReconciliation,
  decidePackFinalization,
  decideRenderReconciliation,
  decideSourceReconciliation,
  normalizeReconciliationPageSize,
} from './pipeline-reconciliation-policy.ts';

const lifecycle = {
  projectDeleting: false,
  sourceDeleting: false,
  sourceDeleted: false,
  sourceExpired: false,
  mediaAvailable: true,
};

test('source policy repairs missing work and refuses lifecycle-ineligible sources', () => {
  const base = {
    ...lifecycle,
    processable: true,
    transcriptStatus: 'pending' as const,
    sourceProjectionReady: false,
    jobStatus: 'missing' as const,
    hasPersistedTranscript: false,
  };
  assert.deepEqual(decideSourceReconciliation(base), {
    action: 'enqueue', reason: 'transcript_job_missing',
  });
  assert.deepEqual(decideSourceReconciliation({ ...base, sourceDeleting: true }), {
    action: 'refuse', reason: 'source_deleting',
  });
  assert.deepEqual(decideSourceReconciliation({
    ...base, jobStatus: 'completed', transcriptStatus: 'missing',
  }), { action: 'terminalize', reason: 'transcript_completed_result_missing' });
  assert.deepEqual(decideSourceReconciliation({
    ...base, jobStatus: 'completed', transcriptStatus: 'ready', hasPersistedTranscript: true,
  }), { action: 'replay_projection', reason: 'transcript_completed_result_replay' });
});

test('generation policy permits only one evidence-backed missing-candidate rebuild', () => {
  const base = {
    ...lifecycle,
    currentGeneration: true,
    packStatus: 'generating' as const,
    transcriptReady: true,
    jobStatus: 'completed' as const,
    hasCurrentOutput: false,
    hasMissingCandidateCancellation: true,
    rebuildConsumed: false,
  };
  assert.deepEqual(decideGenerationReconciliation(base), {
    action: 'rebuild', reason: 'generation_missing_candidate_rebuild',
  });
  assert.deepEqual(decideGenerationReconciliation({ ...base, rebuildConsumed: true }), {
    action: 'terminalize', reason: 'generation_missing_candidate_rebuild_consumed',
  });
  assert.deepEqual(decideGenerationReconciliation({
    ...base, hasMissingCandidateCancellation: false,
  }), { action: 'terminalize', reason: 'generation_completed_result_missing' });
  assert.deepEqual(decideGenerationReconciliation({ ...base, currentGeneration: false }), {
    action: 'refuse', reason: 'generation_superseded',
  });
});

test('facecam and render policies replay terminal projections without external work', () => {
  assert.deepEqual(decideFacecamReconciliation({
    ...lifecycle,
    currentGeneration: true,
    required: true,
    candidateStatus: 'ready',
    jobStatus: 'completed',
    terminalRun: true,
    terminalProjectionComplete: false,
  }), { action: 'replay_projection', reason: 'facecam_terminal_projection_replay' });
  assert.deepEqual(decideRenderReconciliation({
    ...lifecycle,
    currentGeneration: true,
    artifactStatus: 'ready',
    jobStatus: 'completed',
    packProjectionComplete: false,
  }), { action: 'replay_projection', reason: 'render_artifact_projection_replay' });
  assert.deepEqual(decideRenderReconciliation({
    ...lifecycle,
    currentGeneration: true,
    artifactStatus: 'missing',
    jobStatus: 'completed',
    packProjectionComplete: false,
  }), { action: 'terminalize', reason: 'render_completed_artifact_missing' });
});

test('pack finalization distinguishes ready, partial, failed, generating, and no-op', () => {
  assert.equal(decidePackFinalization({ ready: 2, terminalFailed: 0, activeRepairable: 0, required: 2, currentStatus: 'generating' }).action, 'set_ready');
  assert.equal(decidePackFinalization({ ready: 1, terminalFailed: 1, activeRepairable: 0, required: 2, currentStatus: 'generating' }).action, 'set_partially_ready');
  assert.equal(decidePackFinalization({ ready: 0, terminalFailed: 2, activeRepairable: 0, required: 2, currentStatus: 'generating' }).action, 'set_failed');
  assert.equal(decidePackFinalization({ ready: 0, terminalFailed: 0, activeRepairable: 2, required: 2, currentStatus: 'pending' }).action, 'set_generating');
  assert.deepEqual(decidePackFinalization({ ready: 2, terminalFailed: 0, activeRepairable: 0, required: 2, currentStatus: 'ready' }), { action: 'noop', reason: 'pack_status_current' });
});

test('page size is stable and bounded', () => {
  assert.equal(normalizeReconciliationPageSize(), 20);
  assert.equal(normalizeReconciliationPageSize(0), 1);
  assert.equal(normalizeReconciliationPageSize(21.9), 21);
  assert.equal(normalizeReconciliationPageSize(500), 50);
  assert.equal(normalizeReconciliationPageSize(Number.NaN), 20);
});
