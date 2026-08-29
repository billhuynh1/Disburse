import {
  ContentPackKind,
  ContentPackStatus,
  FacecamDetectionStatus,
  JobStatus,
  JobType,
  RenderedClipStatus,
  SourceAssetStatus,
  SourceAssetType,
  TranscriptStatus,
} from '../../../lib/db/schema.ts';

type ProjectSourceAsset = {
  id: number;
  assetType?: string;
  status: string;
  failureReason?: string | null;
  transcript: {
    status: string;
    failureReason: string | null;
  } | null;
};

type ProjectRenderedClip = {
  id: number;
  status: string;
  generationRunId?: string | null;
};

type ProjectClipCandidate = {
  id: number;
  facecamDetectionStatus: string;
  generationRunId?: string | null;
  renderedClips?: ProjectRenderedClip[];
};

type ProjectContentPack = {
  id: number;
  kind: string;
  sourceAssetId?: number;
  status: string;
  failureReason: string | null;
  generationRunId?: string | null;
  clipCandidates: ProjectClipCandidate[];
  renderedClips: ProjectRenderedClip[];
};

export type ProjectProcessingJob = {
  type: string;
  status: string;
  sourceAssetId: number | null;
  contentPackId: number | null;
  generationRunId: string | null;
  clipCandidateId: number | null;
  videoId: number | null;
};

type ProjectSummary = {
  sourceAssets: ProjectSourceAsset[];
  contentPacks: ProjectContentPack[];
  activeJobs?: ProjectProcessingJob[];
};

export type ProjectProcessingStepKey =
  | 'upload_complete'
  | 'transcribing'
  | 'analyzing_transcript'
  | 'generating_clips'
  | 'ranking_candidates'
  | 'detecting_facecam'
  | 'applying_edits'
  | 'rendering_clips'
  | 'generating_previews'
  | 'finalizing';

type StepDefinition = {
  key: ProjectProcessingStepKey;
  label: string;
};

const PIPELINE_STEPS: StepDefinition[] = [
  { key: 'upload_complete', label: 'Upload complete' },
  { key: 'transcribing', label: 'Transcribing' },
  { key: 'analyzing_transcript', label: 'Analyzing transcript' },
  { key: 'generating_clips', label: 'Generating clips' },
  { key: 'ranking_candidates', label: 'Ranking candidates' },
  { key: 'detecting_facecam', label: 'Detecting facecam' },
  { key: 'applying_edits', label: 'Applying edits' },
  { key: 'rendering_clips', label: 'Rendering clips' },
  { key: 'generating_previews', label: 'Generating previews' },
  { key: 'finalizing', label: 'Finalizing' },
];

export type ProjectProcessingStepState = StepDefinition & {
  status: 'complete' | 'current' | 'upcoming';
};

export type ProjectProcessingDisplayStep = {
  key: 'preparing_clips' | 'finding_highlights' | 'creating_clips' | 'finalizing';
  label: string;
  status: 'complete' | 'current' | 'upcoming';
};

export type ProjectProcessingState = {
  isFailed: boolean;
  failedStage: 'transcription' | 'clip_generation' | null;
  failureReason: string | null;
  isProcessing: boolean;
  executionStatus: 'queued' | 'processing' | null;
  isSetupRequired: boolean;
  isReadyLike: boolean;
  currentStepKey: ProjectProcessingStepKey | null;
  currentStepLabel: string | null;
  etaSeconds: number | null;
  steps: ProjectProcessingStepState[];
  displaySteps: ProjectProcessingDisplayStep[];
};

function getStepStates(currentStepKey: ProjectProcessingStepKey | null) {
  const currentIndex = PIPELINE_STEPS.findIndex(
    (step) => step.key === currentStepKey
  );

  return PIPELINE_STEPS.map((step, index) => ({
    ...step,
    status:
      currentIndex === -1
        ? 'upcoming'
        : index < currentIndex
          ? 'complete'
          : index === currentIndex
            ? 'current'
            : 'upcoming',
  })) satisfies ProjectProcessingStepState[];
}

const DISPLAY_STEP_DEFINITIONS = [
  { key: 'preparing_clips', label: 'Preparing clips' },
  { key: 'finding_highlights', label: 'Finding highlights' },
  { key: 'creating_clips', label: 'Creating clips' },
  { key: 'finalizing', label: 'Finalizing' },
] satisfies Omit<ProjectProcessingDisplayStep, 'status'>[];

