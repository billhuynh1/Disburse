'use client';

import Link from 'next/link';
import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition
} from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import {
  CalendarDays,
  Captions,
  Check,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Copy,
  Crop,
  Download,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Filter,
  HardDrive,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  ScanFace,
  Scissors,
  Square,
  Share2,
  SplitSquareVertical,
  Star,
  ThumbsDown,
  Trash2,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { InlineSelect, type InlineSelectOption } from '@/components/ui/inline-select';
import { successToastIcon } from '@/components/ui/toaster';
import { ProgressBar } from '@/components/dashboard/dashboard-ui';
import { useToast } from '@/hooks/use-toast';
import {
  deleteProject,
  favoriteClipCandidate,
  publishRenderedClip,
  saveApprovedClip,
  saveProject,
  updateAutoSaveApprovedClipsSetting,
  updateClipCandidateTitle,
  updateClipCandidateReviewStatus
} from '@/lib/disburse/actions';
import {
  ClipCandidateReviewStatus,
  ContentPackStatus,
  FacecamDetectionStatus,
  RenderedClipLayout,
  RenderedClipVariant,
  ReusableAssetKind,
  SourceAssetStatus,
  SourceAssetType,
  TranscriptStatus
} from '@/lib/db/schema';
import { buildRenderedClipCaptionEvents } from '@/lib/disburse/rendered-clip-captions';
import { cn } from '@/lib/utils';
import { TRANSCRIPT_TRACKING_REFRESH_EVENT } from '@/components/dashboard/transcript-toast-watcher';
import { SourceAssetCreateForm } from './source-asset-create-form';

type ActionState = {
  error?: string;
  success?: string;
};

type EditorRenderedClip = {
  id: number;
  variant: string;
  layout: string;
  editConfigId: number | null;
  editConfigVersion: number | null;
  editConfigHash: string | null;
  status: string;
  title: string;
  durationMs: number;
  fileSizeBytes: number | null;
  retentionStatus: string | null;
  expiresAt: string | null;
  savedAt: string | null;
  deletedAt: string | null;
  storageDeletedAt: string | null;
  deletionReason: string | null;
  failureReason: string | null;
  publications: {
    id: number;
    platform: string;
    status: string;
    platformUrl: string | null;
    failureReason: string | null;
    linkedAccountId: number;
    linkedAccountName: string;
  }[];
};

type EditorClipCandidate = {
  id: number;
  contentPackId: number;
  contentPackName: string;
  sourceAssetId: number;
  sourceAssetTitle: string;
  sourceAssetType: string;
  sourceAssetStorageUrl: string;
  sourceAssetMimeType: string | null;
  sourceAssetRetentionStatus: string | null;
  sourceAssetExpiresAt: string | null;
  sourceAssetStorageDeletedAt: string | null;
  rank: number;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  hook: string;
  title: string;
  captionCopy: string;
  summary: string;
  transcriptExcerpt: string;
  transcriptSegments: {
    startTimeMs: number;
    endTimeMs: number;
    text: string;
  }[];
  transcriptWords: {
    startTimeMs: number;
    endTimeMs: number;
    text: string;
  }[];
  whyItWorks: string;
  platformFit: string;
  confidence: number;
  reviewStatus: string;
  facecamDetectionStatus: string;
  facecamDetectionFailureReason: string | null;
  facecamDetectedAt: string | null;
  facecamDetections: {
    id: number;
    rank: number;
    frameWidth: number;
    frameHeight: number;
    xPx: number;
    yPx: number;
    widthPx: number;
    heightPx: number;
    confidence: number;
    sampledFrameCount: number;
  }[];
  editConfig: {
    id: number;
    aspectRatio: string;
    layout: string;
    layoutRatio: string | null;
    captionsEnabled: boolean;
    captionStyle: string;
    captionFontAssetId: number | null;
    facecamDetectionId: number | null;
    facecamDetected: boolean;
    autoEditPreset: string;
    autoEditAppliedAt: string | null;
    configVersion: number;
    configHash: string;
  } | null;
  renderedClips: EditorRenderedClip[];
};

type EditorSourceAsset = {
  id: number;
  title: string;
  assetType: string;
  originalFilename: string | null;
  storageUrl: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  status: string;
  retentionStatus: string | null;
  expiresAt: string | null;
  savedAt: string | null;
  deletedAt: string | null;
  storageDeletedAt: string | null;
  deletionReason: string | null;
  failureReason: string | null;
  transcriptStatus: string;
  transcriptSegmentCount: number;
  transcriptContent: string | null;
  transcriptLanguage: string | null;
  transcriptFailureReason: string | null;
  shortFormPackStatus: string | null;
  shortFormPackFailureReason: string | null;
};

type ProjectClipEditorProps = {
  project: {
    id: number;
    name: string;
    description: string | null;
    savedAt: string | null;
  };
  sourceAssets: EditorSourceAsset[];
  clipCandidates: EditorClipCandidate[];
  contentPacks: {
    id: number;
    name: string;
    status: string;
    sourceAssetId: number;
  }[];
  autoSaveApprovedClipsEnabled: boolean;
  subscriptionStatus: string | null;
};

type ReviewFilter = 'all' | 'pending' | 'approved' | 'rejected';
type AspectRatioPreset = '9_16' | '1_1' | '16_9';
type ClipView = 'list' | 'grid';
type HeaderFilter = 'favorited' | 'disliked';
type LayoutPreset =
  | RenderedClipLayout.PRESERVE_ASPECT
  | RenderedClipLayout.DEFAULT
  | RenderedClipLayout.FACECAM_TOP_50
  | RenderedClipLayout.FACECAM_TOP_40
  | RenderedClipLayout.FACECAM_TOP_30;

type LinkedPublishAccount = {
  id: number;
  platform: string;
  platformAccountName: string | null;
  platformAccountUsername: string | null;
  publishable: boolean;
  publishBlockedReason: string | null;
};

type LinkedAccountsResponse = {
  accounts?: LinkedPublishAccount[];
};

type EditorReusableAsset = {
  id: number;
  kind: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

type ReusableAssetsResponse = {
  assets?: EditorReusableAsset[];
};

const ASPECT_RATIO_PRESETS: { value: AspectRatioPreset; label: string }[] = [
  { value: '9_16', label: '9:16' },
  { value: '1_1', label: '1:1' },
  { value: '16_9', label: '16:9' }
];

const LAYOUT_PRESETS: { value: LayoutPreset; label: string }[] = [
  { value: RenderedClipLayout.PRESERVE_ASPECT, label: 'Default' },
  { value: RenderedClipLayout.DEFAULT, label: 'Fill' },
  { value: RenderedClipLayout.FACECAM_TOP_50, label: '50/50' },
  { value: RenderedClipLayout.FACECAM_TOP_40, label: '40/60' },
  { value: RenderedClipLayout.FACECAM_TOP_30, label: '30/70' }
];

const clipThumbnailFrameCache = new Map<string, string>();

const linkedAccountsFetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Failed to load linked accounts.');
  }

  return (await response.json()) as LinkedAccountsResponse;
};

const reusableAssetsFetcher = async (url: string) => {
  const response = await fetch(url, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error('Failed to load reusable assets.');
  }

  return (await response.json()) as ReusableAssetsResponse;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatAspectRatioPreset(preset: AspectRatioPreset) {
  return (
    ASPECT_RATIO_PRESETS.find((item) => item.value === preset)?.label || preset
  );
}

function getRenderedClipCardAspectClasses(preset: AspectRatioPreset) {
  if (preset === '1_1') {
    return {
      card: 'aspect-[1/1.24]',
      preview: 'aspect-square',
      maxWidth: 'max-w-full'
    };
  }

  if (preset === '16_9') {
    return {
      card: 'aspect-[16/14.75]',
      preview: 'aspect-video',
      maxWidth: 'max-w-full'
    };
  }

  return {
    card: 'aspect-[4/6.45]',
    preview: 'aspect-[9/16]',
    maxWidth: 'max-w-full'
  };
}

function formatLayoutPreset(preset: LayoutPreset | string) {
  return LAYOUT_PRESETS.find((item) => item.value === preset)?.label || preset;
}

function hasPremiumClipEditorFeatures(subscriptionStatus: string | null) {
  return (
    subscriptionStatus === 'active' || subscriptionStatus === 'trialing'
  );
}

function isFacecamLayout(layout: LayoutPreset | string) {
  return (
    layout === RenderedClipLayout.FACECAM_TOP_50 ||
    layout === RenderedClipLayout.FACECAM_TOP_40 ||
    layout === RenderedClipLayout.FACECAM_TOP_30
  );
}

function formatPublishPlatformLabel(platform: string) {
  if (platform === 'youtube') {
    return 'YouTube';
  }

  if (platform === 'tiktok') {
    return 'TikTok';
  }

  return platform.replaceAll('_', ' ');
}

function getRenderedClipVariantForAspectRatio(preset: AspectRatioPreset) {
  if (preset === '1_1') {
    return RenderedClipVariant.SQUARE_SHORT_FORM;
  }

  if (preset === '16_9') {
    return RenderedClipVariant.LANDSCAPE_SHORT_FORM;
  }

  return RenderedClipVariant.VERTICAL_SHORT_FORM;
}

function formatClipTimestamp(totalMs: number) {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return [minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function batchSceneAnalysisSegments(
  segments: {
    startTimeMs: number;
    endTimeMs: number;
    text: string;
  }[],
  groupSize = 3
) {
  if (segments.length <= 1) {
    return segments;
  }

  const batched: {
    startTimeMs: number;
    endTimeMs: number;
    text: string;
  }[] = [];

  for (let index = 0; index < segments.length; index += groupSize) {
    const group = segments.slice(index, index + groupSize);
    const first = group[0];
    const last = group.at(-1);

    if (!first || !last) {
      continue;
    }

    batched.push({
      startTimeMs: first.startTimeMs,
      endTimeMs: last.endTimeMs,
      text: group.map((segment) => segment.text).join(' ')
    });
  }

  return batched;
}

function formatReviewStatus(status: string) {
  if (status === ClipCandidateReviewStatus.APPROVED) {
    return 'Favorite';
  }

  if (status === ClipCandidateReviewStatus.DISCARDED) {
    return 'Rejected';
  }

  if (status === ClipCandidateReviewStatus.PENDING) {
    return 'Pending';
  }

  return status.replaceAll('_', ' ');
}

function filterCandidatesByReview(
  candidates: EditorClipCandidate[],
  filter: ReviewFilter
) {
  return candidates.filter((candidate) => {
    if (filter === 'approved') {
      return candidate.reviewStatus === ClipCandidateReviewStatus.APPROVED;
    }

    if (filter === 'rejected') {
      return candidate.reviewStatus === ClipCandidateReviewStatus.DISCARDED;
    }

    if (filter === 'pending') {
      return candidate.reviewStatus === ClipCandidateReviewStatus.PENDING;
    }

    return true;
  });
}

function filterCandidatesByHeaderFilters(
  candidates: EditorClipCandidate[],
  filters: HeaderFilter[]
) {
  if (filters.length === 0) {
    return candidates;
  }

  return candidates.filter((candidate) => {
    const isFavorited =
      candidate.reviewStatus === ClipCandidateReviewStatus.APPROVED;
    const isDisliked =
      candidate.reviewStatus === ClipCandidateReviewStatus.DISCARDED;

    return (
      (filters.includes('favorited') && isFavorited) ||
      (filters.includes('disliked') && isDisliked)
    );
  });
}

function getReviewStatusBadgeVariant(status: string): BadgeVariant {
  if (status === ClipCandidateReviewStatus.APPROVED) {
    return 'success';
  }

  if (status === ClipCandidateReviewStatus.DISCARDED) {
    return 'danger';
  }

  return 'neutral';
}

function EmptyClipWorkflowState({
  projectId,
  sourceAsset
}: {
  projectId: number;
  sourceAsset: EditorSourceAsset | null;
}) {
  if (!sourceAsset) {
    return (
      <CenteredWorkflowState
        title="Upload a source"
        description="Add source media before reviewing clip candidates."
        tone="muted"
      />
    );
  }

  if (
    sourceAsset.status === SourceAssetStatus.FAILED ||
    sourceAsset.transcriptStatus === TranscriptStatus.FAILED
  ) {
    return (
      <CenteredWorkflowState
        title="Transcript failed"
        description={
          sourceAsset.transcriptFailureReason ||
          sourceAsset.failureReason ||
          'Transcript processing failed.'
        }
        tone="error"
      />
    );
  }

  if (
    sourceAsset.transcriptStatus === TranscriptStatus.PENDING ||
    sourceAsset.transcriptStatus === TranscriptStatus.PROCESSING ||
    sourceAsset.status === SourceAssetStatus.UPLOADED ||
    sourceAsset.status === SourceAssetStatus.PROCESSING
  ) {
    return (
      <CenteredWorkflowState
        title="Preparing transcript"
        description="Transcript processing is still running."
        tone="loading"
      />
    );
  }

  if (
    sourceAsset.shortFormPackStatus === ContentPackStatus.PENDING ||
    sourceAsset.shortFormPackStatus === ContentPackStatus.GENERATING
  ) {
    return (
      <CenteredWorkflowState
        title="Generating clip candidates"
        description="This usually takes a few moments."
        tone="loading"
      />
    );
  }

  if (sourceAsset.shortFormPackStatus === ContentPackStatus.FAILED) {
    return (
      <CenteredWorkflowState
        title="Clip generation failed"
        description={
          sourceAsset.shortFormPackFailureReason ||
          'Clip candidates could not be generated.'
        }
        tone="error"
      />
    );
  }

  return (
    <CenteredWorkflowState
      title="Setup required"
      description="Configure clip generation from setup."
      tone="muted"
      actionHref={`/dashboard/projects/${projectId}/setup`}
      actionLabel="Open setup"
    />
  );
}

function hasActiveWorkflowState(sourceAssets: EditorSourceAsset[]) {
  return sourceAssets.some(
    (asset) =>
      asset.status === SourceAssetStatus.UPLOADED ||
      asset.status === SourceAssetStatus.PROCESSING ||
      asset.transcriptStatus === TranscriptStatus.PENDING ||
      asset.transcriptStatus === TranscriptStatus.PROCESSING ||
      asset.shortFormPackStatus === ContentPackStatus.PENDING ||
      asset.shortFormPackStatus === ContentPackStatus.GENERATING
  );
}

function CenteredWorkflowState({
  title,
  description,
  tone,
  actionHref,
  actionLabel
}: {
  title: string;
  description: string;
  tone: 'loading' | 'error' | 'muted';
  actionHref?: string;
  actionLabel?: string;
}) {
  const titleClass = tone === 'error' ? 'text-danger' : 'text-white';
  const descriptionClass = tone === 'error' ? 'text-danger/80' : 'text-zinc-400';

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="max-w-lg text-center">
        {tone === 'loading' ? (
          <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-blue-200" />
        ) : tone === 'error' ? (
          <X className="mx-auto mb-4 h-10 w-10 text-danger" />
        ) : (
          <Clapperboard className="mx-auto mb-4 h-10 w-10 text-blue-200" />
        )}
        <h2 className={cn('text-xl font-semibold', titleClass)}>{title}</h2>
        <p className={cn('mt-2 text-sm leading-6', descriptionClass)}>
          {description}
        </p>
        {actionHref && actionLabel ? (
          <Button asChild className="mt-5">
            <Link href={actionHref}>{actionLabel}</Link>
          </Button>
        ) : null}
      </div>
    </main>
  );
}

function getWorkflowStatusBadgeVariant(
  status: string | null | undefined
): BadgeVariant {
  if (status === 'ready' || status === 'approved') {
    return 'success';
  }

  if (status === 'failed' || status === 'discarded') {
    return 'danger';
  }

  if (
    status === 'pending' ||
    status === 'rendering' ||
    status === 'detecting' ||
    status === 'generating' ||
    status === 'processing'
  ) {
    return 'warning';
  }

  return 'neutral';
}

function getRenderedClip(
  candidate: EditorClipCandidate | null,
  variant: RenderedClipVariant,
  layout: LayoutPreset = RenderedClipLayout.DEFAULT,
  editConfigHash?: string | null
) {
  return (
    candidate?.renderedClips.find(
      (clip) =>
        clip.variant === variant &&
        clip.layout === layout &&
        (!editConfigHash || clip.editConfigHash === editConfigHash)
    ) || null
  );
}

function getDownloadableRenderedClip(
  candidate: EditorClipCandidate | null,
  aspectRatio: AspectRatioPreset,
  layout: LayoutPreset,
  editConfigHash?: string | null
) {
  const clip = getRenderedClip(
    candidate,
    getRenderedClipVariantForAspectRatio(aspectRatio),
    layout,
    editConfigHash
  );

  if (!clip || clip.status !== 'ready' || isMediaUnavailable(clip)) {
    return null;
  }

  return clip;
}

function getBestPreviewClipForCandidate(
  candidate: EditorClipCandidate | null,
  aspectRatio: AspectRatioPreset,
  layout: LayoutPreset,
  editConfigHash?: string | null
) {
  const selectedRatioClip = getRenderedClip(
    candidate,
    getRenderedClipVariantForAspectRatio(aspectRatio),
    layout,
    editConfigHash
  );
  const fallbackRenderedClip =
    candidate?.renderedClips.find(
      (clip) =>
        clip.variant !== RenderedClipVariant.TRIMMED_ORIGINAL &&
        clip.layout === layout &&
        (!editConfigHash || clip.editConfigHash === editConfigHash) &&
        clip.status === 'ready' &&
        !isMediaUnavailable(clip)
    ) || null;
  const trimmedClip = getRenderedClip(
    candidate,
    RenderedClipVariant.TRIMMED_ORIGINAL
  );

  return selectedRatioClip?.status === 'ready' && !isMediaUnavailable(selectedRatioClip)
    ? selectedRatioClip
    : fallbackRenderedClip
      ? fallbackRenderedClip
      : trimmedClip?.status === 'ready' && !isMediaUnavailable(trimmedClip)
        ? trimmedClip
        : null;
}

function parseYouTubeVideoId(url: string) {
  try {
    const parsed = new URL(url);

    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.replace(/\//g, '').trim() || null;
    }

    if (
      parsed.hostname === 'www.youtube.com' ||
      parsed.hostname === 'youtube.com' ||
      parsed.hostname === 'm.youtube.com'
    ) {
      return parsed.searchParams.get('v')?.trim() || null;
    }

    return null;
  } catch {
    return null;
  }
}

function formatMediaFragmentTime(totalMs: number) {
  return String(Math.max(0, Math.floor(totalMs / 1000)));
}

function hasFacecam(candidate: EditorClipCandidate | null) {
  return Boolean(
    candidate?.editConfig?.facecamDetected ||
      candidate?.facecamDetectionStatus === FacecamDetectionStatus.READY ||
      candidate?.facecamDetections.length
  );
}

function hasCandidateHook(hook: string) {
  return hook.trim().length > 0;
}

function scoreGrade(score: number) {
  if (score >= 90) {
    return { hook: 'A-', flow: 'B', value: 'A-', trend: 'C' };
  }

  if (score >= 75) {
    return { hook: 'B+', flow: 'B', value: 'B+', trend: 'C' };
  }

  return { hook: 'B', flow: 'C+', value: 'B-', trend: 'C' };
}

function isMediaUnavailable(media: {
  retentionStatus: string | null;
  storageDeletedAt: string | null;
}) {
  return (
    media.retentionStatus === 'expired' ||
    media.retentionStatus === 'deleted' ||
    Boolean(media.storageDeletedAt)
  );
}

function ExpirationCountdown({
  expiresAt,
  compact = false
}: {
  expiresAt: string | null;
  compact?: boolean;
}) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      return;
    }

    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [expiresAt]);

  if (!expiresAt) {
    return null;
  }

  if (now === null) {
    return (
      <Badge variant="warning">
        {compact ? '...' : 'Expires soon'}
      </Badge>
    );
  }

  const remainingMs = new Date(expiresAt).getTime() - now;

  if (remainingMs <= 0) {
    return (
      <Badge variant="danger">
        Expired
      </Badge>
    );
  }

  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const label =
    hours > 0
      ? `${hours}h ${minutes}m`
      : `${minutes}m ${String(seconds).padStart(2, '0')}s`;

  return (
    <Badge variant="warning">
      {compact ? label : `Expires in ${label}`}
    </Badge>
  );
}

