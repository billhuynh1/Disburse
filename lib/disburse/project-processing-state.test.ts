import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveProjectProcessingDisplaySteps,
  deriveProjectProcessingState,
} from '../../app/(dashboard)/dashboard/project-processing-state.ts';
import {
  ContentPackKind,
  ContentPackStatus,
  JobRecoveryMode,
  JobStatus,
  JobType,
  SourceAssetStatus,
  SourceAssetType,
  TranscriptStatus,
} from '../db/schema.ts';

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
        assetType: SourceAssetType.UPLOADED_FILE,
        status: SourceAssetStatus.READY,
        transcript: {
          status: TranscriptStatus.READY,
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
    kind: ContentPackKind.SHORT_FORM_CLIPS,
    sourceAssetId: 1,
    status: ContentPackStatus.PENDING,
    failureReason: null,
    generationRunId: 'run-1',
    clipCandidates: [],
    renderedClips: [],
    ...overrides,
  };
}

function currentCandidate(id = 1, overrides: Record<string, unknown> = {}) {
  return {
    id,
    generationRunId: 'run-1',
    facecamDetectionStatus: 'ready',
    ...overrides,
  };
}

function activeJob(overrides: Record<string, unknown> = {}) {
  return {
    type: JobType.GENERATE_SHORT_FORM_PACK,
    status: JobStatus.PENDING,
    sourceAssetId: 1,
    contentPackId: 1,
    generationRunId: 'run-1',
    clipCandidateId: 1,
    videoId: null,
    ...overrides,
  };
}

test('generation processing display timeline contains the approved four stages', () => {
  const steps = deriveProjectProcessingDisplaySteps('generating_clips');

  assert.equal(steps.length, 4);
  assert.deepEqual(
    steps.map((step) => step.label),
    [
      'Preparing clips',
      'Finding highlights',
      'Creating clips',
      'Finalizing',
    ]
  );
});

test('uploaded source without a content pack requires setup instead of processing', () => {
  const project = baseProject();
  project.sourceAssets[0].status = SourceAssetStatus.UPLOADED;
  project.sourceAssets[0].transcript.status = TranscriptStatus.PENDING;

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isSetupRequired, true);
  assert.equal(state.isProcessing, false);
  assert.equal(state.currentStepKey, null);
});

test('source upload state is processing after setup is submitted', () => {
  const project = baseProject();
  project.sourceAssets[0].status = SourceAssetStatus.PROCESSING;
  project.contentPacks = [shortFormPack()];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isSetupRequired, false);
  assert.equal(state.isProcessing, true);
});

test('content pack pending and generating statuses are processing states', () => {
  const pendingProject = baseProject();
  pendingProject.contentPacks = [shortFormPack({ status: ContentPackStatus.PENDING })];

  const pendingState = deriveProjectProcessingState(pendingProject);

  assert.equal(pendingState.isSetupRequired, false);
  assert.equal(pendingState.isProcessing, true);
  assert.equal(pendingState.currentStepKey, 'analyzing_transcript');

  const generatingProject = baseProject();
  generatingProject.contentPacks = [shortFormPack({ status: ContentPackStatus.GENERATING })];

  const generatingState = deriveProjectProcessingState(generatingProject);

  assert.equal(generatingState.isProcessing, true);
  assert.equal(generatingState.currentStepKey, 'generating_clips');
});

test('ready rendered clips remain ready-like', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.READY,
      renderedClips: [{ id: 1, status: 'ready' }],
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isReadyLike, true);
  assert.equal(state.isProcessing, false);
  assert.equal(state.isSetupRequired, false);
});

test('source preparation maps to preparing clips without changing processing state', () => {
  assert.equal(getCurrentDisplayLabel('transcribing'), 'Preparing clips');
  assert.equal(getCurrentDisplayLabel('analyzing_transcript'), 'Preparing clips');
});

test('observable generation states map to the approved user-facing stages', () => {
  assert.equal(getCurrentDisplayLabel('generating_clips'), 'Finding highlights');
  assert.equal(getCurrentDisplayLabel('ranking_candidates'), 'Finding highlights');
  assert.equal(getCurrentDisplayLabel('detecting_facecam'), 'Creating clips');
  assert.equal(getCurrentDisplayLabel('applying_edits'), 'Creating clips');
  assert.equal(getCurrentDisplayLabel('rendering_clips'), 'Creating clips');
  assert.equal(getCurrentDisplayLabel('generating_previews'), 'Finalizing');
  assert.equal(getCurrentDisplayLabel('finalizing'), 'Finalizing');
});

