import {
  ContentPackKind,
  ContentPackStatus,
  FacecamDetectionStatus,
  RenderedClipStatus,
  SourceAssetStatus,
  SourceAssetType,
  TranscriptStatus,
} from '../../../lib/db/schema.ts';

type ProjectSourceAsset = {
  id: number;
  assetType?: string;
  status: string;
  transcript: {
    status: string;
    failureReason: string | null;
  } | null;
};

type ProjectRenderedClip = {
  id: number;
  status: string;
};

type ProjectClipCandidate = {
  id: number;
  facecamDetectionStatus: string;
  renderedClips?: ProjectRenderedClip[];
};

type ProjectContentPack = {
  id: number;
  kind: string;
  sourceAssetId?: number;
  status: string;
  failureReason: string | null;
  clipCandidates: ProjectClipCandidate[];
  renderedClips: ProjectRenderedClip[];
};

type ProjectSummary = {
  sourceAssets: ProjectSourceAsset[];
  contentPacks: ProjectContentPack[];
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
  percent: number;
};

const PIPELINE_STEPS: StepDefinition[] = [
  { key: 'upload_complete', label: 'Upload complete', percent: 10 },
  { key: 'transcribing', label: 'Transcribing', percent: 22 },
  { key: 'analyzing_transcript', label: 'Analyzing transcript', percent: 34 },
  { key: 'generating_clips', label: 'Generating clips', percent: 48 },
  { key: 'ranking_candidates', label: 'Ranking candidates', percent: 60 },
  { key: 'detecting_facecam', label: 'Detecting facecam', percent: 72 },
  { key: 'applying_edits', label: 'Applying edits', percent: 82 },
  { key: 'rendering_clips', label: 'Rendering clips', percent: 90 },
  { key: 'generating_previews', label: 'Generating previews', percent: 95 },
  { key: 'finalizing', label: 'Finalizing', percent: 98 },
];

export type ProjectProcessingStepState = StepDefinition & {
  status: 'complete' | 'current' | 'upcoming';
};

export type ProjectProcessingDisplayStep = {
  key: 'uploading_video' | 'processing_video' | 'generating_clips' | 'finalizing_project';
  label: string;
  status: 'complete' | 'current' | 'upcoming';
};

export type ProjectProcessingState = {
  isFailed: boolean;
  isProcessing: boolean;
  isSetupRequired: boolean;
  isReadyLike: boolean;
  currentStepKey: ProjectProcessingStepKey | null;
  currentStepLabel: string | null;
  percentComplete: number;
  etaSeconds: number | null;
  steps: ProjectProcessingStepState[];
  displaySteps: ProjectProcessingDisplayStep[];
};

function getStepDefinition(key: ProjectProcessingStepKey | null) {
  return PIPELINE_STEPS.find((step) => step.key === key) || null;
}

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
  { key: 'uploading_video', label: 'Uploading video' },
  { key: 'processing_video', label: 'Processing video' },
  { key: 'generating_clips', label: 'Generating clips' },
  { key: 'finalizing_project', label: 'Finalizing project' },
] satisfies Omit<ProjectProcessingDisplayStep, 'status'>[];

function getDisplayStepIndex(currentStepKey: ProjectProcessingStepKey | null) {
  switch (currentStepKey) {
    case 'upload_complete':
      return 0;
    case 'transcribing':
    case 'analyzing_transcript':
      return 1;
    case 'generating_clips':
    case 'ranking_candidates':
    case 'detecting_facecam':
    case 'applying_edits':
      return 2;
    case 'rendering_clips':
    case 'generating_previews':
    case 'finalizing':
      return 3;
    default:
      return -1;
  }
}

export function deriveProjectProcessingDisplaySteps(
  currentStepKey: ProjectProcessingStepKey | null
) {
  const currentIndex = getDisplayStepIndex(currentStepKey);

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

function getUniqueRenderedClips(pack: ProjectContentPack | null) {
  if (!pack) {
    return [];
  }

  const clipMap = new Map<number, ProjectRenderedClip>();

  for (const clip of pack.renderedClips) {
    clipMap.set(clip.id, clip);
  }

  for (const candidate of pack.clipCandidates) {
    for (const clip of candidate.renderedClips || []) {
      clipMap.set(clip.id, clip);
    }
  }

  return [...clipMap.values()];
}

export function deriveProjectProcessingState(
  project: ProjectSummary
): ProjectProcessingState {
  const latestAsset = getLatestSourceAsset(project);
  const shortFormPack = getShortFormPackForAsset(project, latestAsset?.id ?? null);
  const renderedClips = getUniqueRenderedClips(shortFormPack);
  const clipCandidates = shortFormPack?.clipCandidates || [];
  const transcriptStatus = latestAsset?.transcript?.status || null;
  const hasFailed =
    latestAsset?.status === SourceAssetStatus.FAILED ||
    transcriptStatus === TranscriptStatus.FAILED ||
    shortFormPack?.status === ContentPackStatus.FAILED;
  const isReadyLike =
    shortFormPack?.status === ContentPackStatus.READY ||
    shortFormPack?.status === ContentPackStatus.PARTIALLY_READY;
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

  if (
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
  const currentStep = getStepDefinition(currentStepKey);

  return {
    isFailed: Boolean(hasFailed),
    isProcessing: isSetupRequired ? false : isProcessing,
    isSetupRequired,
    isReadyLike: Boolean(isReadyLike),
    currentStepKey,
    currentStepLabel: currentStep?.label || null,
    percentComplete: currentStep?.percent || 0,
    etaSeconds: null,
    steps: getStepStates(currentStepKey),
    displaySteps: deriveProjectProcessingDisplaySteps(currentStepKey),
  };
}