function EmptyUploadWorkspace({
  project
}: {
  project: ProjectClipEditorProps['project'];
}) {
  return (
    <section className="flex h-full min-h-0 items-center bg-background px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="grid overflow-hidden rounded-xl border border-border/70 bg-card lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="flex min-h-[28rem] items-center bg-[linear-gradient(135deg,hsl(var(--shell)),hsl(var(--surface-2)))] p-8">
            <div>
              <Scissors className="mb-5 h-8 w-8 text-primary" />
              <h1 className="text-3xl font-semibold text-foreground">
                Add a source to start this project.
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                Upload a video, paste a YouTube link, or add transcript text. The
                setup step comes next.
              </p>
            </div>
          </div>
          <div className="bg-surface-1 p-4">
            <SourceAssetCreateForm projectId={project.id} variant="editor" />
          </div>
        </div>
      </div>
    </section>
  );
}

function CandidateClipCard({
  candidate,
  selected,
  onSelect
}: {
  candidate: EditorClipCandidate;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  const readyRenderCount = candidate.renderedClips.filter(
    (clip) => clip.status === 'ready'
  ).length;
  const facecamLabel =
    candidate.facecamDetectionStatus === FacecamDetectionStatus.READY
      ? 'Facecam'
      : candidate.facecamDetectionStatus === FacecamDetectionStatus.NOT_FOUND
        ? 'No facecam'
        : candidate.facecamDetectionStatus.replaceAll('_', ' ');

  return (
    <button
      type="button"
      onClick={() => onSelect(candidate.id)}
      className={cn(
        'w-full cursor-pointer overflow-hidden rounded-xl border bg-surface-1 text-left transition',
        selected
          ? 'border-primary/70 ring-2 ring-primary/20'
          : 'border-border/70 hover:border-primary/40'
      )}
    >
      <div className="relative aspect-video bg-[linear-gradient(135deg,hsl(var(--shell)),hsl(var(--primary)/0.28))]">
        <div className="absolute left-3 top-3 rounded-full bg-background/85 px-2 py-1 text-xs font-medium text-foreground">
          Clip {candidate.rank}
        </div>
        <div className="absolute right-3 top-3 rounded-full bg-background/85 px-2 py-1 text-xs font-medium text-primary">
          {candidate.confidence}%
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-background/80 text-primary">
            <Play className="h-5 w-5 fill-current" />
          </span>
        </div>
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <Badge variant={getReviewStatusBadgeVariant(candidate.reviewStatus)}>
            {formatReviewStatus(candidate.reviewStatus)}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            {formatClipTimestamp(candidate.startTimeMs)}-
            {formatClipTimestamp(candidate.endTimeMs)}
          </span>
        </div>
        <p className="line-clamp-2 text-sm font-medium text-foreground">
          {candidate.title}
        </p>
        {hasCandidateHook(candidate.hook) ? (
          <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
            {candidate.hook}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span>{Math.round(candidate.durationMs / 1000)}s</span>
          <span>{readyRenderCount} exports</span>
          <span className="capitalize">{facecamLabel}</span>
        </div>
      </div>
    </button>
  );
}

function CandidateClipList({
  candidates,
  selectedCandidateId,
  filter,
  onFilterChange,
  onSelect
}: {
  candidates: EditorClipCandidate[];
  selectedCandidateId: number | null;
  filter: ReviewFilter;
  onFilterChange: (filter: ReviewFilter) => void;
  onSelect: (id: number) => void;
}) {
  const counts = {
    all: candidates.length,
    pending: candidates.filter(
      (candidate) => candidate.reviewStatus === ClipCandidateReviewStatus.PENDING
    ).length,
    approved: candidates.filter(
      (candidate) => candidate.reviewStatus === ClipCandidateReviewStatus.APPROVED
    ).length,
    rejected: candidates.filter(
      (candidate) => candidate.reviewStatus === ClipCandidateReviewStatus.DISCARDED
    ).length
  };
  const filteredCandidates = candidates.filter((candidate) => {
    if (filter === 'approved') {
      return candidate.reviewStatus === ClipCandidateReviewStatus.APPROVED;
    }

    if (filter === 'rejected') {
      return candidate.reviewStatus === ClipCandidateReviewStatus.DISCARDED;
    }

    if (filter === 'pending') {
      return candidate.reviewStatus === ClipCandidateReviewStatus.PENDING;
    }

    return true;
  });

  return (
    <aside className="flex min-h-0 flex-col border-r border-border/70 bg-card">
      <div className="border-b border-border/70 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-primary">
          Clip queue
        </p>
        <h2 className="mt-1 text-lg font-semibold text-foreground">
          Clip candidates
        </h2>
        <div className="mt-4 grid grid-cols-4 gap-1">
          {(['all', 'pending', 'approved', 'rejected'] as ReviewFilter[]).map(
            (item) => (
              <button
                key={item}
                type="button"
                onClick={() => onFilterChange(item)}
                className={cn(
                  'cursor-pointer rounded-lg px-2 py-1.5 text-xs capitalize transition',
                  filter === item
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background/60 text-muted-foreground hover:text-foreground'
                )}
              >
                {item === 'approved' ? 'favorites' : item} {counts[item]}
              </button>
            )
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {filteredCandidates.length > 0 ? (
          filteredCandidates.map((candidate) => (
            <CandidateClipCard
              key={candidate.id}
              candidate={candidate}
              selected={candidate.id === selectedCandidateId}
              onSelect={onSelect}
            />
          ))
        ) : (
          <p className="rounded-xl border border-dashed border-border/80 p-4 text-sm leading-6 text-muted-foreground">
            No clips in this filter.
          </p>
        )}
      </div>
    </aside>
  );
}

function CandidateStrip({
  candidates,
  selectedCandidateId,
  selectedCandidateIds,
  filter,
  onFilterChange,
  onSelect,
  onOpenSelectionModal,
  projectId,
  projectName,
  transcriptContent,
  autoSaveApprovedClipsEnabled
}: {
  candidates: EditorClipCandidate[];
  selectedCandidateId: number | null;
  selectedCandidateIds: number[];
  filter: ReviewFilter;
  onFilterChange: (filter: ReviewFilter) => void;
  onSelect: (id: number) => void;
  onOpenSelectionModal: () => void;
  projectId: number;
  projectName: string;
  transcriptContent: string | null;
  autoSaveApprovedClipsEnabled: boolean;
}) {
  const filterOptions: InlineSelectOption[] = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Favorites' },
    { value: 'rejected', label: 'Rejected' }
  ];
  const filteredCandidates = candidates.filter((candidate) => {
    if (filter === 'approved') {
      return candidate.reviewStatus === ClipCandidateReviewStatus.APPROVED;
    }

    if (filter === 'rejected') {
      return candidate.reviewStatus === ClipCandidateReviewStatus.DISCARDED;
    }

    if (filter === 'pending') {
      return candidate.reviewStatus === ClipCandidateReviewStatus.PENDING;
    }

    return true;
  });

  return (
    <div className="border-b border-white/5 px-4 py-3">
      <div className="mx-auto flex max-w-[68rem] items-center gap-3 overflow-x-auto">
        <span className="shrink-0 text-sm text-blue-200">
          Original clips ({candidates.length})
        </span>
        <div className="h-4 w-px shrink-0 bg-white/10" />
        <InlineSelect
          name="clip-filter"
          value={filter}
          defaultValue={filter}
          options={filterOptions}
          ariaLabel="Clip filter"
          className="shrink-0 text-xs font-medium text-zinc-300 hover:text-white"
          onValueChange={(value) => onFilterChange(value as ReviewFilter)}
        />
        {filteredCandidates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => onSelect(candidate.id)}
            className={cn(
              'cursor-pointer shrink-0 rounded-md border px-3 py-1 text-xs transition',
              candidate.id === selectedCandidateId
                ? 'border-blue-300 bg-blue-300/15 text-blue-100'
                : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:text-white'
            )}
          >
            {candidate.rank}
          </button>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {selectedCandidateIds.length > 0 ? (
            <span className="text-xs text-zinc-400">
              {selectedCandidateIds.length} selected
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 border-white/10 bg-white/[0.04] text-white hover:bg-white/10 hover:text-white"
            onClick={onOpenSelectionModal}
          >
            Select
          </Button>
        </div>
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <SaveProjectControl projectId={projectId} />
          <AutoSaveApprovedClipsControl enabled={autoSaveApprovedClipsEnabled} />
          <ProjectQuickActions 
            projectId={projectId} 
            projectName={projectName} 
            transcriptContent={transcriptContent} 
          />
        </div>
      </div>
    </div>
  );
}

function CompactClipSelector({
  candidates,
  selectedCandidateId,
  onSelect,
}: {
  candidates: EditorClipCandidate[];
  selectedCandidateId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="mb-6 flex flex-wrap gap-2">
      {candidates.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          onClick={() => onSelect(candidate.id)}
          className={cn(
            'cursor-pointer rounded-md border px-3 py-2 text-left text-sm transition',
            candidate.id === selectedCandidateId
              ? 'border-primary/50 bg-primary/15 text-primary'
              : 'border-border/70 bg-surface-1 text-muted-foreground hover:border-primary/30 hover:text-foreground'
          )}
        >
          <span className="font-medium">Clip {candidate.rank}</span>
          <span className="ml-2 text-xs">
            {formatClipTimestamp(candidate.durationMs)}
          </span>
        </button>
      ))}
    </div>
  );
}

function RenderedClipCard({
  projectId,
  candidate,
  aspectRatio,
  layout,
  captionsEnabled,
  captionFontAssetId,
  onOpenEditor,
}: {
  projectId: number;
  candidate: EditorClipCandidate;
  aspectRatio: AspectRatioPreset;
  layout: LayoutPreset;
  captionsEnabled: boolean;
  captionFontAssetId: number | null;
  onOpenEditor: (candidateId: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const cardAspectClasses = getRenderedClipCardAspectClasses(aspectRatio);
  const previewClip = getBestPreviewClipForCandidate(
    candidate,
    aspectRatio,
    layout,
    candidate.editConfig?.configHash || null
  );
  const sourceMediaUnavailable = isMediaUnavailable({
    retentionStatus: candidate.sourceAssetRetentionStatus,
    storageDeletedAt: candidate.sourceAssetStorageDeletedAt,
  });
  const startSeconds = formatMediaFragmentTime(candidate.startTimeMs);
  const endSeconds = formatMediaFragmentTime(candidate.endTimeMs);
  const youtubeVideoId =
    candidate.sourceAssetType === SourceAssetType.YOUTUBE_URL
      ? parseYouTubeVideoId(candidate.sourceAssetStorageUrl)
      : null;
  const canPreviewUploadedSource =
    candidate.sourceAssetType === SourceAssetType.UPLOADED_FILE &&
    !sourceMediaUnavailable &&
    (!candidate.sourceAssetMimeType ||
      candidate.sourceAssetMimeType.startsWith('video/'));
  const sourcePreviewUrl = canPreviewUploadedSource
    ? `/api/source-assets/${candidate.sourceAssetId}/media#t=${startSeconds},${endSeconds}`
    : null;
  const youtubeThumbnailUrl = youtubeVideoId
    ? `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`
    : null;
  const playbackDuration = duration > 0 ? duration : candidate.durationMs / 1000;
  const playbackProgress =
    playbackDuration > 0
      ? Math.min(100, Math.max(0, (currentTime / playbackDuration) * 100))
      : 0;

  const handleTogglePlay = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.paused) {
      try {
        await video.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
      return;
    }

    video.pause();
    setIsPlaying(false);
  };

  const handleQuickAction = (
    event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>
  ) => {
    event.stopPropagation();
  };

  const seekToPosition = (clientX: number, element: HTMLButtonElement) => {
    const video = videoRef.current;

    if (!video || playbackDuration <= 0) {
      return;
    }

    const rect = element.getBoundingClientRect();
    const seekRatio = Math.min(
      1,
      Math.max(0, (clientX - rect.left) / rect.width)
    );
    video.currentTime = seekRatio * playbackDuration;
    setCurrentTime(video.currentTime);
  };

  const handleSeekPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    seekToPosition(event.clientX, event.currentTarget);
  };

  const handleSeekPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    if (!(event.buttons & 1)) {
      return;
    }

    seekToPosition(event.clientX, event.currentTarget);
  };

  const handleSeekClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenEditor(candidate.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenEditor(candidate.id);
        }
      }}
      className={cn(
        'group relative w-full cursor-pointer rounded-lg bg-transparent text-left text-white outline-none transition hover:bg-[#17171b] focus-visible:ring-2 focus-visible:ring-primary/60',
        cardAspectClasses.card,
        cardAspectClasses.maxWidth
      )}
    >
      <div className="absolute left-3 top-3 z-20 opacity-0 transition group-hover:opacity-100">
        <FavoriteControls
          projectId={projectId}
          candidate={candidate}
          selectedAspectRatio={aspectRatio}
          selectedLayout={layout}
          captionsEnabled={captionsEnabled}
          captionFontAssetId={captionFontAssetId}
          className="grid-cols-1 gap-3"
          buttonClassName="size-11 cursor-pointer rounded-full border-white/10 bg-black/50 text-white shadow-[0_10px_25px_rgba(0,0,0,0.35)] hover:bg-black/70 hover:text-white sm:size-12"
          iconClassName="h-5 w-5"
        />
      </div>
      <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-lg bg-[#242428]/95 px-2.5 py-1 text-xs font-semibold tabular-nums text-white opacity-100 shadow-sm transition duration-200 sm:text-sm">
        {formatClipTimestamp(Math.round(currentTime * 1000))}{' '}
        <span className="text-white/50">
          {formatClipTimestamp(candidate.durationMs)}
        </span>
      </div>
      <div className="grid h-full grid-rows-[minmax(0,72fr)_minmax(0,28fr)]">
        <div className="min-h-0">
          <div className="relative h-full w-full">
            <div className="flex h-full w-full items-start justify-center overflow-hidden">
              <div
                className={cn(
                  'relative h-full max-h-full max-w-full origin-center rotate-90 overflow-hidden bg-black',
                  cardAspectClasses.preview
                )}
              >
                {previewClip ? (
                  <video
                    ref={videoRef}
                    key={`rendered-card-${previewClip.id}`}
                    preload="metadata"
                    className="h-full w-full bg-black object-contain"
                    src={`/api/rendered-clips/${previewClip.id}/download`}
                    playsInline
                    onLoadedMetadata={(event) => {
                      setDuration(event.currentTarget.duration || 0);
                    }}
                    onTimeUpdate={(event) => {
                      setCurrentTime(event.currentTarget.currentTime || 0);
                    }}
                    onEnded={() => setIsPlaying(false)}
                    onPause={() => setIsPlaying(false)}
                    onPlay={() => setIsPlaying(true)}
                  />
                ) : sourcePreviewUrl ? (
                  <SourceCandidateThumbnail
                    key={`source-card-${candidate.id}`}
                    src={sourcePreviewUrl}
                    startTimeMs={candidate.startTimeMs}
                  />
                ) : youtubeThumbnailUrl ? (
                  <img
                    key={`youtube-card-${candidate.id}`}
                    src={youtubeThumbnailUrl}
                    alt=""
                    className="h-full w-full bg-black object-contain"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(160deg,#1a1f35,#101015_48%,#233b2f)] p-5 text-center">
                    <span className="flex size-12 items-center justify-center rounded-full bg-white text-blue-700">
                      <Play className="h-6 w-6 fill-current" />
                    </span>
                  </div>
                )}
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/25 via-transparent to-black/45 opacity-0 transition duration-200 group-hover:opacity-100" />
                {previewClip ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleTogglePlay}
                        className="absolute left-1/2 top-1/2 z-10 flex size-11 cursor-pointer -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-[0_18px_50px_rgba(0,0,0,0.4)] transition duration-200 hover:scale-[1.03] group-hover:opacity-100 sm:size-12 lg:size-14"
                        aria-label={isPlaying ? `Pause clip ${candidate.rank}` : `Play clip ${candidate.rank}`}
                      >
                        {isPlaying ? (
                          <span className="h-4 w-3 border-x-[3px] border-current sm:h-5 sm:w-3.5 lg:h-5 lg:w-4" />
                        ) : (
                          <Play className="ml-0.5 h-5 w-5 fill-current sm:h-6 sm:w-6 lg:h-7 lg:w-7" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{isPlaying ? 'Pause' : 'Play'}</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
            </div>
            {previewClip ? (
              <button
                type="button"
                onClick={handleSeekClick}
                onPointerDown={handleSeekPointerDown}
                onPointerMove={handleSeekPointerMove}
                className="absolute inset-x-0 bottom-0 z-20 flex h-2 items-end cursor-pointer opacity-0 transition duration-200 group-hover:opacity-100"
                aria-label={`Seek clip ${candidate.rank}`}
              >
                <span className="block h-2 w-full overflow-hidden rounded-full bg-white/20">
                  <span
                    className="block h-full rounded-full bg-white transition-[width]"
                    style={{ width: `${playbackProgress}%` }}
                  />
                </span>
              </button>
            ) : null}
          </div>
        </div>

        <div className="grid min-h-0 content-start grid-rows-[auto_1fr] gap-1.5 px-4 pb-10 pt-0 sm:px-5 sm:pb-14 sm:pt-0">
          <div className="flex items-center justify-center gap-5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleQuickAction}
                  className="cursor-pointer text-white/85 hover:bg-white/10 hover:text-white"
                  aria-label={`Schedule clip ${candidate.rank}`}
                >
                  <CalendarDays className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Schedule</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'cursor-pointer text-white/85 hover:bg-white/10 hover:text-white',
                    !previewClip && 'pointer-events-none opacity-40'
                  )}
                >
                  <a
                    href={previewClip ? `/api/rendered-clips/${previewClip.id}/download?download=1` : '#'}
                    onClick={handleQuickAction}
                    aria-label={`Download clip ${candidate.rank}`}
                  >
                    <Download className="h-5 w-5" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={(event) => {
                    handleQuickAction(event);
                    onOpenEditor(candidate.id);
                  }}
                  className="cursor-pointer text-white/85 hover:bg-white/10 hover:text-white"
                  aria-label={`Edit clip ${candidate.rank}`}
                >
                  <Scissors className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
          </div>
          <div>
            <p className="line-clamp-3 text-sm font-medium leading-5 text-white sm:text-[15px] sm:leading-5">
              {candidate.title}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function RenderedClipGrid({
  projectId,
  candidates,
  aspectRatio,
  layout,
  captionsEnabled,
  captionFontAssetId,
  onOpenEditor,
}: {
  projectId: number;
  candidates: EditorClipCandidate[];
  aspectRatio: AspectRatioPreset;
  layout: LayoutPreset;
  captionsEnabled: boolean;
  captionFontAssetId: number | null;
  onOpenEditor: (candidateId: number) => void;
}) {
  const gridClassName =
    aspectRatio === '16_9'
      ? 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] gap-1.5 sm:gap-2'
      : aspectRatio === '1_1'
        ? 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,14.25rem),1fr))] gap-2 sm:gap-2.5'
        : 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,13.5rem),1fr))] gap-2 sm:gap-2.5';

  return (
    <div className={gridClassName}>
      {candidates.map((candidate) => (
        <RenderedClipCard
          key={candidate.id}
          projectId={projectId}
          candidate={candidate}
          aspectRatio={aspectRatio}
          layout={layout}
          captionsEnabled={captionsEnabled}
          captionFontAssetId={captionFontAssetId}
          onOpenEditor={onOpenEditor}
        />
      ))}
    </div>
  );
}