test('generation display steps retain completed, current, and upcoming semantics', () => {
  const steps = deriveProjectProcessingDisplaySteps('rendering_clips');

  assert.deepEqual(
    steps.map((step) => step.status),
    ['complete', 'complete', 'current', 'upcoming']
  );
});

test('queued generation remains in preparing clips before highlight generation begins', () => {
  const steps = deriveProjectProcessingDisplaySteps('generating_clips', 'queued');

  assert.equal(steps.find((step) => step.status === 'current')?.label, 'Preparing clips');
});

test('queued generation uses preparing clips rather than a lifecycle percentage', () => {
  const project = baseProject();
  project.contentPacks = [shortFormPack({ status: ContentPackStatus.PENDING })];
  project.activeJobs = [activeJob()];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.currentStepLabel, 'Preparing clips');
  assert.equal('percentComplete' in state, false);
});

test('no processing jobs leaves a completed project ready', () => {
  const project = baseProject();
  project.contentPacks = [shortFormPack({ status: ContentPackStatus.READY })];
  project.activeJobs = [];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isReadyLike, true);
  assert.equal(state.isProcessing, false);
  assert.equal(state.isFailed, false);
});

test('a pending-only generation job is queued', () => {
  const project = baseProject();
  project.contentPacks = [shortFormPack({ status: ContentPackStatus.PENDING })];
  project.activeJobs = [activeJob()];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isProcessing, true);
  assert.equal(state.executionStatus, 'queued');
  assert.equal(state.currentStepKey, 'generating_clips');
});

test('a processing-only render job is actively processing', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.READY,
      clipCandidates: [currentCandidate()],
    }),
  ];
  project.activeJobs = [
    activeJob({
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      status: JobStatus.PROCESSING,
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isReadyLike, false);
  assert.equal(state.isProcessing, true);
  assert.equal(state.executionStatus, 'processing');
  assert.equal(state.currentStepKey, 'rendering_clips');
});

test('a terminal transcription failure exposes its safe domain failure context', () => {
  const project = baseProject();
  project.sourceAssets[0].status = SourceAssetStatus.FAILED;
  project.sourceAssets[0].transcript.status = TranscriptStatus.FAILED;
  project.sourceAssets[0].transcript.failureReason = 'Transcript could not be created.';
  project.contentPacks = [shortFormPack()];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isFailed, true);
  assert.equal(state.failedStage, 'transcription');
  assert.equal(state.failureReason, 'Transcript could not be created.');
});

test('a terminal content-generation failure remains non-recoverable without active work', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.FAILED,
      failureReason: 'Clip generation failed.',
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isFailed, true);
  assert.equal(state.failedStage, 'clip_generation');
  assert.equal(state.failureReason, 'Clip generation failed.');
  assert.equal(state.isProcessing, false);
});

test('an active authorized recovery successor takes precedence over a stale failure', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.FAILED,
      failureReason: 'Previous run failed.',
      clipCandidates: [currentCandidate()],
    }),
  ];
  project.activeJobs = [
    activeJob({
      type: JobType.DETECT_CLIP_FACECAM,
      status: JobStatus.PROCESSING,
      recoveryMode: JobRecoveryMode.RESUME,
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isFailed, false);
  assert.equal(state.failureReason, null);
  assert.equal(state.isProcessing, true);
  assert.equal(state.currentStepKey, 'detecting_facecam');
});

test('multiple pending jobs use deterministic pipeline-stage precedence', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.GENERATING,
      clipCandidates: [currentCandidate()],
    }),
  ];
  project.activeJobs = [
    activeJob({ type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM }),
    activeJob({ type: JobType.TRANSCRIBE_SOURCE_ASSET, contentPackId: null }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.currentStepKey, 'transcribing');
  assert.equal(state.executionStatus, 'queued');
});

test('multiple processing jobs use deterministic pipeline-stage precedence', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.GENERATING,
      clipCandidates: [currentCandidate()],
    }),
  ];
  project.activeJobs = [
    activeJob({ type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, status: JobStatus.PROCESSING }),
    activeJob({ type: JobType.TRANSCRIBE_SOURCE_ASSET, contentPackId: null, status: JobStatus.PROCESSING }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.currentStepKey, 'transcribing');
  assert.equal(state.executionStatus, 'processing');
});