function getDisplayStepIndex(
  currentStepKey: ProjectProcessingStepKey | null,
  executionStatus: 'queued' | 'processing' | null = null
) {
  switch (currentStepKey) {
    case 'upload_complete':
    case 'transcribing':
    case 'analyzing_transcript':
      return 0;
    case 'generating_clips':
      return executionStatus === 'queued' ? 0 : 1;
    case 'ranking_candidates':
      return 1;
    case 'detecting_facecam':
    case 'applying_edits':
    case 'rendering_clips':
      return 2;
    case 'generating_previews':
    case 'finalizing':
      return 3;
    default:
      return -1;
  }
}

export function deriveProjectProcessingDisplaySteps(
  currentStepKey: ProjectProcessingStepKey | null,
  executionStatus: 'queued' | 'processing' | null = null
) {
  const currentIndex = getDisplayStepIndex(currentStepKey, executionStatus);

  return DISPLAY_STEP_DEFINITIONS.map((step, index) => ({
    ...step,
    status:
      currentIndex === -1
        ? 'upcoming'
        : index < currentIndex
          ? 'complete'
          : index === currentIndex
            ? 'current'
            : 'upcoming',
  })) satisfies ProjectProcessingDisplayStep[];
}

function getLatestSourceAsset(project: ProjectSummary) {
  return project.sourceAssets[0] || null;
}

function getShortFormPackForAsset(
  project: ProjectSummary,
  sourceAssetId: number | null
) {
  const matchingPacks = project.contentPacks.filter(
    (pack) =>
      pack.kind === ContentPackKind.SHORT_FORM_CLIPS &&
      (sourceAssetId === null || pack.sourceAssetId === sourceAssetId)
  );

  if (matchingPacks.length > 0) {
    return matchingPacks[0];
  }

  return (
    project.contentPacks.find(
      (pack) => pack.kind === ContentPackKind.SHORT_FORM_CLIPS
    ) || null
  );
}

function getCurrentGenerationCandidates(pack: ProjectContentPack | null) {
  if (!pack || !pack.generationRunId) {
    return [];
  }

  return pack.clipCandidates.filter(
    (candidate) => candidate.generationRunId === pack.generationRunId
  );
}

function getUniqueRenderedClips(
  pack: ProjectContentPack | null,
  candidates: ProjectClipCandidate[]
) {
  if (!pack || !pack.generationRunId) {
    return [];
  }

  const clipMap = new Map<number, ProjectRenderedClip>();

  for (const clip of pack.renderedClips) {
    if (clip.generationRunId === pack.generationRunId) {
      clipMap.set(clip.id, clip);
    }
  }

  for (const candidate of candidates) {
    for (const clip of candidate.renderedClips || []) {
      if (clip.generationRunId === pack.generationRunId) {
        clipMap.set(clip.id, clip);
      }
    }
  }

  return [...clipMap.values()];
}

type JobScope = 'source' | 'generation' | 'candidate' | null;

function hasPositiveInteger(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value > 0;
}

function getJobScope(
  job: ProjectProcessingJob,
  sourceAssetId: number
): JobScope {
  switch (job.type as JobType) {
    case JobType.TRANSCRIBE_SOURCE_ASSET:
    case JobType.INGEST_YOUTUBE_SOURCE_ASSET:
      return 'source';
    case JobType.GENERATE_SHORT_FORM_PACK:
      return 'generation';
    case JobType.RENDER_CLIP_CANDIDATE:
    case JobType.FORMAT_RENDERED_CLIP_SHORT_FORM:
      return 'candidate';
    case JobType.DETECT_CLIP_FACECAM:
      return job.clipCandidateId === null &&
        hasPositiveInteger(job.videoId) &&
        job.videoId === sourceAssetId
        ? 'source'
        : job.clipCandidateId !== null
          ? 'candidate'
          : null;
    default:
      return null;
  }
}