function InlineClipWorkspaceCard({
  projectId,
  candidate,
  activeSourceTranscript,
  hasPremiumFeatures,
}: {
  projectId: number;
  candidate: EditorClipCandidate;
  activeSourceTranscript: string | null;
  hasPremiumFeatures: boolean;
}) {
  const [selectedAspectRatio, setSelectedAspectRatio] =
    useState<AspectRatioPreset>('9_16');
  const [selectedLayout, setSelectedLayout] = useState<LayoutPreset>(
    RenderedClipLayout.PRESERVE_ASPECT
  );
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [captionFontAssetId, setCaptionFontAssetId] = useState<number | null>(
    null
  );
  const [activeTab, setActiveTab] = useState<'clips' | 'preview' | 'actions'>(
    'preview'
  );
  const selectedEditConfig = candidate.editConfig || null;

  useEffect(() => {
    if (!selectedEditConfig) {
      setSelectedAspectRatio('9_16');
      setSelectedLayout(RenderedClipLayout.PRESERVE_ASPECT);
      setCaptionsEnabled(true);
      setCaptionFontAssetId(null);
      return;
    }

    if (
      selectedEditConfig.aspectRatio === '9_16' ||
      selectedEditConfig.aspectRatio === '1_1' ||
      selectedEditConfig.aspectRatio === '16_9'
    ) {
      setSelectedAspectRatio(selectedEditConfig.aspectRatio);
    }

    if (
      selectedEditConfig.layout === RenderedClipLayout.PRESERVE_ASPECT ||
      selectedEditConfig.layout === RenderedClipLayout.DEFAULT ||
      selectedEditConfig.layout === RenderedClipLayout.FACECAM_TOP_50 ||
      selectedEditConfig.layout === RenderedClipLayout.FACECAM_TOP_40 ||
      selectedEditConfig.layout === RenderedClipLayout.FACECAM_TOP_30
    ) {
      setSelectedLayout(selectedEditConfig.layout);
    }

    setCaptionsEnabled(selectedEditConfig.captionsEnabled);
    setCaptionFontAssetId(selectedEditConfig.captionFontAssetId);
  }, [selectedEditConfig, candidate.id]);

  useEffect(() => {
    setActiveTab('preview');
  }, [candidate.id]);

  useEffect(() => {
    if (isFacecamLayout(selectedLayout) && !hasFacecam(candidate)) {
      setSelectedLayout(RenderedClipLayout.PRESERVE_ASPECT);
    }
  }, [candidate, selectedLayout]);

  return (
    <div className="bg-transparent px-4 py-6">
      <ProjectClipEditorWorkspace
        projectId={projectId}
        candidate={candidate}
        activeSourceTranscript={activeSourceTranscript}
        selectedAspectRatio={selectedAspectRatio}
        selectedLayout={selectedLayout}
        captionsEnabled={captionsEnabled}
        captionFontAssetId={captionFontAssetId}
        onAspectRatioChange={setSelectedAspectRatio}
        onLayoutChange={setSelectedLayout}
        onCaptionsEnabledChange={setCaptionsEnabled}
        onCaptionFontAssetChange={setCaptionFontAssetId}
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
        compact
        hasPremiumFeatures={hasPremiumFeatures}
        className="bg-transparent"
      />
    </div>
  );
}

function InlineClipWorkspaceList({
  projectId,
  candidates,
  activeSourceTranscript,
  hasPremiumFeatures,
}: {
  projectId: number;
  candidates: EditorClipCandidate[];
  activeSourceTranscript: string | null;
  hasPremiumFeatures: boolean;
}) {
  return (
    <div className="space-y-4">
      {candidates.map((candidate) => (
        <InlineClipWorkspaceCard
          key={candidate.id}
          projectId={projectId}
          candidate={candidate}
          activeSourceTranscript={activeSourceTranscript}
          hasPremiumFeatures={hasPremiumFeatures}
        />
      ))}
    </div>
  );
}