test('a later processing job takes precedence over an earlier queued job', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.GENERATING,
      clipCandidates: [currentCandidate()],
    }),
  ];
  project.activeJobs = [
    activeJob({ type: JobType.TRANSCRIBE_SOURCE_ASSET, contentPackId: null }),
    activeJob({ type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, status: JobStatus.PROCESSING }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.currentStepKey, 'rendering_clips');
  assert.equal(state.executionStatus, 'processing');
});

test('active-job input order does not change the selected presentation', () => {
  const jobs = [
    activeJob({ type: JobType.TRANSCRIBE_SOURCE_ASSET, contentPackId: null }),
    activeJob({ type: JobType.DETECT_CLIP_FACECAM, status: JobStatus.PROCESSING }),
    activeJob({ type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, status: JobStatus.PROCESSING }),
  ];
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.GENERATING,
      clipCandidates: [currentCandidate()],
    }),
  ];
  project.activeJobs = jobs;
  const reorderedProject = baseProject();
  reorderedProject.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.GENERATING,
      clipCandidates: [currentCandidate()],
    }),
  ];
  reorderedProject.activeJobs = [...jobs].reverse();

  const selectPresentation = (input: any) => {
    const state = deriveProjectProcessingState(input);
    return [state.currentStepKey, state.executionStatus, state.isFailed];
  };

  assert.deepEqual(selectPresentation(project), selectPresentation(reorderedProject));
  assert.deepEqual(selectPresentation(project), ['detecting_facecam', 'processing', false]);
});

test('a job from an older generation does not hide the current failure', () => {
  const project = baseProject();
  project.contentPacks = [shortFormPack({ status: ContentPackStatus.FAILED })];
  project.activeJobs = [activeJob({ generationRunId: 'old-run' })];

  assert.equal(deriveProjectProcessingState(project).isFailed, true);
});

test('a generation-scoped job with a null generation ID cannot hide a current failure', () => {
  const project = baseProject();
  project.contentPacks = [shortFormPack({ status: ContentPackStatus.FAILED })];
  project.activeJobs = [activeJob({ generationRunId: null })];

  assert.equal(deriveProjectProcessingState(project).isFailed, true);
});

test('a generation-scoped job with the exact current generation is active', () => {
  const project = baseProject();
  project.contentPacks = [shortFormPack({ status: ContentPackStatus.FAILED })];
  project.activeJobs = [activeJob({ status: JobStatus.PROCESSING })];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isFailed, false);
  assert.equal(state.currentStepKey, 'generating_clips');
});