function getActiveJobsForCurrentRun(
  project: ProjectSummary,
  sourceAssetId: number | null,
  contentPack: ProjectContentPack | null,
  currentCandidateIds: ReadonlySet<number>
) {
  if (sourceAssetId === null) {
    return [];
  }

  return (project.activeJobs || []).filter((job) => {
    if (
      ![JobStatus.PENDING, JobStatus.PROCESSING].includes(
        job.status as JobStatus
      ) ||
      job.sourceAssetId !== sourceAssetId
    ) {
      return false;
    }

    const scope = getJobScope(job, sourceAssetId);

    if (scope === 'source') {
      return true;
    }

    const hasCurrentGenerationIdentity =
      contentPack !== null &&
      job.contentPackId === contentPack.id &&
      job.generationRunId !== null &&
      job.generationRunId === contentPack.generationRunId;

    if (scope === 'generation') {
      return hasCurrentGenerationIdentity;
    }

    return (
      scope === 'candidate' &&
      hasCurrentGenerationIdentity &&
      hasPositiveInteger(job.clipCandidateId) &&
      currentCandidateIds.has(job.clipCandidateId)
    );
  });
}

function getJobStepKey(job: ProjectProcessingJob): ProjectProcessingStepKey {
  switch (job.type as JobType) {
    case JobType.TRANSCRIBE_SOURCE_ASSET:
    case JobType.INGEST_YOUTUBE_SOURCE_ASSET:
      return 'transcribing';
    case JobType.GENERATE_SHORT_FORM_PACK:
      return 'generating_clips';
    case JobType.DETECT_CLIP_FACECAM:
      return 'detecting_facecam';
    case JobType.RENDER_CLIP_CANDIDATE:
    case JobType.FORMAT_RENDERED_CLIP_SHORT_FORM:
      return 'rendering_clips';
    default:
      return 'finalizing';
  }
}

function getActiveJobPresentation(jobs: ProjectProcessingJob[]) {
  const stagePrecedence: Record<ProjectProcessingStepKey, number> = {
    upload_complete: 0,
    transcribing: 1,
    analyzing_transcript: 2,
    generating_clips: 3,
    ranking_candidates: 4,
    detecting_facecam: 5,
    applying_edits: 6,
    rendering_clips: 7,
    generating_previews: 8,
    finalizing: 9,
  };

  return jobs.reduce<{
    stepKey: ProjectProcessingStepKey;
    executionStatus: 'queued' | 'processing';
  } | null>((selected, job) => {
    const candidate = {
      stepKey: getJobStepKey(job),
      executionStatus: job.status === JobStatus.PROCESSING ? 'processing' as const : 'queued' as const,
    };

    if (!selected) {
      return candidate;
    }

    if (candidate.executionStatus !== selected.executionStatus) {
      return candidate.executionStatus === 'processing' ? candidate : selected;
    }

    return stagePrecedence[candidate.stepKey] < stagePrecedence[selected.stepKey]
      ? candidate
      : selected;
  }, null);
}

