import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveProjectProcessingDisplaySteps,
  deriveProjectProcessingState,
} from '../../app/(dashboard)/dashboard/project-processing-state.ts';

function getCurrentDisplayLabel(
  currentStepKey: Parameters<typeof deriveProjectProcessingDisplaySteps>[0]
) {
  const currentStep = deriveProjectProcessingDisplaySteps(currentStepKey).find(
    (step) => step.status === 'current'
  );

  return currentStep?.label || null;
}

function baseProject(): any {
  return {
    sourceAssets: [
      {
        id: 1,
        assetType: 'uploaded_file',
        status: 'ready',
        transcript: {
          status: 'ready',
          failureReason: null,
        },
      },
    ],
    contentPacks: [],
  };
}

function shortFormPack(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    kind: 'short_form_clips',
    sourceAssetId: 1,
    status: 'pending',
    failureReason: null,
    clipCandidates: [],
    renderedClips: [],
    ...overrides,
  };
}

test('processing display timeline never exceeds four steps', () => {
  const steps = deriveProjectProcessingDisplaySteps('generating_clips');

  assert.equal(steps.length, 4);
  assert.deepEqual(
    steps.map((step) => step.label),
    ['Uploading video', 'Processing video', 'Generating clips', 'Finalizing project']
  );
});

test('uploaded source without a content pack requires setup instead of processing', () => {
  const project = baseProject();
  project.sourceAssets[0].status = 'uploaded';
  project.sourceAssets[0].transcript.status = 'pending';

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isSetupRequired, true);
  assert.equal(state.isProcessing, false);
  assert.equal(state.currentStepKey, null);
});

test('source upload state is processing after setup is submitted', () => {
  const project = baseProject();
  project.sourceAssets[0].status = 'processing';
  project.contentPacks = [shortFormPack()];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isSetupRequired, false);
  assert.equal(state.isProcessing, true);
});

test('content pack pending and generating statuses are processing states', () => {
  const pendingProject = baseProject();
  pendingProject.contentPacks = [shortFormPack({ status: 'pending' })];

  const pendingState = deriveProjectProcessingState(pendingProject);

  assert.equal(pendingState.isSetupRequired, false);
  assert.equal(pendingState.isProcessing, true);
  assert.equal(pendingState.currentStepKey, 'analyzing_transcript');

  const generatingProject = baseProject();
  generatingProject.contentPacks = [shortFormPack({ status: 'generating' })];

  const generatingState = deriveProjectProcessingState(generatingProject);

  assert.equal(generatingState.isProcessing, true);
  assert.equal(generatingState.currentStepKey, 'generating_clips');
});

test('ready rendered clips remain ready-like', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: 'ready',
      renderedClips: [{ id: 1, status: 'ready' }],
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isReadyLike, true);
  assert.equal(state.isProcessing, false);
  assert.equal(state.isSetupRequired, false);
});

test('transcript processing maps to processing video', () => {
  assert.equal(getCurrentDisplayLabel('transcribing'), 'Processing video');
  assert.equal(getCurrentDisplayLabel('analyzing_transcript'), 'Processing video');
});

test('content pack generation maps to generating clips', () => {
  assert.equal(getCurrentDisplayLabel('generating_clips'), 'Generating clips');
  assert.equal(getCurrentDisplayLabel('ranking_candidates'), 'Generating clips');
  assert.equal(getCurrentDisplayLabel('detecting_facecam'), 'Generating clips');
  assert.equal(getCurrentDisplayLabel('applying_edits'), 'Generating clips');
});

test('render and final stages map to finalizing project', () => {
  assert.equal(getCurrentDisplayLabel('rendering_clips'), 'Finalizing project');
  assert.equal(getCurrentDisplayLabel('generating_previews'), 'Finalizing project');
  assert.equal(getCurrentDisplayLabel('finalizing'), 'Finalizing project');
});