test('source-scoped jobs are current without a generation ID only under their source contract', () => {
  const project = baseProject();
  project.contentPacks = [shortFormPack({ status: ContentPackStatus.FAILED })];
  project.activeJobs = [
    activeJob({
      type: JobType.TRANSCRIBE_SOURCE_ASSET,
      contentPackId: null,
      generationRunId: null,
      clipCandidateId: null,
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isFailed, false);
  assert.equal(state.currentStepKey, 'transcribing');
});

test('source-level and candidate-level facecam jobs use their distinct contracts', () => {
  const project = baseProject();
  project.contentPacks = [shortFormPack({ status: ContentPackStatus.FAILED })];
  project.activeJobs = [
    activeJob({
      type: JobType.DETECT_CLIP_FACECAM,
      contentPackId: null,
      generationRunId: null,
      clipCandidateId: null,
      videoId: 1,
    }),
    activeJob({
      type: JobType.DETECT_CLIP_FACECAM,
      generationRunId: 'old-run',
      clipCandidateId: 1,
      videoId: null,
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isFailed, false);
  assert.equal(state.currentStepKey, 'detecting_facecam');
});

test('a matching positive legacy facecam video ID is active for its source asset', () => {
  const project = baseProject();
  project.contentPacks = [shortFormPack({ status: ContentPackStatus.FAILED })];
  project.activeJobs = [
    activeJob({
      type: JobType.DETECT_CLIP_FACECAM,
      contentPackId: null,
      generationRunId: null,
      clipCandidateId: null,
      videoId: 1,
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isFailed, false);
  assert.equal(state.currentStepKey, 'detecting_facecam');
});

test('invalid legacy facecam video IDs cannot suppress a current failure', () => {
  for (const videoId of [2, null, 0, -1]) {
    const project = baseProject();
    project.contentPacks = [shortFormPack({ status: ContentPackStatus.FAILED })];
    project.activeJobs = [
      activeJob({
        type: JobType.DETECT_CLIP_FACECAM,
        contentPackId: null,
        generationRunId: null,
        clipCandidateId: null,
        videoId,
      }),
    ];

    const state = deriveProjectProcessingState(project);

    assert.equal(state.isFailed, true, `video ID ${videoId}`);
    assert.equal(state.isProcessing, false, `video ID ${videoId}`);
  }
});

test('candidate-level facecam matching ignores the legacy video ID contract', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.FAILED,
      clipCandidates: [currentCandidate()],
    }),
  ];
  project.activeJobs = [
    activeJob({
      type: JobType.DETECT_CLIP_FACECAM,
      status: JobStatus.PROCESSING,
      videoId: 2,
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isFailed, false);
  assert.equal(state.currentStepKey, 'detecting_facecam');
});

test('candidate-scoped jobs are active only for matching current candidates', () => {
  const cases = [
    [JobType.RENDER_CLIP_CANDIDATE, 'rendering_clips'],
    [JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, 'rendering_clips'],
    [JobType.DETECT_CLIP_FACECAM, 'detecting_facecam'],
  ] as const;

  for (const [type, currentStepKey] of cases) {
    const project = baseProject();
    project.contentPacks = [
      shortFormPack({
        status: ContentPackStatus.FAILED,
        clipCandidates: [currentCandidate()],
      }),
    ];
    project.activeJobs = [
      activeJob({
        type,
        status: JobStatus.PROCESSING,
        videoId: null,
      }),
    ];

    const state = deriveProjectProcessingState(project);

    assert.equal(state.isFailed, false, type);
    assert.equal(state.isProcessing, true, type);
    assert.equal(state.currentStepKey, currentStepKey, type);
  }
});

test('malformed candidate-scoped jobs cannot hide a current failure', () => {
  const createFailedProject = () => {
    const project = baseProject();
    project.contentPacks = [
      shortFormPack({
        status: ContentPackStatus.FAILED,
        clipCandidates: [
          currentCandidate(),
          currentCandidate(2, { generationRunId: 'old-run' }),
        ],
      }),
    ];
    return project;
  };
  const cases: Array<[string, any, (project: any) => void]> = [
    [
      'render job with a null candidate',
      activeJob({ type: JobType.RENDER_CLIP_CANDIDATE, clipCandidateId: null }),
      () => {},
    ],
    [
      'render job with a nonexistent candidate',
      activeJob({ type: JobType.RENDER_CLIP_CANDIDATE, clipCandidateId: 999 }),
      () => {},
    ],
    [
      'render job for an old-generation candidate',
      activeJob({ type: JobType.RENDER_CLIP_CANDIDATE, clipCandidateId: 2 }),
      () => {},
    ],
    [
      'render job for a candidate in another current pack',
      activeJob({ type: JobType.RENDER_CLIP_CANDIDATE, clipCandidateId: 3 }),
      (project) => {
        project.contentPacks.push(
          shortFormPack({
            id: 2,
            status: ContentPackStatus.READY,
            clipCandidates: [currentCandidate(3)],
          })
        );
      },
    ],
    [
      'format job with a null candidate',
      activeJob({
        type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        clipCandidateId: null,
      }),
      () => {},
    ],
    [
      'format job with a mismatched candidate',
      activeJob({
        type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        clipCandidateId: 999,
      }),
      () => {},
    ],
    [
      'candidate facecam job with a null candidate',
      activeJob({
        type: JobType.DETECT_CLIP_FACECAM,
        clipCandidateId: null,
        videoId: null,
      }),
      () => {},
    ],
    [
      'candidate facecam job with a mismatched candidate',
      activeJob({
        type: JobType.DETECT_CLIP_FACECAM,
        clipCandidateId: 999,
        videoId: null,
      }),
      () => {},
    ],
  ];

  for (const [description, job, arrange] of cases) {
    const project = createFailedProject();
    arrange(project);
    project.activeJobs = [job];

    const state = deriveProjectProcessingState(project);

    assert.equal(state.isFailed, true, description);
    assert.equal(state.isProcessing, false, description);
  }
});

test('candidate-scoped matching is deterministic when jobs and candidates are reordered', () => {
  const jobs = [
    activeJob({
      type: JobType.RENDER_CLIP_CANDIDATE,
      clipCandidateId: 1,
      status: JobStatus.PENDING,
    }),
    activeJob({
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      clipCandidateId: 2,
      status: JobStatus.PROCESSING,
    }),
  ];
  const candidates = [
    currentCandidate(1),
    currentCandidate(2),
    currentCandidate(3, { generationRunId: 'old-run' }),
  ];
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.FAILED,
      clipCandidates: candidates,
    }),
  ];
  project.activeJobs = jobs;
  const reorderedProject = baseProject();
  reorderedProject.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.FAILED,
      clipCandidates: [...candidates].reverse(),
    }),
  ];
  reorderedProject.activeJobs = [...jobs].reverse();

  const selectState = (input: any) => {
    const state = deriveProjectProcessingState(input);
    return [state.isFailed, state.isProcessing, state.currentStepKey, state.executionStatus];
  };

  assert.deepEqual(selectState(project), [false, true, 'rendering_clips', 'processing']);
  assert.deepEqual(selectState(project), selectState(reorderedProject));
});