export function deriveProjectProcessingState(
  project: ProjectSummary
): ProjectProcessingState {
  const latestAsset = getLatestSourceAsset(project);
  const shortFormPack = getShortFormPackForAsset(project, latestAsset?.id ?? null);
  const clipCandidates = getCurrentGenerationCandidates(shortFormPack);
  const currentCandidateIds = new Set(clipCandidates.map((candidate) => candidate.id));
  const renderedClips = getUniqueRenderedClips(shortFormPack, clipCandidates);
  const transcriptStatus = latestAsset?.transcript?.status || null;
  const activeJobs = getActiveJobsForCurrentRun(
    project,
    latestAsset?.id ?? null,
    shortFormPack,
    currentCandidateIds
  );
  const activeJobPresentation = getActiveJobPresentation(activeJobs);
  const hasActiveWorkflowJob = activeJobPresentation !== null;
  const hasStoredFailure =
    latestAsset?.status === SourceAssetStatus.FAILED ||
    transcriptStatus === TranscriptStatus.FAILED ||
    shortFormPack?.status === ContentPackStatus.FAILED;
  // A current-run job is authoritative over a stale failed projection because it can be
  // an authorized recovery successor. Processing jobs win over queued jobs, then pipeline stage decides.
  const hasFailed = hasStoredFailure && !hasActiveWorkflowJob;
  const failedStage =
    hasFailed &&
    (latestAsset?.status === SourceAssetStatus.FAILED ||
      transcriptStatus === TranscriptStatus.FAILED)
      ? 'transcription'
      : hasFailed && shortFormPack?.status === ContentPackStatus.FAILED
        ? 'clip_generation'
        : null;
  const failureReason =
    failedStage === 'transcription'
      ? latestAsset?.transcript?.failureReason || latestAsset?.failureReason || null
      : failedStage === 'clip_generation'
        ? shortFormPack?.failureReason || null
        : null;
  const isReadyLike =
    !hasActiveWorkflowJob &&
    (shortFormPack?.status === ContentPackStatus.READY ||
      shortFormPack?.status === ContentPackStatus.PARTIALLY_READY);
  const isSetupRequired = Boolean(
    latestAsset &&
      !shortFormPack &&
      !hasFailed &&
      [SourceAssetType.UPLOADED_FILE, SourceAssetType.YOUTUBE_URL].includes(
        latestAsset.assetType as SourceAssetType
      )
  );
  const hasActiveFacecam = clipCandidates.some((candidate) =>
    [
      FacecamDetectionStatus.PENDING,
      FacecamDetectionStatus.DETECTING,
    ].includes(candidate.facecamDetectionStatus as FacecamDetectionStatus)
  );
  const hasPendingRenderedClips = renderedClips.some(
    (clip) => clip.status === RenderedClipStatus.PENDING
  );
  const hasRenderingClips = renderedClips.some(
    (clip) => clip.status === RenderedClipStatus.RENDERING
  );
  const hasActiveRenderWork = hasPendingRenderedClips || hasRenderingClips;
  const hasRenderedClipRecords = renderedClips.length > 0;

  let currentStepKey: ProjectProcessingStepKey | null = null;

  if (activeJobPresentation) {
    currentStepKey = activeJobPresentation.stepKey;
  } else if (
    shortFormPack?.status === ContentPackStatus.PARTIALLY_READY &&
    hasActiveRenderWork
  ) {
    currentStepKey = 'generating_previews';
  } else if (hasRenderingClips) {
    currentStepKey = 'rendering_clips';
  } else if (hasPendingRenderedClips) {
    currentStepKey = 'applying_edits';
  } else if (hasActiveFacecam) {
    currentStepKey = 'detecting_facecam';
  } else if (clipCandidates.length > 0 && !hasRenderedClipRecords) {
    currentStepKey = 'ranking_candidates';
  } else if (
    shortFormPack &&
    (transcriptStatus === TranscriptStatus.PENDING ||
      transcriptStatus === TranscriptStatus.PROCESSING)
  ) {
    currentStepKey = 'transcribing';
  } else if (
    shortFormPack?.status === ContentPackStatus.GENERATING &&
    clipCandidates.length === 0
  ) {
    currentStepKey = 'generating_clips';
  } else if (
    shortFormPack?.status === ContentPackStatus.PENDING &&
    clipCandidates.length === 0
  ) {
    currentStepKey = 'analyzing_transcript';
  } else if (
    shortFormPack &&
    (latestAsset?.status === SourceAssetStatus.UPLOADED ||
      latestAsset?.status === SourceAssetStatus.PROCESSING)
  ) {
    currentStepKey = 'upload_complete';
  } else if (
    shortFormPack &&
    !hasFailed &&
    !isReadyLike &&
    (clipCandidates.length > 0 || hasRenderedClipRecords)
  ) {
    currentStepKey = 'finalizing';
  }

  const isProcessing = !hasFailed && !isReadyLike && currentStepKey !== null;
  const currentDisplayStep = deriveProjectProcessingDisplaySteps(
    currentStepKey,
    activeJobPresentation?.executionStatus || null
  ).find(
    (step) => step.status === 'current'
  );

  return {
    isFailed: Boolean(hasFailed),
    failedStage,
    failureReason,
    isProcessing: isSetupRequired ? false : isProcessing,
    executionStatus: isSetupRequired ? null : activeJobPresentation?.executionStatus || null,
    isSetupRequired,
    isReadyLike: Boolean(isReadyLike),
    currentStepKey,
    currentStepLabel: currentDisplayStep?.label || null,
    etaSeconds: null,
    steps: getStepStates(currentStepKey),
    displaySteps: deriveProjectProcessingDisplaySteps(
      currentStepKey,
      activeJobPresentation?.executionStatus || null
    ),
  };
}