function SelectClipsDialog({
  open,
  onOpenChange,
  candidates,
  selectedCandidateIds,
  onToggleCandidate,
  onToggleAll,
  onDownloadSelected,
  downloadSelectionDisabled
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: EditorClipCandidate[];
  selectedCandidateIds: number[];
  onToggleCandidate: (candidateId: number) => void;
  onToggleAll: () => void;
  onDownloadSelected: () => void;
  downloadSelectionDisabled: boolean;
}) {
  const allSelected =
    candidates.length > 0 && selectedCandidateIds.length === candidates.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[92vh] w-[min(72vw,44rem)] max-w-[72vw] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:h-[92vh] sm:max-w-[72vw] xl:max-w-[44rem] border-white/10 bg-[#0b0b0d] p-0 text-white">
        <DialogHeader className="px-4 py-4">
          <div className="space-y-4">
            <DialogTitle>Select clips</DialogTitle>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-zinc-400">
                {selectedCandidateIds.length} selected
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-zinc-300 hover:bg-white/10 hover:text-white"
                onClick={onToggleAll}
                disabled={candidates.length === 0}
              >
                {allSelected ? 'Clear all' : 'Select all'}
              </Button>
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-4 py-4">
          {candidates.length > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {candidates.map((candidate) => {
                const isSelected = selectedCandidateIds.includes(candidate.id);
                const youtubeVideoId =
                  candidate.sourceAssetType === SourceAssetType.YOUTUBE_URL
                    ? parseYouTubeVideoId(candidate.sourceAssetStorageUrl)
                    : null;
                const sourcePreviewUrl =
                  candidate.sourceAssetType === SourceAssetType.UPLOADED_FILE &&
                  (!candidate.sourceAssetMimeType ||
                    candidate.sourceAssetMimeType.startsWith('video/'))
                    ? `/api/source-assets/${candidate.sourceAssetId}/media`
                    : null;
                const youtubeThumbnailUrl = youtubeVideoId
                  ? `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`
                  : null;

                return (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => onToggleCandidate(candidate.id)}
                    className={cn(
                      'relative cursor-pointer overflow-hidden rounded-lg border bg-white/[0.03] text-left transition',
                      isSelected
                        ? 'border-primary/60 ring-2 ring-primary/20'
                        : 'border-white/10 hover:border-white/20'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute right-3 top-3 z-10 flex size-6 items-center justify-center rounded-full border text-primary-foreground transition',
                        isSelected
                          ? 'border-primary/40 bg-primary text-primary-foreground'
                          : 'border-white/20 bg-black/35 text-transparent'
                      )}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <div className="relative aspect-video overflow-hidden bg-[linear-gradient(135deg,hsl(var(--shell)),hsl(var(--primary)/0.28))]">
                      <div className="absolute left-2 top-2 rounded-full bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                        Clip {candidate.rank}
                      </div>
                      {sourcePreviewUrl ? (
                        <SourceCandidateThumbnail
                          src={sourcePreviewUrl}
                          startTimeMs={candidate.startTimeMs}
                        />
                      ) : youtubeThumbnailUrl ? (
                        <SourceCandidateThumbnail src={youtubeThumbnailUrl} />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(160deg,#1a1f35,#101015_48%,#233b2f)]">
                          <span className="flex size-10 items-center justify-center rounded-full bg-white text-blue-700">
                            <Play className="h-5 w-5 fill-current" />
                          </span>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-white/10 p-6 text-sm text-zinc-400">
              No clips available to select.
            </p>
          )}
        </div>
        <DialogFooter className="border-t border-white/10 px-6 py-4">
          <Button
            type="button"
            variant="outline"
            className="border-white/10 bg-white/[0.04] text-white hover:bg-white/10 hover:text-white"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
          <Button
            type="button"
            className="bg-white text-black hover:bg-white/90"
            onClick={onDownloadSelected}
            disabled={downloadSelectionDisabled}
          >
            <Download className="h-4 w-4" />
            Download selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FavoriteControls({
  projectId,
  candidate,
  selectedAspectRatio,
  selectedLayout,
  captionsEnabled,
  captionFontAssetId,
  className,
  buttonClassName,
  iconClassName
}: {
  projectId: number;
  candidate: EditorClipCandidate;
  selectedAspectRatio: AspectRatioPreset;
  selectedLayout: LayoutPreset;
  captionsEnabled: boolean;
  captionFontAssetId: number | null;
  className?: string;
  buttonClassName?: string;
  iconClassName?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [
    favoriteState,
    favoriteFormAction,
    isFavoritePending
  ] = useActionState<ActionState, FormData>(
    favoriteClipCandidate,
    {}
  );
  const [rejectState, rejectFormAction, isRejectPending] = useActionState<ActionState, FormData>(
    updateClipCandidateReviewStatus,
    {}
  );

  useEffect(() => {
    if (favoriteState.success) {
      toast({
        title: 'Clip favorited',
        description: favoriteState.success,
        icon: successToastIcon
      });
      router.refresh();
      return;
    }

    if (favoriteState.error) {
      toast({
        title: 'Unable to favorite clip',
        description: favoriteState.error,
        variant: 'destructive'
      });
    }
  }, [favoriteState.error, favoriteState.success, router, toast]);

  useEffect(() => {
    if (rejectState.success) {
      toast({
        title: 'Clip updated',
        description: rejectState.success,
        icon: successToastIcon
      });
      router.refresh();
      return;
    }

    if (rejectState.error) {
      toast({
        title: 'Unable to update clip',
        description: rejectState.error,
        variant: 'destructive'
      });
    }
  }, [rejectState.error, rejectState.success, router, toast]);

  return (
    <div className={cn('grid grid-cols-2 gap-2', className)}>
      <form action={favoriteFormAction}>
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="contentPackId" value={candidate.contentPackId} />
        <input type="hidden" name="clipCandidateId" value={candidate.id} />
        <input type="hidden" name="aspectRatio" value={selectedAspectRatio} />
        <input type="hidden" name="layout" value={selectedLayout} />
        <input
          type="hidden"
          name="captionsEnabled"
          value={String(captionsEnabled)}
        />
        <input
          type="hidden"
          name="captionFontAssetId"
          value={captionFontAssetId ?? ''}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              disabled={isFavoritePending}
              variant="outline"
              size="icon"
              className={cn(
                'w-full border-white/10 bg-[#161618] text-white hover:bg-[#202024] hover:text-warning',
                buttonClassName
              )}
            >
              {isFavoritePending ? (
                <Loader2 className={cn('h-4 w-4 animate-spin', iconClassName)} />
              ) : (
                <Star className={cn('h-4 w-4', iconClassName)} />
              )}
              <span className="sr-only">Favorite</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Favorite this clip</TooltipContent>
        </Tooltip>
      </form>
      <form action={rejectFormAction}>
        <input type="hidden" name="contentPackId" value={candidate.contentPackId} />
        <input type="hidden" name="clipCandidateId" value={candidate.id} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="submit"
            name="reviewStatus"
            value={ClipCandidateReviewStatus.DISCARDED}
            disabled={isRejectPending}
            variant="outline"
            size="icon"
            className={cn(
              'w-full border-white/10 bg-[#161618] text-white hover:bg-[#202024] hover:text-danger',
              buttonClassName
            )}
          >
            {isRejectPending ? (
              <Loader2 className={cn('h-4 w-4 animate-spin', iconClassName)} />
            ) : (
              <ThumbsDown className={cn('h-4 w-4', iconClassName)} />
            )}
            <span className="sr-only">Reject</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reject</TooltipContent>
      </Tooltip>
      </form>
    </div>
  );
}

function PaidBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute -right-1.5 -top-1.5 z-10 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black shadow-sm',
        className
      )}
    >
      paid
    </span>
  );
}

function RailTooltip({
  content,
  children
}: {
  content: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{content}</TooltipContent>
    </Tooltip>
  );
}

function ClipScorePanel({
  projectId,
  candidate,
  selectedAspectRatio,
  selectedLayout,
  captionsEnabled,
  captionFontAssetId,
  compact = false,
  hasPremiumFeatures = true,
}: {
  projectId: number;
  candidate: EditorClipCandidate;
  selectedAspectRatio: AspectRatioPreset;
  selectedLayout: LayoutPreset;
  captionsEnabled: boolean;
  captionFontAssetId: number | null;
  compact?: boolean;
  hasPremiumFeatures?: boolean;
}) {
  const grades = scoreGrade(candidate.confidence);
  const rows = [
    ['Hook', grades.hook],
    ['Flow', grades.flow],
    ['Value', grades.value],
    ['Trend', grades.trend]
  ];

  return (
    <div className="w-24 shrink-0 space-y-3">
      <FavoriteControls
        projectId={projectId}
        candidate={candidate}
        selectedAspectRatio={selectedAspectRatio}
        selectedLayout={selectedLayout}
        captionsEnabled={captionsEnabled}
        captionFontAssetId={captionFontAssetId}
        className={compact ? 'gap-2.5' : undefined}
        buttonClassName={compact ? 'h-10 rounded-lg' : undefined}
        iconClassName={compact ? 'h-4.5 w-4.5' : undefined}
      />
      <>
        <div className="text-center">
          <span className="text-3xl font-semibold text-success">
            {candidate.confidence}
          </span>
          <span className="text-sm font-semibold text-zinc-400">/100</span>
        </div>
        <div className="space-y-2">
          <div className="space-y-2 text-sm">
            {rows.map(([label, grade]) => (
              <div key={label} className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'font-semibold',
                    grade.startsWith('A')
                      ? 'text-success'
                      : grade.startsWith('B')
                        ? 'text-warning'
                        : 'text-warning'
                  )}
                >
                  {grade}
                </span>
                <span className="text-zinc-300">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </>
      <div className="space-y-2 border-t border-white/10 pt-3">
        <div className="flex flex-wrap justify-end gap-2">
          <Badge
            variant={getReviewStatusBadgeVariant(candidate.reviewStatus)}
            className={compact ? 'min-h-7 rounded-md bg-[#2b2b31] px-2.5 py-0.5 text-zinc-100' : undefined}
          >
            {formatReviewStatus(candidate.reviewStatus)}
          </Badge>
          <Badge
            variant="neutral"
            className={compact ? 'min-h-7 rounded-md bg-[#2b2b31] px-2.5 py-0.5 text-zinc-100' : undefined}
          >
            {formatAspectRatioPreset(selectedAspectRatio)}
          </Badge>
          <Badge
            variant="neutral"
            className={compact ? 'min-h-7 rounded-md bg-[#2b2b31] px-2.5 py-0.5 text-zinc-100' : undefined}
          >
            {formatLayoutPreset(selectedLayout)}
          </Badge>
        </div>
      </div>
    </div>
  );
}

function SourceCandidatePreview({
  src,
  startTimeMs,
  endTimeMs
}: {
  src: string;
  startTimeMs: number;
  endTimeMs: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const startSeconds = Math.max(0, startTimeMs / 1000);
  const endSeconds = Math.max(startSeconds, endTimeMs / 1000);

  const seekToStart = () => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    video.currentTime = startSeconds;
  };

  const handlePlay = () => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.currentTime >= endSeconds) {
      video.currentTime = startSeconds;
    }
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;

    if (!video || video.currentTime < endSeconds) {
      return;
    }

    video.pause();
  };

  return (
    <video
      ref={videoRef}
      controls
      preload="metadata"
      className="h-full w-full bg-black object-contain"
      src={src}
      onLoadedMetadata={seekToStart}
      onPlay={handlePlay}
      onTimeUpdate={handleTimeUpdate}
    />
  );
}

function SourceCandidateThumbnail({
  src,
  startTimeMs
}: {
  src: string;
  startTimeMs?: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cacheKey =
    startTimeMs === undefined ? null : `${src}::${Math.floor(startTimeMs)}`;
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(() =>
    cacheKey ? clipThumbnailFrameCache.get(cacheKey) || null : null
  );
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    if (startTimeMs === undefined) {
      setThumbnailSrc(null);
      setVideoFailed(false);
      return;
    }

    setThumbnailSrc(cacheKey ? clipThumbnailFrameCache.get(cacheKey) || null : null);
    setVideoFailed(false);
  }, [cacheKey, src, startTimeMs]);

  const shouldCaptureFrame =
    startTimeMs !== undefined && !thumbnailSrc && !videoFailed;

  return (
    <>
      {shouldCaptureFrame ? (
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full opacity-0"
          src={src}
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            const durationMs = Number.isFinite(video.duration) ? video.duration * 1000 : 0;
            const targetTimeSeconds = Math.max(
              0,
              Math.min(startTimeMs / 1000, Math.max(durationMs / 1000 - 0.1, 0))
            );

            if (Math.abs(video.currentTime - targetTimeSeconds) < 0.05) {
              const canvas = document.createElement('canvas');
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              const context = canvas.getContext('2d');

              if (!context || !cacheKey) {
                setVideoFailed(true);
                return;
              }

              context.drawImage(video, 0, 0, canvas.width, canvas.height);
              const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
              clipThumbnailFrameCache.set(cacheKey, dataUrl);
              setThumbnailSrc(dataUrl);
              return;
            }

            video.currentTime = targetTimeSeconds;
          }}
          onSeeked={() => {
            const video = videoRef.current;

            if (!video || !cacheKey) {
              setVideoFailed(true);
              return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d');

            if (!context) {
              setVideoFailed(true);
              return;
            }

            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            clipThumbnailFrameCache.set(cacheKey, dataUrl);
            setThumbnailSrc(dataUrl);
            video.pause();
          }}
          onError={() => {
            setVideoFailed(true);
          }}
        />
      ) : null}
      {thumbnailSrc || startTimeMs === undefined ? (
        <img
          className="h-full w-full bg-black object-cover"
          src={thumbnailSrc || src}
          alt=""
          loading="lazy"
        />
      ) : videoFailed ? (
        <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(160deg,#1a1f35,#101015_48%,#233b2f)]">
          <span className="flex size-10 items-center justify-center rounded-full bg-white text-blue-700">
            <Play className="h-5 w-5 fill-current" />
          </span>
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-black/70">
          <Loader2 className="h-5 w-5 animate-spin text-blue-200" />
        </div>
      )}
    </>
  );
}

function ClipPreviewPanel({
  candidate,
  previewClip,
  selectedRenderClip,
  selectedAspectRatio,
  selectedLayout,
  fullTranscript,
  compact = false,
}: {
  candidate: EditorClipCandidate | null;
  previewClip: EditorRenderedClip | null;
  selectedRenderClip: EditorRenderedClip | null;
  selectedAspectRatio: AspectRatioPreset;
  selectedLayout: LayoutPreset;
  fullTranscript: string | null;
  compact?: boolean;
}) {
  const [transcriptView, setTranscriptView] = useState<'clip' | 'full'>('clip');

  useEffect(() => {
    setTranscriptView('clip');
  }, [candidate?.id]);

  if (!candidate) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <Clapperboard className="mx-auto mb-4 h-10 w-10 text-primary" />
          <p className="text-lg font-semibold text-foreground">
            No clip selected
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Choose a candidate to preview, review, and export.
          </p>
        </div>
      </div>
    );
  }

  const sourceMediaUnavailable = isMediaUnavailable({
    retentionStatus: candidate.sourceAssetRetentionStatus,
    storageDeletedAt: candidate.sourceAssetStorageDeletedAt
  });
  const startSeconds = formatMediaFragmentTime(candidate.startTimeMs);
  const endSeconds = formatMediaFragmentTime(candidate.endTimeMs);
  const youtubeVideoId =
    candidate.sourceAssetType === SourceAssetType.YOUTUBE_URL
      ? parseYouTubeVideoId(candidate.sourceAssetStorageUrl)
      : null;
  const canPreviewUploadedSource =
    candidate.sourceAssetType === SourceAssetType.UPLOADED_FILE &&
    !sourceMediaUnavailable &&
    (!candidate.sourceAssetMimeType ||
      candidate.sourceAssetMimeType.startsWith('video/'));
  const sourcePreviewUrl = canPreviewUploadedSource
    ? `/api/source-assets/${candidate.sourceAssetId}/media#t=${startSeconds},${endSeconds}`
    : null;
  const youtubePreviewUrl = youtubeVideoId
    ? `https://www.youtube.com/embed/${youtubeVideoId}?start=${startSeconds}&end=${endSeconds}&rel=0`
    : null;
  const sceneAnalysisScrollRef = useRef<HTMLDivElement | null>(null);
  const [sceneAnalysisScrollState, setSceneAnalysisScrollState] = useState({
    hasOverflow: false,
    thumbHeight: 0,
    thumbTop: 0
  });
  const isSelectedRenderProcessing =
    selectedRenderClip?.status === 'pending' ||
    selectedRenderClip?.status === 'rendering';
  const selectedRenderFailed = selectedRenderClip?.status === 'failed';
  const previewLabel = isSelectedRenderProcessing
    ? 'Rendering clip'
    : previewClip
      ? 'Rendered clip'
      : selectedRenderFailed
        ? 'Render failed'
        : sourcePreviewUrl || youtubePreviewUrl
          ? 'Candidate preview'
          : 'No media preview';
  const trimmedFullTranscript = fullTranscript?.trim() || '';
  const showFullTranscript =
    transcriptView === 'full' && trimmedFullTranscript.length > 0;
  const excerptSegments = buildRenderedClipCaptionEvents({
    clipStartTimeMs: candidate.startTimeMs,
    clipDurationMs: candidate.durationMs,
    transcriptSegments: candidate.transcriptSegments,
    transcriptWords: candidate.transcriptWords,
    fallbackText: candidate.transcriptExcerpt
  });
  const sceneAnalysisSegments = batchSceneAnalysisSegments(
    excerptSegments.map((segment) => ({
      text: segment.text,
      startTimeMs: candidate.startTimeMs + segment.startTimeMs,
      endTimeMs: candidate.startTimeMs + segment.endTimeMs
    }))
  );

  useEffect(() => {
    const element = sceneAnalysisScrollRef.current;

    if (!element) {
      return;
    }

    const updateScrollState = () => {
      const { clientHeight, scrollHeight, scrollTop } = element;
      const hasOverflow = scrollHeight > clientHeight + 1;

      if (!hasOverflow) {
        setSceneAnalysisScrollState({
          hasOverflow: false,
          thumbHeight: 0,
          thumbTop: 0
        });
        return;
      }

      const thumbHeight = Math.max(
        28,
        (clientHeight / scrollHeight) * clientHeight
      );
      const maxThumbTop = clientHeight - thumbHeight;
      const thumbTop =
        scrollHeight === clientHeight
          ? 0
          : (scrollTop / (scrollHeight - clientHeight)) * maxThumbTop;

      setSceneAnalysisScrollState({
        hasOverflow: true,
        thumbHeight,
        thumbTop
      });
    };

    updateScrollState();

    const resizeObserver = new ResizeObserver(() => {
      updateScrollState();
    });

    resizeObserver.observe(element);

    if (element.firstElementChild instanceof HTMLElement) {
      resizeObserver.observe(element.firstElementChild);
    }

    element.addEventListener('scroll', updateScrollState, { passive: true });

    return () => {
      resizeObserver.disconnect();
      element.removeEventListener('scroll', updateScrollState);
    };
  }, [
    candidate.id,
    compact,
    sceneAnalysisSegments.length,
    showFullTranscript,
    trimmedFullTranscript
  ]);

  return (
    <section className="min-w-0 flex-1">
      <div
        className={cn(
          'grid min-w-0 overflow-hidden rounded-lg border border-white/10 gap-0',
          compact
            ? 'lg:grid-cols-[12.5rem_minmax(0,1fr)] xl:grid-cols-[13.75rem_minmax(0,1fr)]'
            : 'lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[15.25rem_minmax(0,1fr)]'
        )}
      >
        <div
          className={cn(
            'relative flex aspect-[9/16] items-center justify-center overflow-hidden rounded-lg',
            compact ? 'min-h-[22.25rem] bg-black' : 'min-h-[24rem] bg-black/70'
          )}
        >
          {selectedRenderFailed ? (
            <div className="flex h-full w-full items-center justify-center bg-black p-5 text-center">
              <div>
                <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-danger/15 text-danger ring-1 ring-danger/20">
                  <X className="h-7 w-7" />
                </span>
                <p className="mt-5 text-sm font-semibold text-white">
                  Render failed
                </p>
                <p className="mt-2 line-clamp-4 text-xs leading-5 text-zinc-400">
                  {selectedRenderClip?.failureReason ||
                    'This clip could not be rendered. Try rendering it again.'}
                </p>
              </div>
            </div>
          ) : previewClip ? (
            <video
              key={`rendered-${previewClip.id}`}
              controls
              preload="metadata"
              className="h-full w-full bg-black object-contain"
              src={`/api/rendered-clips/${previewClip.id}/download`}
            />
          ) : sourcePreviewUrl ? (
            <SourceCandidatePreview
              key={`source-${candidate.id}`}
              src={sourcePreviewUrl}
              startTimeMs={candidate.startTimeMs}
              endTimeMs={candidate.endTimeMs}
            />
          ) : youtubePreviewUrl ? (
            <iframe
              key={`youtube-${candidate.id}`}
              className="h-full w-full bg-black"
              src={youtubePreviewUrl}
              title={`${candidate.title} candidate preview`}
              allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(160deg,#1a1f35,#101015_48%,#233b2f)] p-5 text-center">
              <div>
                <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-white text-blue-700">
                  <Play className="h-7 w-7 fill-current" />
                </span>
                <p className="mt-5 line-clamp-5 text-sm font-semibold leading-6 text-white">
                  {hasCandidateHook(candidate.hook)
                    ? candidate.hook
                    : candidate.title}
                </p>
              </div>
            </div>
          )}
          {isSelectedRenderProcessing ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/72 p-5 text-center backdrop-blur-sm">
              <div>
                <Loader2 className="mx-auto h-10 w-10 animate-spin text-blue-200" />
                <p className="mt-5 text-sm font-semibold text-white">
                  Rendering HD preview
                </p>
                <p className="mt-2 max-w-40 text-xs leading-5 text-zinc-300">
                  This can take a moment. The preview will update when it is ready.
                </p>
              </div>
            </div>
          ) : null}
          <div className="absolute left-3 top-3 z-20 rounded bg-black/55 px-2 py-1 text-[11px] font-semibold uppercase text-white/80">
            {previewLabel}
          </div>
          <div className="absolute right-3 top-3 z-20 rounded-full bg-black/65 px-2 py-1 text-xs font-semibold text-white">
            {formatClipTimestamp(candidate.durationMs)}
          </div>
        </div>

        <div
          className={cn(
            'min-w-0 self-stretch overflow-hidden',
            compact
              ? 'min-h-[22.25rem] bg-black'
              : 'min-h-[24rem] bg-black/30 backdrop-blur-md'
          )}
        >
          <div className="flex h-full min-h-0 flex-col">
            <div
              className={cn(
                'flex items-center justify-between border-b border-white/10',
                compact ? 'px-3 py-2' : 'px-4 py-3'
              )}
            >
              <p className={cn('text-zinc-300', compact ? 'text-xs' : 'text-sm')}>
                Scene analysis
              </p>
              <div
                className={cn(
                  'flex items-center rounded-md border border-white/10 p-1 text-xs',
                  compact ? 'bg-[#0d0d0f]' : 'bg-white/[0.03]'
                )}
              >
                <button
                  type="button"
                  onClick={() => setTranscriptView('clip')}
                  className={cn(
                    'cursor-pointer rounded transition',
                    compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1',
                    transcriptView === 'clip'
                      ? 'bg-white text-black'
                      : 'text-zinc-400 hover:text-white'
                  )}
                >
                  Clip transcript
                </button>
                <button
                  type="button"
                  onClick={() => setTranscriptView('full')}
                  disabled={!trimmedFullTranscript}
                  className={cn(
                    'cursor-pointer rounded transition disabled:cursor-not-allowed disabled:opacity-40',
                    compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1',
                    transcriptView === 'full'
                      ? 'bg-white text-black'
                      : 'text-zinc-400 hover:text-white'
                  )}
                >
                  Full transcript
                </button>
              </div>
            </div>
            <div className="group/scene relative min-h-0 flex-1">
              <div
                ref={sceneAnalysisScrollRef}
                className={cn(
                  'min-h-0 h-full overflow-x-hidden overflow-y-auto leading-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                  compact ? 'space-y-3 p-3 pr-4 text-xs' : 'space-y-4 p-4 pr-5 text-sm'
                )}
              >
                <div>
                  {!showFullTranscript ? (
                    compact ? (
                      <div className="space-y-3">
                        {sceneAnalysisSegments.map((segment, index) => (
                          <div key={`${candidate.id}-segment-${index}`}>
                            <p className="font-mono text-zinc-400">
                              [{formatClipTimestamp(segment.startTimeMs)}-
                              {formatClipTimestamp(segment.endTimeMs)}]
                            </p>
                            <p className="mt-1 font-semibold leading-5 text-white">
                              {segment.text}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        <p className="font-mono text-zinc-400">
                          [{formatClipTimestamp(candidate.startTimeMs)}-
                          {formatClipTimestamp(candidate.endTimeMs)}]
                        </p>
                        <p className="mt-1 font-semibold text-white">
                          {candidate.transcriptExcerpt}
                        </p>
                      </>
                    )
                  ) : (
                    <div>
                      <p className={cn('whitespace-pre-wrap font-semibold text-white', compact && 'leading-5')}>
                        {trimmedFullTranscript}
                      </p>
                    </div>
                  )}
                </div>
                {!compact ? (
                  <div className="border-t border-white/10 pt-4">
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                      Why it was selected
                    </p>
                    <p className="mt-2 text-zinc-300">{candidate.whyItWorks}</p>
                    <p className="mt-2 text-zinc-400">{candidate.platformFit}</p>
                  </div>
                ) : null}
              </div>
              {sceneAnalysisScrollState.hasOverflow ? (
                <div className="pointer-events-none absolute inset-y-3 right-1.5 w-1.5 rounded-full bg-white/5 opacity-0 transition-opacity group-hover/scene:opacity-100">
                  <div
                    className="absolute left-0 right-0 rounded-full bg-white/25"
                    style={{
                      height: `${sceneAnalysisScrollState.thumbHeight}px`,
                      transform: `translateY(${sceneAnalysisScrollState.thumbTop}px)`
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ClipTitleBar({
  candidate,
  compact = false,
}: {
  candidate: EditorClipCandidate;
  compact?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(candidate.title);
  const [titleState, titleAction, isTitlePending] = useActionState<
    ActionState,
    FormData
  >(updateClipCandidateTitle, {});

  useEffect(() => {
    setTitleValue(candidate.title);
    setIsEditingTitle(false);
  }, [candidate.id, candidate.title]);

  useEffect(() => {
    if (titleState.success) {
      toast({
        title: 'Title updated',
        description: titleState.success,
        icon: successToastIcon
      });
      setIsEditingTitle(false);
      router.refresh();
      return;
    }

    if (titleState.error) {
      toast({
        title: 'Unable to update title',
        description: titleState.error,
        variant: 'destructive'
      });
    }
  }, [router, titleState.error, titleState.success, toast]);

  return (
    <div
      className={cn(
        'mb-7 flex min-w-0 items-start gap-3',
        compact
          ? 'lg:pl-[8.25rem] xl:pl-[9.25rem]'
          : 'lg:pl-[11.25rem] xl:pl-[12.25rem]'
      )}
    >
      {isEditingTitle ? (
        <form action={titleAction} className="flex min-w-0 flex-1 items-start gap-2">
          <input type="hidden" name="contentPackId" value={candidate.contentPackId} />
          <input type="hidden" name="clipCandidateId" value={candidate.id} />
          <Input
            name="title"
            value={titleValue}
            onChange={(event) => setTitleValue(event.target.value)}
            maxLength={150}
            className="h-11 border-white/10 bg-white/[0.04] text-base font-semibold text-white"
            aria-label="Clip title"
            autoFocus
          />
          <Button
            type="submit"
            size="icon"
            disabled={!titleValue.trim() || isTitlePending}
            className="shrink-0 bg-white text-black hover:bg-white/90"
          >
            {isTitlePending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            <span className="sr-only">Save title</span>
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            disabled={isTitlePending}
            className="shrink-0 border-white/10 bg-white/[0.04] text-white hover:bg-white/10 hover:text-white"
            onClick={() => {
              setTitleValue(candidate.title);
              setIsEditingTitle(false);
            }}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Cancel title edit</span>
          </Button>
        </form>
      ) : (
        <>
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={cn(
                'shrink-0 tabular-nums text-zinc-500',
                compact ? 'pt-0.5 text-2xl font-bold' : 'pt-0.5 text-xl font-semibold'
              )}
            >
              {candidate.rank}.
            </span>
            <h1
              className={cn(
                'min-w-0 max-w-xl line-clamp-2 leading-tight text-white',
                compact ? 'text-2xl font-bold' : 'text-xl font-semibold'
              )}
            >
              {candidate.title}
            </h1>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="mt-1 cursor-pointer rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white"
                onClick={() => setIsEditingTitle(true)}
              >
                <Pencil className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Edit title</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}

type ReusableAssetFilter =
  | 'all'
  | ReusableAssetKind.VIDEO
  | ReusableAssetKind.IMAGE
  | ReusableAssetKind.AUDIO
  | ReusableAssetKind.FONT;

function getReusableAssetIcon(kind: string) {
  if (kind === ReusableAssetKind.VIDEO) {
    return FileVideo;
  }

  if (kind === ReusableAssetKind.IMAGE) {
    return FileImage;
  }

  if (kind === ReusableAssetKind.AUDIO) {
    return FileAudio;
  }

  return FileText;
}

function ReusableAssetPreview({ asset }: { asset: EditorReusableAsset }) {
  const fileUrl = `/api/reusable-assets/${asset.id}/file`;

  if (asset.kind === ReusableAssetKind.IMAGE) {
    return (
      <img
        src={fileUrl}
        alt={asset.title}
        className="h-12 w-12 rounded-md border border-white/10 object-cover"
      />
    );
  }

  if (asset.kind === ReusableAssetKind.VIDEO) {
    return (
      <video
        src={fileUrl}
        muted
        playsInline
        preload="metadata"
        className="h-12 w-12 rounded-md border border-white/10 object-cover"
      />
    );
  }

  if (asset.kind === ReusableAssetKind.FONT) {
    const fontFamily = `editor-reusable-font-${asset.id}`;

    return (
      <div className="flex h-12 w-12 items-center justify-center rounded-md border border-white/10 bg-white/5 text-lg text-white">
        <style>{`@font-face { font-family: "${fontFamily}"; src: url("${fileUrl}"); }`}</style>
        <span style={{ fontFamily }}>Aa</span>
      </div>
    );
  }

  const AssetIcon = getReusableAssetIcon(asset.kind);

  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-md border border-white/10 bg-white/5 text-zinc-300">
      <AssetIcon className="h-5 w-5" />
    </div>
  );
}

function ReusableAssetPickerDialog({
  open,
  onOpenChange,
  assets,
  isLoading,
  error,
  selectedCaptionFontAssetId,
  usingAssetId,
  onUseAsset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assets: EditorReusableAsset[];
  isLoading: boolean;
  error: Error | undefined;
  selectedCaptionFontAssetId: number | null;
  usingAssetId: number | null;
  onUseAsset: (asset: EditorReusableAsset) => void;
}) {
  const [filter, setFilter] = useState<ReusableAssetFilter>('all');
  const filters: { value: ReusableAssetFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: ReusableAssetKind.VIDEO, label: 'Videos' },
    { value: ReusableAssetKind.IMAGE, label: 'Images' },
    { value: ReusableAssetKind.AUDIO, label: 'Audio' },
    { value: ReusableAssetKind.FONT, label: 'Fonts' },
  ];
  const filteredAssets =
    filter === 'all' ? assets : assets.filter((asset) => asset.kind === filter);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border-white/10 bg-zinc-950 text-white">
        <DialogHeader>
          <DialogTitle>Asset library</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Select a reusable upload for this editor session.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={cn(
                'cursor-pointer rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                filter === item.value
                  ? 'bg-white text-black'
                  : 'bg-white/10 text-zinc-300 hover:bg-white/15 hover:text-white'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="max-h-[26rem] overflow-y-auto rounded-lg border border-white/10">
          {isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-zinc-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading assets
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-danger">
              Unable to load reusable assets.
            </div>
          ) : filteredAssets.length === 0 ? (
            <div className="p-4 text-sm text-zinc-400">
              No reusable assets match this filter.
            </div>
          ) : (
            <div className="divide-y divide-white/10">
              {filteredAssets.map((asset) => {
                const isFont = asset.kind === ReusableAssetKind.FONT;
                const isReusableSource =
                  asset.kind === ReusableAssetKind.VIDEO ||
                  asset.kind === ReusableAssetKind.AUDIO;
                const actionLabel = isFont
                  ? selectedCaptionFontAssetId === asset.id
                    ? 'Font selected'
                    : 'Use font'
                  : isReusableSource
                    ? 'Use as source'
                    : 'Select';

                return (
                  <div key={asset.id} className="flex items-center gap-3 p-3">
                    <ReusableAssetPreview asset={asset} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">
                        {asset.title}
                      </p>
                      {asset.kind === ReusableAssetKind.FONT ? null : (
                        <p className="mt-0.5 truncate text-xs text-zinc-400">
                          {asset.originalFilename} • {formatBytes(asset.fileSizeBytes)}
                        </p>
                      )}
                      {asset.kind === ReusableAssetKind.AUDIO ? (
                        <audio
                          src={`/api/reusable-assets/${asset.id}/file`}
                          controls
                          preload="metadata"
                          className="mt-2 w-full max-w-sm"
                        />
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      className="bg-white text-black hover:bg-white/90"
                      disabled={
                        usingAssetId === asset.id ||
                        selectedCaptionFontAssetId === asset.id
                      }
                      onClick={() => onUseAsset(asset)}
                    >
                      {usingAssetId === asset.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : null}
                      {actionLabel}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ClipActionPanel({
  projectId,
  candidate,
  previewClip,
  selectedAspectRatio,
  selectedLayout,
  captionsEnabled,
  captionFontAssetId,
  onAspectRatioChange,
  onLayoutChange,
  onCaptionsEnabledChange,
  onCaptionFontAssetChange,
  compact = false,
  hasPremiumFeatures = true,
}: {
  projectId: number;
  candidate: EditorClipCandidate | null;
  previewClip: EditorRenderedClip | null;
  selectedAspectRatio: AspectRatioPreset;
  selectedLayout: LayoutPreset;
  captionsEnabled: boolean;
  captionFontAssetId: number | null;
  onAspectRatioChange: (aspectRatio: AspectRatioPreset) => void;
  onLayoutChange: (layout: LayoutPreset) => void;
  onCaptionsEnabledChange: (enabled: boolean) => void;
  onCaptionFontAssetChange: (assetId: number | null) => void;
  compact?: boolean;
  hasPremiumFeatures?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [saveClipState, saveClipAction, isSaveClipPending] = useActionState<
    ActionState,
    FormData
  >(saveApprovedClip, {});
  const [publishState, publishAction, isPublishPending] = useActionState<
    ActionState,
    FormData
  >(publishRenderedClip, {});
  const [isFacecamDialogOpen, setIsFacecamDialogOpen] = useState(false);
  const [isAssetPickerOpen, setIsAssetPickerOpen] = useState(false);
  const [usingReusableAssetId, setUsingReusableAssetId] = useState<number | null>(
    null
  );
  const [selectedReusableAsset, setSelectedReusableAsset] =
    useState<EditorReusableAsset | null>(null);
  const { data: linkedAccountsData } = useSWR<LinkedAccountsResponse>(
    '/api/linked-accounts',
    linkedAccountsFetcher
  );
  const {
    data: reusableAssetsData,
    error: reusableAssetsError,
    isLoading: reusableAssetsLoading,
    mutate: mutateReusableAssets,
  } = useSWR<ReusableAssetsResponse>('/api/reusable-assets', reusableAssetsFetcher);

  useEffect(() => {
    const state = saveClipState.success
      ? saveClipState
      : publishState.success
        ? publishState
        : null;

    if (!state?.success) {
      return;
    }

    toast({
      title: 'Workflow queued',
      description: state.success,
      icon: successToastIcon
    });
    window.dispatchEvent(new Event(TRANSCRIPT_TRACKING_REFRESH_EVENT));
    router.refresh();
  }, [
    router,
    saveClipState,
    publishState,
    toast,
  ]);

  useEffect(() => {
    if (
      !isFacecamDialogOpen ||
      !candidate ||
      ![
        FacecamDetectionStatus.PENDING,
        FacecamDetectionStatus.DETECTING,
      ].includes(candidate.facecamDetectionStatus as FacecamDetectionStatus)
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      router.refresh();
    }, 2500);

    return () => window.clearInterval(interval);
  }, [candidate, isFacecamDialogOpen, router]);

  if (!candidate) {
    return (
      <aside className="border-l border-border/70 bg-card p-4 text-sm text-muted-foreground">
        Select a candidate to preview, favorite, edit, and export.
      </aside>
    );
  }

  const trimmedClip = getRenderedClip(
    candidate,
    RenderedClipVariant.TRIMMED_ORIGINAL
  );
  const sourceMediaUnavailable = isMediaUnavailable({
    retentionStatus: candidate.sourceAssetRetentionStatus,
    storageDeletedAt: candidate.sourceAssetStorageDeletedAt
  });
  const isFacecamInProgress = [
    FacecamDetectionStatus.PENDING,
    FacecamDetectionStatus.DETECTING,
  ].includes(candidate.facecamDetectionStatus as FacecamDetectionStatus);
  const candidateHasFacecam = hasFacecam(candidate);
  const reusableAssets = reusableAssetsData?.assets || [];
  const selectedCaptionFont =
    reusableAssets.find((asset) => asset.id === captionFontAssetId) || null;
  const actionError =
    saveClipState.error ||
    publishState.error ||
    null;
  const hasSavableRenderedClip =
    candidate.renderedClips.some(
      (clip) =>
        clip.status === 'ready' &&
        clip.retentionStatus !== 'saved' &&
        !isMediaUnavailable(clip)
    );
  const copyCandidateText = async (label: string, text: string) => {
    const value = text.trim();

    if (!value) {
      toast({
        title: `No ${label.toLowerCase()} available`,
        description: 'This clip candidate does not include text for that action.',
        variant: 'destructive'
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      toast({
        title: `${label} copied`,
        description: 'The text is ready to paste.',
        icon: successToastIcon
      });
    } catch {
      toast({
        title: `Unable to copy ${label.toLowerCase()}`,
        description: 'Your browser blocked clipboard access.',
        variant: 'destructive'
      });
    }
  };

  const selectAspectRatio = (aspectRatio: AspectRatioPreset) => {
    onAspectRatioChange(aspectRatio);
    toast({
      title: `${formatAspectRatioPreset(aspectRatio)} selected`,
      description:
        'This editor is read-only while background processing owns renders.',
      icon: successToastIcon
    });
  };

  const selectLayout = (layout: LayoutPreset) => {
    if (isFacecamLayout(layout) && !candidateHasFacecam) {
      return;
    }

    onLayoutChange(layout);
    toast({
      title: `${formatLayoutPreset(layout)} layout selected`,
      description: candidateHasFacecam
        ? 'This editor is read-only while background processing owns renders.'
        : isFacecamLayout(layout)
          ? 'Facecam layouts appear after background detection completes.'
          : 'Layout selected.',
      icon: successToastIcon
    });
  };
  const publishableAccounts = (linkedAccountsData?.accounts || []).filter(
    (account) => account.publishable
  );
  const canPublishPreviewClip = previewClip
    ? previewClip.status === 'ready' &&
      publishableAccounts.length > 0 &&
      !isMediaUnavailable({
        retentionStatus: previewClip.retentionStatus,
        storageDeletedAt: previewClip.storageDeletedAt,
      })
    : false;
  const latestPublicationByPlatform = new Map(
    (previewClip?.publications || []).map((publication) => [
      publication.platform,
      publication,
    ])
  );
  const facecamProgress =
    candidate.facecamDetectionStatus === FacecamDetectionStatus.DETECTING
      ? 70
      : candidate.facecamDetectionStatus === FacecamDetectionStatus.READY ||
          candidate.facecamDetectionStatus === FacecamDetectionStatus.NOT_FOUND
        ? 100
        : candidate.facecamDetectionStatus === FacecamDetectionStatus.FAILED
          ? 100
          : candidate.facecamDetectionStatus === FacecamDetectionStatus.PENDING
            ? 35
            : candidate.facecamDetectionStatus === FacecamDetectionStatus.NOT_STARTED
              ? 0
              : 0;
  const facecamDialogTitle =
    candidate.facecamDetectionStatus === FacecamDetectionStatus.READY
      ? 'Facecam detected'
      : candidate.facecamDetectionStatus === FacecamDetectionStatus.NOT_FOUND
        ? 'No facecam detected'
        : candidate.facecamDetectionStatus === FacecamDetectionStatus.FAILED
          ? 'Facecam detection failed'
          : candidate.facecamDetectionStatus === FacecamDetectionStatus.DETECTING
            ? 'Detecting facecam'
            : candidate.facecamDetectionStatus === FacecamDetectionStatus.PENDING
              ? 'Facecam detection queued'
              : 'Facecam detection';
  const handleFacecamClick = () => {
    setIsFacecamDialogOpen(true);
  };

  const handleUseReusableAsset = async (asset: EditorReusableAsset) => {
    if (asset.kind === ReusableAssetKind.FONT) {
      onCaptionFontAssetChange(asset.id);
      setSelectedReusableAsset(asset);
      setIsAssetPickerOpen(false);
      toast({
        title: 'Caption font selected',
        description: `${asset.title} will be used for caption renders from this editor session.`,
        icon: successToastIcon,
      });
      return;
    }

    if (
      asset.kind !== ReusableAssetKind.VIDEO &&
      asset.kind !== ReusableAssetKind.AUDIO
    ) {
      setSelectedReusableAsset(asset);
      setIsAssetPickerOpen(false);
      toast({
        title: 'Asset selected',
        description: 'This asset is available in the picker for this editor session.',
        icon: successToastIcon,
      });
      return;
    }

    setUsingReusableAssetId(asset.id);

    try {
      const response = await fetch(
        `/api/reusable-assets/${asset.id}/use-in-project`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ projectId }),
        }
      );
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(result?.error || 'Unable to use reusable asset.');
      }

      setSelectedReusableAsset(asset);
      setIsAssetPickerOpen(false);
      toast({
        title: 'Asset added to project',
        description: `${asset.title} is now available as a project source.`,
        icon: successToastIcon,
      });
      window.dispatchEvent(new Event(TRANSCRIPT_TRACKING_REFRESH_EVENT));
      router.refresh();
    } catch (error) {
      toast({
        title: 'Unable to use asset',
        description:
          error instanceof Error ? error.message : 'Reusable asset could not be used.',
        variant: 'destructive',
      });
    } finally {
      setUsingReusableAssetId(null);
    }
  };

  const openAssetPicker = () => {
    mutateReusableAssets();
    setIsAssetPickerOpen(true);
  };
  const compactButtonClassName = compact
    ? 'min-h-8 max-w-full justify-start justify-self-start gap-1.5 rounded-lg px-2 text-xs font-medium bg-[#27272d] text-white hover:bg-[#32323a]'
    : 'w-full justify-start bg-white/10 text-white hover:bg-white/15';
  const compactTallButtonClassName = compact
    ? 'min-h-9 max-w-full justify-start justify-self-start gap-1.5 rounded-lg px-2.5 text-xs font-medium bg-[#27272d] text-white hover:bg-[#32323a]'
    : compactButtonClassName;
  const compactPrimaryButtonClassName = compact
    ? 'min-h-9 max-w-full justify-start justify-self-start gap-1.5 rounded-lg px-2.5 text-xs font-medium bg-white text-black hover:bg-zinc-200'
    : 'w-full justify-start bg-white text-black hover:bg-zinc-200';

  return (
    <aside className={cn('w-full shrink-0', compact ? 'lg:w-28' : 'lg:w-40')}>
      <div className={cn(compact ? 'space-y-5' : 'space-y-5')}>
        <div>
          <div className={cn('flex flex-col', compact ? 'gap-5' : 'gap-4')}>
            <div className="grid gap-1.5">
              {previewClip ? (
                <RailTooltip content={compact ? 'Download clip' : 'Download HD'}>
                  <Button
                    asChild
                    size="sm"
                    className={compactPrimaryButtonClassName}
                    >
                      <a
                        href={`/api/rendered-clips/${previewClip.id}/download?download=1`}
                        download
                      >
                        <Download className="h-4 w-4" />
                      {compact ? 'Download' : 'Download HD'}
                    </a>
                  </Button>
                </RailTooltip>
              ) : (
                <RailTooltip content={compact ? 'Download clip' : 'Download HD'}>
                  <Button
                    type="button"
                    size="sm"
                    className={compactTallButtonClassName}
                    disabled
                  >
                    <Download className="h-4 w-4" />
                    {compact ? 'Download' : 'Download HD'}
                  </Button>
                </RailTooltip>
              )}
              <DropdownMenu>
                <RailTooltip content="Publish clip">
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      className={compactTallButtonClassName}
                      disabled={!canPublishPreviewClip || isPublishPending}
                    >
                      {isPublishPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Share2 className="h-4 w-4" />
                      )}
                      {compact ? 'Publish' : 'Publish'}
                    </Button>
                  </DropdownMenuTrigger>
                </RailTooltip>
                <DropdownMenuContent align="start" className="min-w-52">
                  {publishableAccounts.map((account) => {
                    const publication = latestPublicationByPlatform.get(account.platform);

                    return (
                      <form key={account.id} action={publishAction}>
                        <input type="hidden" name="projectId" value={projectId} />
                        <input
                          type="hidden"
                          name="renderedClipId"
                          value={previewClip?.id || ''}
                        />
                        <input
                          type="hidden"
                          name="platform"
                          value={account.platform}
                        />
                        <DropdownMenuItem asChild>
                          <button
                            type="submit"
                            className="flex w-full items-center justify-between gap-3"
                          >
                            <span>
                              Publish to {formatPublishPlatformLabel(account.platform)}
                            </span>
                            {publication?.status === 'published' ? (
                              <span className="text-xs text-success">
                                Published
                              </span>
                            ) : publication?.status === 'publishing' ||
                              publication?.status === 'pending' ? (
                              <span className="text-xs text-warning">
                                Queued
                              </span>
                            ) : null}
                          </button>
                        </DropdownMenuItem>
                      </form>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="grid gap-1.5">
              {compact ? (
                <>
                  {hasPremiumFeatures ? (
                    <DropdownMenu>
                      <RailTooltip content="Aspect ratio">
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            size="sm"
                            className={compactTallButtonClassName}
                          >
                            <Crop className="h-4 w-4" />
                            {formatAspectRatioPreset(selectedAspectRatio)}
                          </Button>
                        </DropdownMenuTrigger>
                      </RailTooltip>
                      <DropdownMenuContent align="start" className="min-w-32">
                        <DropdownMenuRadioGroup
                          value={selectedAspectRatio}
                          onValueChange={(value) =>
                            selectAspectRatio(value as AspectRatioPreset)
                          }
                        >
                          {ASPECT_RATIO_PRESETS.map((aspectRatio) => (
                            <DropdownMenuRadioItem
                              key={aspectRatio.value}
                              value={aspectRatio.value}
                            >
                              {aspectRatio.label}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <RailTooltip content="Aspect ratio">
                      <Button
                        type="button"
                        size="sm"
                        className={cn(compactTallButtonClassName, 'relative')}
                        onClick={() => router.push('/dashboard')}
                      >
                        <PaidBadge />
                        <Crop className="h-4 w-4" />
                        {formatAspectRatioPreset(selectedAspectRatio)}
                      </Button>
                    </RailTooltip>
                  )}
                  <RailTooltip content="Duplicate clip">
                    <Button
                      type="button"
                      size="sm"
                      className={compactTallButtonClassName}
                      onClick={() => router.push('/dashboard')}
                    >
                      <Copy className="h-4 w-4" />
                      Duplicate
                    </Button>
                  </RailTooltip>
                  {hasCandidateHook(candidate.hook) ? (
                    <RailTooltip content="Copy hook">
                      <Button
                        type="button"
                        size="sm"
                        className={compactButtonClassName}
                        onClick={() => copyCandidateText('Hook', candidate.hook)}
                      >
                        <Copy className="h-4 w-4" />
                        Hook
                      </Button>
                    </RailTooltip>
                  ) : null}
                  <RailTooltip content="Copy transcript">
                    <Button
                      type="button"
                      size="sm"
                      className={compactButtonClassName}
                      onClick={() =>
                        copyCandidateText(
                          'Transcript excerpt',
                          candidate.transcriptExcerpt
                        )
                      }
                    >
                      <Copy className="h-4 w-4" />
                      Script
                    </Button>
                  </RailTooltip>
                </>
              ) : (
                <>
                  <div className="grid gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      className={compactButtonClassName}
                      disabled
                    >
                      <Scissors className="h-4 w-4" />
                      {compact ? 'Render' : 'Rendered by worker'}
                    </Button>
                    <form action={saveClipAction}>
                      <input
                        type="hidden"
                        name="clipCandidateId"
                        value={candidate.id}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className={compactButtonClassName}
                        disabled={!hasSavableRenderedClip || isSaveClipPending}
                      >
                        {isSaveClipPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        {compact ? 'Save' : 'Save clip'}
                      </Button>
                    </form>
                  </div>
                  <DropdownMenu>
                    <RailTooltip content="Aspect ratio">
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          size="sm"
                          className={compactTallButtonClassName}
                        >
                          <Crop className="h-4 w-4" />
                          {formatAspectRatioPreset(selectedAspectRatio)}
                        </Button>
                      </DropdownMenuTrigger>
                    </RailTooltip>
                    <DropdownMenuContent align="start" className="min-w-32">
                      <DropdownMenuRadioGroup
                        value={selectedAspectRatio}
                        onValueChange={(value) =>
                          selectAspectRatio(value as AspectRatioPreset)
                        }
                      >
                        {ASPECT_RATIO_PRESETS.map((aspectRatio) => (
                          <DropdownMenuRadioItem
                            key={aspectRatio.value}
                            value={aspectRatio.value}
                          >
                            {aspectRatio.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <RailTooltip content="Layout">
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          size="sm"
                          className={compactTallButtonClassName}
                        >
                          <SplitSquareVertical className="h-4 w-4" />
                          {compact ? 'Layout' : formatLayoutPreset(selectedLayout)}
                        </Button>
                      </DropdownMenuTrigger>
                    </RailTooltip>
                    <DropdownMenuContent align="start" className="min-w-32">
                      <DropdownMenuRadioGroup
                        value={selectedLayout}
                        onValueChange={(value) =>
                          selectLayout(value as LayoutPreset)
                        }
                      >
                        {LAYOUT_PRESETS.map((layout) => {
                          const disabled =
                            isFacecamLayout(layout.value) && !candidateHasFacecam;

                          return (
                            <DropdownMenuRadioItem
                              key={layout.value}
                              value={layout.value}
                              disabled={disabled}
                            >
                              {layout.label}
                            </DropdownMenuRadioItem>
                          );
                        })}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <RailTooltip content="Facecam">
                    <Button
                      type="button"
                      size="sm"
                      className={compactTallButtonClassName}
                      onClick={handleFacecamClick}
                    >
                      <ScanFace className="h-4 w-4" />
                      {compact ? 'Face' : 'Facecam'}
                    </Button>
                  </RailTooltip>
                  <RailTooltip content={captionsEnabled ? 'Disable captions' : 'Enable captions'}>
                    <Button
                      type="button"
                      size="sm"
                      className={cn(
                        compact
                          ? 'min-h-[2.125rem] max-w-full justify-start justify-self-start gap-1.5 rounded-lg px-2.25 text-xs font-medium hover:bg-white/15'
                          : 'justify-start hover:bg-white/15',
                        captionsEnabled
                          ? 'bg-white text-black hover:text-black'
                          : 'bg-white/10 text-white'
                      )}
                      onClick={() => onCaptionsEnabledChange(!captionsEnabled)}
                    >
                      <Captions className="h-4 w-4" />
                      {captionsEnabled ? 'Captions' : compact ? 'No cap' : 'No captions'}
                    </Button>
                  </RailTooltip>
                  <RailTooltip content="Asset library">
                  <Button
                    type="button"
                    size="sm"
                    className={compactTallButtonClassName}
                    onClick={openAssetPicker}
                    >
                      <HardDrive className="h-4 w-4" />
                      Assets
                    </Button>
                  </RailTooltip>
                  {selectedCaptionFont ? (
                    <p className={cn('truncate text-zinc-400', compact ? 'text-[10px]' : 'text-xs')}>
                      Font: {selectedCaptionFont.title}
                    </p>
                  ) : null}
                  {selectedReusableAsset &&
                  selectedReusableAsset.kind !== ReusableAssetKind.FONT ? (
                    <p className={cn('truncate text-zinc-400', compact ? 'text-[10px]' : 'text-xs')}>
                      Selected: {selectedReusableAsset.title}
                    </p>
                  ) : null}
                  <div className="grid gap-1.5">
                    <RailTooltip content="Copy caption">
                      <Button
                        type="button"
                        size="sm"
                        className={compactButtonClassName}
                        onClick={() =>
                          copyCandidateText('Caption', candidate.captionCopy)
                        }
                      >
                        <Captions className="h-4 w-4" />
                        {compact ? 'Caption' : 'Copy caption'}
                      </Button>
                    </RailTooltip>
                    {hasCandidateHook(candidate.hook) ? (
                      <RailTooltip content="Copy hook">
                        <Button
                          type="button"
                          size="sm"
                          className={compactButtonClassName}
                          onClick={() => copyCandidateText('Hook', candidate.hook)}
                        >
                          <Copy className="h-4 w-4" />
                          {compact ? 'Hook' : 'Copy hook'}
                        </Button>
                      </RailTooltip>
                    ) : null}
                    <RailTooltip content="Copy transcript">
                      <Button
                        type="button"
                        size="sm"
                        className={compactButtonClassName}
                        onClick={() =>
                          copyCandidateText(
                            'Transcript excerpt',
                            candidate.transcriptExcerpt
                          )
                        }
                      >
                        <Copy className="h-4 w-4" />
                        {compact ? 'Script' : 'Copy transcript'}
                      </Button>
                    </RailTooltip>
                  </div>
                </>
              )}
            </div>
            {previewClip?.publications.length ? (
              <div
                className={cn(
                  'rounded-lg border border-white/10',
                  compact ? 'bg-transparent p-2' : 'bg-white/[0.03] p-3'
                )}
              >
                <p className={cn('font-semibold uppercase tracking-wide text-zinc-500', compact ? 'text-[10px]' : 'text-xs')}>
                  Publish status
                </p>
                <div className={cn(compact ? 'mt-1.5 space-y-1.5' : 'mt-2 space-y-2')}>
                  {previewClip.publications.map((publication) => (
                    <div
                      key={publication.id}
                      className={cn(
                        'rounded-md border border-white/10',
                        compact ? 'p-1.5' : 'p-2'
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className={cn('text-zinc-200', compact ? 'text-[11px]' : 'text-sm')}>
                          {formatPublishPlatformLabel(publication.platform)}
                        </span>
                        <Badge
                          variant={getWorkflowStatusBadgeVariant(publication.status)}
                        >
                          {publication.status.replaceAll('_', ' ')}
                        </Badge>
                      </div>
                      {publication.platformUrl ? (
                        <a
                          href={publication.platformUrl}
                          target="_blank"
                          rel="noreferrer"
                          className={cn(
                            'block text-blue-300 hover:text-blue-200',
                            compact ? 'mt-1 text-[10px]' : 'mt-2 text-xs'
                          )}
                        >
                          Open published clip
                        </a>
                      ) : publication.failureReason ? (
                        <p className={cn(compact ? 'mt-1 text-[10px] text-danger' : 'mt-2 text-xs text-danger')}>
                          {publication.failureReason}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          {actionError ? (
            <p className="mt-3 rounded-lg border border-danger/20 bg-danger/10 p-2 text-xs leading-5 text-danger">
              {actionError}
            </p>
          ) : null}
        </div>
      </div>
      <Dialog open={isFacecamDialogOpen} onOpenChange={setIsFacecamDialogOpen}>
        <DialogContent className="max-w-md border-white/10 bg-[#0b0b0d] text-white">
          <DialogHeader>
            <DialogTitle>{facecamDialogTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-zinc-300">Detection status</span>
                <Badge
                  variant={getWorkflowStatusBadgeVariant(candidate.facecamDetectionStatus)}
                >
                  {candidate.facecamDetectionStatus.replaceAll('_', ' ')}
                </Badge>
              </div>
              <ProgressBar
                value={facecamProgress}
                className="mt-4"
                indicatorClassName={cn(
                  candidate.facecamDetectionStatus === FacecamDetectionStatus.FAILED
                    ? 'bg-danger'
                    : candidate.facecamDetectionStatus === FacecamDetectionStatus.READY
                      ? 'bg-success'
                      : 'bg-primary'
                )}
              />
              <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
                <span>Queued</span>
                <span>Analyzing</span>
                <span>Done</span>
              </div>
            </div>
            {candidate.facecamDetectionStatus === FacecamDetectionStatus.FAILED &&
            candidate.facecamDetectionFailureReason ? (
              <div className="rounded-lg border border-danger/20 bg-danger/10 p-4 text-sm text-danger">
                {candidate.facecamDetectionFailureReason}
              </div>
            ) : null}
            {candidate.facecamDetectedAt ? (
              <p className="text-xs text-zinc-500">
                Last updated {new Date(candidate.facecamDetectedAt).toLocaleString()}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="border-white/10 bg-white/[0.04] text-white hover:bg-white/10 hover:text-white"
              onClick={() => setIsFacecamDialogOpen(false)}
            >
              Close
            </Button>
            {candidate.facecamDetectionStatus === FacecamDetectionStatus.FAILED ? (
              <Button
                type="button"
                className="bg-white text-black hover:bg-white/90"
                onClick={() => router.refresh()}
              >
                <ScanFace className="h-4 w-4" />
                Refresh
              </Button>
            ) : null}
            {isFacecamInProgress ? (
              <Button
                type="button"
                className="bg-white text-black hover:bg-white/90"
                onClick={() => router.refresh()}
              >
                Refresh status
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ReusableAssetPickerDialog
        open={isAssetPickerOpen}
        onOpenChange={setIsAssetPickerOpen}
        assets={reusableAssets}
        isLoading={reusableAssetsLoading}
        error={reusableAssetsError}
        selectedCaptionFontAssetId={captionFontAssetId}
        usingAssetId={usingReusableAssetId}
        onUseAsset={handleUseReusableAsset}
      />
    </aside>
  );
}

function MobileReviewTabs({
  activeTab,
  onTabChange
}: {
  activeTab: 'clips' | 'preview' | 'actions';
  onTabChange: (tab: 'clips' | 'preview' | 'actions') => void;
}) {
  return (
    <div className="grid grid-cols-3 border-b border-border/70 bg-shell p-2 lg:hidden">
      {(['clips', 'preview', 'actions'] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => onTabChange(tab)}
          className={cn(
            'cursor-pointer rounded-lg px-3 py-2 text-sm capitalize',
            activeTab === tab
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground'
          )}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

function ProjectClipEditorToolbar({
  candidates,
  projectId,
  projectName,
  transcriptContent,
  activeFilters,
  onFilterToggle,
  viewToggle,
}: {
  candidates: EditorClipCandidate[];
  projectId: number;
  projectName: string;
  transcriptContent: string | null;
  activeFilters: HeaderFilter[];
  onFilterToggle: (filter: HeaderFilter) => void;
  viewToggle?: ReactNode;
}) {
  return (
    <div className="border-b border-border/70 px-4 py-3">
      <div className="mx-auto flex max-w-[68rem] flex-wrap items-center gap-3">
        <span className="shrink-0 text-sm text-blue-200">
          Original clips ({candidates.length})
        </span>
        {viewToggle}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <HeaderFilterButton
            activeFilters={activeFilters}
            onFilterToggle={onFilterToggle}
          />
          <ProjectQuickActions
            projectId={projectId}
            projectName={projectName}
            transcriptContent={transcriptContent}
          />
        </div>
      </div>
    </div>
  );
}

function HeaderFilterButton({
  activeFilters,
  onFilterToggle
}: {
  activeFilters: HeaderFilter[];
  onFilterToggle: (filter: HeaderFilter) => void;
}) {
  const activeCount = activeFilters.length;
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 border-white/10 bg-white/[0.04] px-2.5 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
        >
          <Filter className="h-3.5 w-3.5" />
          Filter{activeCount > 0 ? ` (${activeCount})` : ''}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuItem
          className="gap-2"
          onSelect={(event) => {
            event.preventDefault();
            onFilterToggle('favorited');
          }}
        >
          <span
            className={cn(
              'flex size-4 items-center justify-center rounded-[4px] border border-white/20',
              activeFilters.includes('favorited')
                ? 'bg-white text-black'
                : 'bg-transparent text-white'
            )}
          >
            {activeFilters.includes('favorited') ? (
              <Check className="h-3 w-3" />
            ) : (
              <Square className="h-3 w-3 opacity-0" />
            )}
          </span>
          Favorited
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2"
          onSelect={(event) => {
            event.preventDefault();
            onFilterToggle('disliked');
          }}
        >
          <span
            className={cn(
              'flex size-4 items-center justify-center rounded-[4px] border border-white/20',
              activeFilters.includes('disliked')
                ? 'bg-white text-black'
                : 'bg-transparent text-white'
            )}
          >
            {activeFilters.includes('disliked') ? (
              <Check className="h-3 w-3" />
            ) : (
              <Square className="h-3 w-3 opacity-0" />
            )}
          </span>
          Disliked
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ClipViewToggle({
  value,
  onChange
}: {
  value: ClipView;
  onChange: (value: ClipView) => void;
}) {
  const iconByView = {
    list: List,
    grid: LayoutGrid
  } as const;

  return (
    <div
      className="inline-flex shrink-0 items-center rounded-md border border-white/10 bg-white/[0.04] p-0.5"
      aria-label="Clip view"
      role="group"
    >
      {(['list', 'grid'] as const).map((view) => (
        (() => {
          const Icon = iconByView[view];

          return (
            <button
              key={view}
              type="button"
              onClick={() => onChange(view)}
              className={cn(
                'cursor-pointer rounded p-1.5 transition',
                value === view
                  ? 'bg-white text-black'
                  : 'text-zinc-300 hover:text-white'
              )}
              aria-label={`${view} view`}
              aria-pressed={value === view}
              title={`${view} view`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })()
      ))}
    </div>
  );
}

function ProjectClipEditorWorkspace({
  projectId,
  candidate,
  activeSourceTranscript,
  selectedAspectRatio,
  selectedLayout,
  captionsEnabled,
  captionFontAssetId,
  onAspectRatioChange,
  onLayoutChange,
  onCaptionsEnabledChange,
  onCaptionFontAssetChange,
  activeTab,
  onActiveTabChange,
  showClipSwitcher = false,
  clipSwitcher,
  className,
  compact = false,
  hasPremiumFeatures = true,
}: {
  projectId: number;
  candidate: EditorClipCandidate;
  activeSourceTranscript: string | null;
  selectedAspectRatio: AspectRatioPreset;
  selectedLayout: LayoutPreset;
  captionsEnabled: boolean;
  captionFontAssetId: number | null;
  onAspectRatioChange: (aspectRatio: AspectRatioPreset) => void;
  onLayoutChange: (layout: LayoutPreset) => void;
  onCaptionsEnabledChange: (enabled: boolean) => void;
  onCaptionFontAssetChange: (assetId: number | null) => void;
  activeTab: 'clips' | 'preview' | 'actions';
  onActiveTabChange: (tab: 'clips' | 'preview' | 'actions') => void;
  showClipSwitcher?: boolean;
  clipSwitcher?: ReactNode;
  className?: string;
  compact?: boolean;
  hasPremiumFeatures?: boolean;
}) {
  const selectedEditConfigHash = candidate.editConfig?.configHash || null;
  const selectedRenderClip = getRenderedClip(
    candidate,
    getRenderedClipVariantForAspectRatio(selectedAspectRatio),
    selectedLayout,
    selectedEditConfigHash
  );
  const previewClip = getBestPreviewClipForCandidate(
    candidate,
    selectedAspectRatio,
    selectedLayout,
    selectedEditConfigHash
  );

  return (
    <div className={cn(compact && 'mx-auto w-full max-w-[58rem]', className)}>
      {showClipSwitcher && clipSwitcher ? clipSwitcher : null}
      <MobileReviewTabs activeTab={activeTab} onTabChange={onActiveTabChange} />
      <ClipTitleBar candidate={candidate} compact={compact} />
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div
          className={cn(
            activeTab !== 'clips' && 'hidden lg:block'
          )}
        >
          <ClipScorePanel
            projectId={projectId}
            candidate={candidate}
            selectedAspectRatio={selectedAspectRatio}
            selectedLayout={selectedLayout}
            captionsEnabled={captionsEnabled}
            captionFontAssetId={captionFontAssetId}
            compact={compact}
            hasPremiumFeatures={hasPremiumFeatures}
          />
        </div>
        <div className={cn(activeTab !== 'preview' && 'hidden lg:block', 'min-w-0 flex-1')}>
          <ClipPreviewPanel
            candidate={candidate}
            previewClip={previewClip}
            selectedRenderClip={selectedRenderClip}
            selectedAspectRatio={selectedAspectRatio}
            selectedLayout={selectedLayout}
            fullTranscript={activeSourceTranscript}
            compact={compact}
          />
        </div>
        <div
          className={cn(
            activeTab !== 'actions' && 'hidden lg:block'
          )}
        >
          <ClipActionPanel
            projectId={projectId}
            candidate={candidate}
            previewClip={previewClip}
            selectedAspectRatio={selectedAspectRatio}
            selectedLayout={selectedLayout}
            captionsEnabled={captionsEnabled}
            captionFontAssetId={captionFontAssetId}
            onAspectRatioChange={onAspectRatioChange}
            onLayoutChange={onLayoutChange}
            onCaptionsEnabledChange={onCaptionsEnabledChange}
            onCaptionFontAssetChange={onCaptionFontAssetChange}
            compact={compact}
            hasPremiumFeatures={hasPremiumFeatures}
          />
        </div>
      </div>
    </div>
  );
}

function SaveProjectControl({ projectId }: { projectId: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    saveProject,
    {}
  );

  useEffect(() => {
    if (state.success) {
      toast({
        title: 'Project saved',
        description: state.success,
        icon: successToastIcon
      });
      router.refresh();
      return;
    }

    if (state.error) {
      toast({
        title: 'Unable to save project',
        description: state.error,
        variant: 'destructive'
      });
    }
  }, [router, state.error, state.success, toast]);

  return (
    <form action={formAction}>
      <input type="hidden" name="projectId" value={projectId} />
      <Button type="submit" variant="outline" disabled={isPending}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Save project
      </Button>
    </form>
  );
}

function AutoSaveApprovedClipsControl({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    updateAutoSaveApprovedClipsSetting,
    {}
  );

  useEffect(() => {
    if (state.success) {
      toast({
        title: 'Auto-save updated',
        description: state.success,
        icon: successToastIcon
      });
      router.refresh();
      return;
    }

    if (state.error) {
      toast({
        title: 'Unable to update auto-save',
        description: state.error,
        variant: 'destructive'
      });
    }
  }, [router, state.error, state.success, toast]);

  return (
    <form action={formAction}>
      <input type="hidden" name="enabled" value={String(!enabled)} />
      <Button type="submit" variant="outline" disabled={isPending}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Auto-save {enabled ? 'on' : 'off'}
      </Button>
    </form>
  );
}

export function ProjectReviewPage({
  project,
  sourceAssets,
  clipCandidates,
  autoSaveApprovedClipsEnabled,
  subscriptionStatus,
}: ProjectClipEditorProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [selectedSourceAssetId, setSelectedSourceAssetId] = useState(
    sourceAssets[0]?.id ?? null
  );
  const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(
    clipCandidates[0]?.id ?? null
  );
  const [activeFilters, setActiveFilters] = useState<HeaderFilter[]>([]);
  const [selectedAspectRatio, setSelectedAspectRatio] =
    useState<AspectRatioPreset>('9_16');
  const [selectedLayout, setSelectedLayout] = useState<LayoutPreset>(
    RenderedClipLayout.PRESERVE_ASPECT
  );
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [captionFontAssetId, setCaptionFontAssetId] = useState<number | null>(
    null
  );
  const [activeTab, setActiveTab] = useState<'clips' | 'preview' | 'actions'>(
    'preview'
  );
  const [modalActiveTab, setModalActiveTab] = useState<
    'clips' | 'preview' | 'actions'
  >('preview');
  const [modalTransitionDirection, setModalTransitionDirection] = useState<
    -1 | 0 | 1
  >(0);
  const [isSelectionDialogOpen, setIsSelectionDialogOpen] = useState(false);
  const [isEditorModalOpen, setIsEditorModalOpen] = useState(false);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<number[]>([]);
  const [dismissedHookNoticeSourceIds, setDismissedHookNoticeSourceIds] =
    useState<number[]>([]);
  const hasPremiumFeatures = hasPremiumClipEditorFeatures(subscriptionStatus);

  const activeSource =
    sourceAssets.find((asset) => asset.id === selectedSourceAssetId) ||
    sourceAssets[0] ||
    null;

  const sortedCandidates = useMemo(
    () => [...clipCandidates].sort((left, right) => left.rank - right.rank),
    [clipCandidates]
  );
  const activeCandidates = useMemo(
    () =>
      activeSource
        ? sortedCandidates.filter(
            (candidate) => candidate.sourceAssetId === activeSource.id
          )
        : sortedCandidates,
    [activeSource, sortedCandidates]
  );
  const activeCandidateIds = useMemo(
    () => new Set(activeCandidates.map((candidate) => candidate.id)),
    [activeCandidates]
  );
  const visibleCandidates = useMemo(
    () => filterCandidatesByHeaderFilters(activeCandidates, activeFilters),
    [activeCandidates, activeFilters]
  );
  const selectedCandidate =
    activeCandidates.find((candidate) => candidate.id === selectedCandidateId) ||
    activeCandidates[0] ||
    null;
  const selectedEditConfig = selectedCandidate?.editConfig || null;
  const hasActiveWorkflow = hasActiveWorkflowState(sourceAssets);
  const isHookNoticeDismissed = activeSource
    ? dismissedHookNoticeSourceIds.includes(activeSource.id)
    : false;
  const selectedCount = selectedCandidateIds.length;
  const isBulkDownloadDisabled = selectedCount === 0;
  const defaultClipView: ClipView =
    activeCandidates.length > 3 ? 'grid' : 'list';
  const [clipView, setClipView] = useState<ClipView>(defaultClipView);
  const isGridView = clipView === 'grid';
  const displayedCandidates = isGridView ? activeCandidates : visibleCandidates;
  const selectedCandidateVisible = selectedCandidate
    ? displayedCandidates.some((candidate) => candidate.id === selectedCandidate.id)
    : false;
  const selectedModalCandidateIndex = selectedCandidate
    ? displayedCandidates.findIndex(
        (candidate) => candidate.id === selectedCandidate.id
      )
    : -1;
  const hasPreviousModalCandidate = selectedModalCandidateIndex > 0;
  const hasNextModalCandidate =
    selectedModalCandidateIndex >= 0 &&
    selectedModalCandidateIndex < displayedCandidates.length - 1;

  useEffect(() => {
    if (activeCandidates.length > 0 && !selectedCandidate) {
      setSelectedCandidateId(activeCandidates[0].id);
    }
  }, [activeCandidates, selectedCandidate]);

  useEffect(() => {
    if (displayedCandidates.length === 0) {
      return;
    }

    if (!selectedCandidateVisible) {
      setSelectedCandidateId(displayedCandidates[0].id);
    }
  }, [displayedCandidates, selectedCandidateVisible]);

  useEffect(() => {
    setSelectedCandidateIds((currentIds) =>
      currentIds.filter((candidateId) => activeCandidateIds.has(candidateId))
    );
  }, [activeCandidateIds]);

  useEffect(() => {
    if (isFacecamLayout(selectedLayout) && !hasFacecam(selectedCandidate)) {
      setSelectedLayout(RenderedClipLayout.PRESERVE_ASPECT);
    }
  }, [selectedCandidate, selectedLayout]);

  useEffect(() => {
    if (!selectedEditConfig) {
      return;
    }

    if (
      selectedEditConfig.aspectRatio === '9_16' ||
      selectedEditConfig.aspectRatio === '1_1' ||
      selectedEditConfig.aspectRatio === '16_9'
    ) {
      setSelectedAspectRatio(selectedEditConfig.aspectRatio);
    }

    if (
      selectedEditConfig.layout === RenderedClipLayout.PRESERVE_ASPECT ||
      selectedEditConfig.layout === RenderedClipLayout.DEFAULT ||
      selectedEditConfig.layout === RenderedClipLayout.FACECAM_TOP_50 ||
      selectedEditConfig.layout === RenderedClipLayout.FACECAM_TOP_40 ||
      selectedEditConfig.layout === RenderedClipLayout.FACECAM_TOP_30
    ) {
      setSelectedLayout(selectedEditConfig.layout);
    }

    setCaptionsEnabled(selectedEditConfig.captionsEnabled);
    setCaptionFontAssetId(selectedEditConfig.captionFontAssetId);
  }, [selectedEditConfig]);

  useEffect(() => {
    setClipView(defaultClipView);
  }, [activeSource?.id, defaultClipView]);

  useEffect(() => {
    if (!isGridView) {
      setIsEditorModalOpen(false);
    }
  }, [isGridView]);

  useEffect(() => {
    if (!hasActiveWorkflow) {
      return;
    }

    const interval = window.setInterval(() => {
      window.dispatchEvent(new Event(TRANSCRIPT_TRACKING_REFRESH_EVENT));
      router.refresh();
    }, 3000);

    return () => window.clearInterval(interval);
  }, [hasActiveWorkflow, router]);

  useEffect(() => {
    if (!isEditorModalOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handleSelectAdjacentModalCandidate(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleSelectAdjacentModalCandidate(1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditorModalOpen, selectedModalCandidateIndex, displayedCandidates]);

  function clearSelection() {
    setSelectedCandidateIds([]);
  }

  function toggleCandidateSelection(candidateId: number) {
    setSelectedCandidateIds((currentIds) =>
      currentIds.includes(candidateId)
        ? currentIds.filter((id) => id !== candidateId)
        : [...currentIds, candidateId]
    );
  }

  function handleHeaderFilterToggle(filter: HeaderFilter) {
    setActiveFilters((current) =>
      current.includes(filter)
        ? current.filter((value) => value !== filter)
        : [...current, filter]
    );
  }

  function handleCandidateSelect(candidateId: number) {
    setModalTransitionDirection(0);
    setSelectedCandidateId(candidateId);
    setActiveTab('preview');
  }

  function handleOpenCandidateEditor(candidateId: number) {
    setModalTransitionDirection(0);
    setSelectedCandidateId(candidateId);
    setModalActiveTab('preview');
    setIsEditorModalOpen(true);
  }

  function handleSelectAdjacentModalCandidate(direction: -1 | 1) {
    if (selectedModalCandidateIndex < 0) {
      return;
    }

    const nextCandidate = displayedCandidates[selectedModalCandidateIndex + direction];

    if (!nextCandidate) {
      return;
    }

    setModalTransitionDirection(direction);
    setSelectedCandidateId(nextCandidate.id);
  }

  function handleSourceAssetSelect(sourceAssetId: number) {
    setSelectedSourceAssetId(sourceAssetId);
    const firstCandidate = sortedCandidates.find(
      (candidate) => candidate.sourceAssetId === sourceAssetId
    );
    setSelectedCandidateId(firstCandidate?.id ?? null);
    setIsSelectionDialogOpen(false);
    setIsEditorModalOpen(false);
    clearSelection();
  }

  function handleToggleAllSelectedCandidates() {
    if (selectedCandidateIds.length === activeCandidates.length) {
      clearSelection();
      return;
    }

    setSelectedCandidateIds(activeCandidates.map((candidate) => candidate.id));
  }

  function handleDownloadSelected() {
    const downloadableClips = selectedCandidateIds
      .map((candidateId) => {
        const candidate =
          activeCandidates.find((candidate) => candidate.id === candidateId) ||
          null;

        return getDownloadableRenderedClip(
          candidate,
          selectedAspectRatio,
          selectedLayout,
          candidate?.editConfig?.configHash || null
        );
      })
      .filter((clip): clip is EditorRenderedClip => Boolean(clip));
    const skippedCount = selectedCandidateIds.length - downloadableClips.length;

    if (downloadableClips.length === 0) {
      toast({
        title: 'No downloads started',
        description:
          'Selected clips need a ready render in the current format before they can be downloaded.',
        variant: 'destructive'
      });
      return;
    }

    downloadableClips.forEach((clip) => {
      const anchor = document.createElement('a');
      anchor.href = `/api/rendered-clips/${clip.id}/download?download=1`;
      anchor.download = '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    });

    toast({
      title:
        downloadableClips.length === 1 ? 'Download started' : 'Downloads started',
      description:
        skippedCount > 0
          ? `${downloadableClips.length} clip${downloadableClips.length === 1 ? '' : 's'} downloading, ${skippedCount} skipped.`
          : `${downloadableClips.length} clip${downloadableClips.length === 1 ? '' : 's'} downloading.`,
      icon: successToastIcon
    });
  }

  if (sourceAssets.length === 0) {
    return <EmptyUploadWorkspace project={project} />;
  }

  const viewToggle = (
    <ClipViewToggle value={clipView} onChange={setClipView} />
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
        {sourceAssets.length > 1 ? (
          <div className="flex gap-2 overflow-x-auto border-b border-border/70 px-4 py-2">
            {sourceAssets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                onClick={() => handleSourceAssetSelect(asset.id)}
                className={cn(
                  'cursor-pointer flex min-w-48 items-center gap-2 rounded-md border px-3 py-2 text-left text-xs',
                  activeSource?.id === asset.id
                    ? 'border-primary/50 bg-primary/15 text-primary'
                    : 'border-border/70 bg-surface-1 text-muted-foreground'
                )}
              >
                <FileVideo className="h-4 w-4" />
                <span className="truncate">{asset.title}</span>
              </button>
            ))}
          </div>
        ) : null}

        {activeCandidates.length > 0 ? (
          <ProjectClipEditorToolbar
            candidates={activeCandidates}
            projectId={project.id}
            projectName={project.name}
            transcriptContent={activeSource?.transcriptContent || null}
            activeFilters={activeFilters}
            onFilterToggle={handleHeaderFilterToggle}
            viewToggle={viewToggle}
          />
        ) : null}

        {activeCandidates.length === 0 ? (
          <EmptyClipWorkflowState
            projectId={project.id}
            sourceAsset={activeSource}
          />
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
            <div
              className={cn(
                'mx-auto',
                isGridView ? 'max-w-none' : 'max-w-[68rem]'
              )}
            >
              {!isGridView && !isHookNoticeDismissed ? (
                <div className="mb-8 max-w-3xl rounded-lg border border-white/0 bg-transparent p-0">
                  <div className="flex items-start justify-between gap-4">
                    {activeCandidates.some((item) => hasCandidateHook(item.hook)) ? (
                      <div>
                        <h2 className="text-lg font-semibold text-white">
                          Auto hook
                        </h2>
                        <p className="mt-3 max-w-4xl font-mono text-sm font-semibold leading-6 text-white">
                          A text hook has been added to your ranked clips. If you
                          do not need it, copy or refine the candidate text from
                          the actions panel.
                        </p>
                      </div>
                    ) : (
                      <div>
                        <h2 className="text-lg font-semibold text-white">
                          Transcript-led clips
                        </h2>
                        <p className="mt-3 max-w-4xl font-mono text-sm font-semibold leading-6 text-white">
                          Auto hook is off for this run. Ranked clips are based on
                          the transcript moment itself without added hook copy.
                        </p>
                      </div>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="cursor-pointer rounded-md p-1 text-zinc-300 hover:bg-white/10"
                          onClick={() => {
                            if (!activeSource) {
                              return;
                            }

                            setDismissedHookNoticeSourceIds((sourceIds) => [
                              ...sourceIds,
                              activeSource.id
                            ]);
                          }}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Dismiss</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ) : null}

              {displayedCandidates.length === 0 ? null : !isGridView ? (
                <InlineClipWorkspaceList
                  projectId={project.id}
                  candidates={displayedCandidates}
                  activeSourceTranscript={activeSource?.transcriptContent || null}
                  hasPremiumFeatures={hasPremiumFeatures}
                />
              ) : (
                <RenderedClipGrid
                  projectId={project.id}
                  candidates={displayedCandidates}
                  aspectRatio={selectedAspectRatio}
                  layout={selectedLayout}
                  captionsEnabled={captionsEnabled}
                  captionFontAssetId={captionFontAssetId}
                  onOpenEditor={handleOpenCandidateEditor}
                />
              )}
            </div>
          </main>
        )}
      <SelectClipsDialog
        open={isSelectionDialogOpen}
        onOpenChange={setIsSelectionDialogOpen}
        candidates={activeCandidates}
        selectedCandidateIds={selectedCandidateIds}
        onToggleCandidate={toggleCandidateSelection}
        onToggleAll={handleToggleAllSelectedCandidates}
        onDownloadSelected={handleDownloadSelected}
        downloadSelectionDisabled={isBulkDownloadDisabled}
      />
      <Dialog open={isEditorModalOpen} onOpenChange={setIsEditorModalOpen}>
        <DialogPortal>
          <div className="pointer-events-none fixed inset-x-0 top-4 z-[60]">
            <div className="mx-auto w-[min(88vw,64rem)] max-w-[88vw]">
              <div className="flex justify-end">
                <DialogClose asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="pointer-events-auto border-white/25 bg-black text-white opacity-100 shadow-md"
                  >
                    <X className="h-4 w-4" />
                    <span className="sr-only">Close</span>
                  </Button>
                </DialogClose>
              </div>
            </div>
          </div>
        </DialogPortal>
        <DialogContent
          showCloseButton={false}
          className="w-[min(88vw,64rem)] max-w-[88vw] overflow-visible border-0 bg-transparent p-0 text-white shadow-none [&_button:not(:disabled)]:cursor-pointer sm:max-w-[88vw]"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>
              {selectedCandidate ? `Clip ${selectedCandidate.rank} editor` : 'Clip editor'}
            </DialogTitle>
            <DialogDescription>
              Review the rendered clip and move between clips with the previous and next controls.
            </DialogDescription>
          </DialogHeader>
          {selectedCandidate ? (
            <div className="relative">
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="absolute -left-12 top-1/2 z-30 hidden size-9 -translate-y-1/2 rounded-full border-white bg-white text-black hover:bg-zinc-200 hover:text-black disabled:opacity-30 lg:flex"
                onClick={() => handleSelectAdjacentModalCandidate(-1)}
                disabled={!hasPreviousModalCandidate}
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="sr-only">Previous clip</span>
              </Button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="absolute -right-12 top-1/2 z-30 hidden size-9 -translate-y-1/2 rounded-full border-white bg-white text-black hover:bg-zinc-200 hover:text-black disabled:opacity-30 lg:flex"
                onClick={() => handleSelectAdjacentModalCandidate(1)}
                disabled={!hasNextModalCandidate}
              >
                <ChevronRight className="h-4 w-4" />
                <span className="sr-only">Next clip</span>
              </Button>
              <div
                key={selectedCandidate.id}
                className={cn(
                  'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200',
                  modalTransitionDirection > 0 &&
                    'motion-safe:slide-in-from-right-4',
                  modalTransitionDirection < 0 &&
                    'motion-safe:slide-in-from-left-4'
                )}
              >
                <ProjectClipEditorWorkspace
                  projectId={project.id}
                  candidate={selectedCandidate}
                  activeSourceTranscript={activeSource?.transcriptContent || null}
                  selectedAspectRatio={selectedAspectRatio}
                  selectedLayout={selectedLayout}
                  captionsEnabled={captionsEnabled}
                  captionFontAssetId={captionFontAssetId}
                  onAspectRatioChange={setSelectedAspectRatio}
                  onLayoutChange={setSelectedLayout}
                  onCaptionsEnabledChange={setCaptionsEnabled}
                  onCaptionFontAssetChange={setCaptionFontAssetId}
                  activeTab={modalActiveTab}
                  onActiveTabChange={setModalActiveTab}
                  compact
                  hasPremiumFeatures={hasPremiumFeatures}
                  className="max-h-[92vh] overflow-y-auto bg-transparent px-4 py-6"
                />
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProjectQuickActions({
  projectId,
  projectName,
  transcriptContent
}: {
  projectId: number;
  projectName: string;
  transcriptContent: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function showError(message: string) {
    toast({
      title: 'Action failed',
      description: message,
      variant: 'destructive'
    });
  }

  function handleSaveProject() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set('projectId', String(projectId));

      const result = await saveProject({}, formData);

      if ('error' in result) {
        showError(result.error || 'Project could not be saved.');
        return;
      }

      toast({
        title: 'Saved to storage',
        description: result.success,
        icon: successToastIcon
      });
      router.refresh();
    });
  }

  function handleShareProject() {
    startTransition(async () => {
      const shareUrl = `${window.location.origin}/dashboard/projects/${projectId}`;

      try {
        await navigator.clipboard.writeText(shareUrl);
        toast({
          title: 'Project link copied',
          description: shareUrl,
          icon: successToastIcon
        });
      } catch {
        showError('Your browser blocked clipboard access.');
      }
    });
  }

  function handleDownloadTranscript() {
    if (!transcriptContent) {
      showError('This project does not have a transcript available yet.');
      return;
    }

    const fileBase =
      (projectName)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'transcript';
    const blob = new Blob([transcriptContent], { type: 'text/plain;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = `${fileBase}-transcript.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
  }

  function handleDeleteProject() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set('projectId', String(projectId));

      const result = await deleteProject({}, formData);

      if ('error' in result) {
        showError(result.error || 'Project could not be deleted.');
        return;
      }

      toast({
        title: 'Project deleted',
        description: result.success,
        icon: successToastIcon
      });
      setIsDeleteOpen(false);
      router.push('/dashboard');
    });
  }

  return (
    <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="cursor-pointer h-7 w-7 rounded-md text-zinc-400 hover:bg-white/10 hover:text-white"
            disabled={isPending}
            aria-label="Project actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={handleSaveProject} disabled={isPending} className="cursor-pointer">
            <HardDrive className="mr-2 h-4 w-4" />
            Save to storage
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleShareProject} disabled={isPending} className="cursor-pointer">
            <Share2 className="mr-2 h-4 w-4" />
            Share project
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={handleDownloadTranscript}
            disabled={!transcriptContent || isPending}
            className="cursor-pointer"
          >
            <Download className="mr-2 h-4 w-4" />
            Download transcript
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setIsDeleteOpen(true)}
            disabled={isPending}
            className="cursor-pointer"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the project, its source assets, transcripts, generated clips,
            and related outputs.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="cursor-pointer border-0" disabled={isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className="cursor-pointer"
            onClick={(event) => {
              event.preventDefault();
              handleDeleteProject();
            }}
            disabled={isPending}
          >
            {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ProjectClipEditor(props: ProjectClipEditorProps) {
  return <ProjectReviewPage {...props} />;
}