test('old-generation candidates do not change the current stage', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.GENERATING,
      clipCandidates: [{ id: 1, generationRunId: 'old-run', facecamDetectionStatus: 'ready' }],
    }),
  ];

  assert.equal(deriveProjectProcessingState(project).currentStepKey, 'generating_clips');
});

test('current-generation candidates determine the current ranking state', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.GENERATING,
      clipCandidates: [{ id: 1, generationRunId: 'run-1', facecamDetectionStatus: 'ready' }],
    }),
  ];

  assert.equal(deriveProjectProcessingState(project).currentStepKey, 'ranking_candidates');
});

test('old-generation rendered clips do not make the current run ready', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.PENDING,
      renderedClips: [{ id: 1, generationRunId: 'old-run', status: 'ready' }],
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isReadyLike, false);
  assert.equal(state.currentStepKey, 'analyzing_transcript');
});

test('current-generation rendered clips determine current finalization state', () => {
  const project = baseProject();
  project.contentPacks = [
    shortFormPack({
      status: ContentPackStatus.PENDING,
      clipCandidates: [{ id: 1, generationRunId: 'run-1', facecamDetectionStatus: 'ready' }],
      renderedClips: [{ id: 1, generationRunId: 'run-1', status: 'ready' }],
    }),
  ];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isReadyLike, false);
  assert.equal(state.currentStepKey, 'finalizing');
});

test('mixed artifact generations and their input order count only the current generation', () => {
  const currentCandidate = {
    id: 2,
    generationRunId: 'run-1',
    facecamDetectionStatus: 'ready',
    renderedClips: [{ id: 2, generationRunId: 'run-1', status: 'ready' }],
  };
  const oldCandidate = {
    id: 1,
    generationRunId: 'old-run',
    facecamDetectionStatus: 'detecting',
    renderedClips: [{ id: 1, generationRunId: 'old-run', status: 'rendering' }],
  };
  const pack = shortFormPack({
    status: ContentPackStatus.PENDING,
    clipCandidates: [oldCandidate, currentCandidate],
    renderedClips: [oldCandidate.renderedClips[0], currentCandidate.renderedClips[0]],
  });
  const reorderedPack = shortFormPack({
    status: ContentPackStatus.PENDING,
    clipCandidates: [currentCandidate, oldCandidate],
    renderedClips: [currentCandidate.renderedClips[0], oldCandidate.renderedClips[0]],
  });
  const project = baseProject();
  project.contentPacks = [pack];
  const reorderedProject = baseProject();
  reorderedProject.contentPacks = [reorderedPack];

  const selectState = (input: any) => {
    const state = deriveProjectProcessingState(input);
    return [state.currentStepKey, state.isReadyLike, state.isProcessing];
  };

  assert.deepEqual(selectState(project), ['finalizing', false, true]);
  assert.deepEqual(selectState(project), selectState(reorderedProject));
});

test('missing optional failure details remain safe to render', () => {
  const project = baseProject();
  project.contentPacks = [shortFormPack({ status: ContentPackStatus.FAILED })];

  const state = deriveProjectProcessingState(project);

  assert.equal(state.isFailed, true);
  assert.equal(state.failedStage, 'clip_generation');
  assert.equal(state.failureReason, null);
});
