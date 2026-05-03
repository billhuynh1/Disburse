'use client';

import Link from 'next/link';
import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Captions,
  Check,
  Clapperboard,
  Copy,
  Crop,
  Download,
  FileVideo,
  Loader2,
  Mic2,
  Pencil,
  Play,
  RotateCcw,
  ScanFace,
  Scissors,
  SplitSquareVertical,
  ThumbsDown,
  WandSparkles,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { successToastIcon } from '@/components/ui/toaster';
import { useToast } from '@/hooks/use-toast';
import {
  approveClipCandidateAndQueueRender,
  detectClipFacecam,
  renderApprovedClip,
  saveApprovedClip,
  saveProject,
  updateAutoSaveApprovedClipsSetting,
  updateClipCandidateReviewStatus
} from '@/lib/disburse/actions';
import {
  ClipCandidateReviewStatus,
  ContentPackStatus,
  FacecamDetectionStatus,
  RenderedClipLayout,
  RenderedClipVariant,
  SourceAssetStatus,
  SourceAssetType,
  TranscriptStatus
} from '@/lib/db/schema';
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

type EditorGeneratedAsset = {
  id: number;
  contentPackId: number;
  assetType: string;
  title: string | null;
  content: string;
  updatedAt: string;
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
  generatedAssetCount: number;
  generatedAssets: EditorGeneratedAsset[];
  autoSaveApprovedClipsEnabled: boolean;
};

type ReviewFilter = 'all' | 'pending' | 'approved' | 'rejected';
type AspectRatioPreset = '9_16' | '1_1' | '16_9';
type LayoutPreset =
  | RenderedClipLayout.DEFAULT
  | RenderedClipLayout.FACECAM_TOP_50
  | RenderedClipLayout.FACECAM_TOP_40
  | RenderedClipLayout.FACECAM_TOP_30;

const ASPECT_RATIO_PRESETS: { value: AspectRatioPreset; label: string }[] = [
  { value: '9_16', label: '9:16' },
  { value: '1_1', label: '1:1' },
  { value: '16_9', label: '16:9' }
];

const LAYOUT_PRESETS: { value: LayoutPreset; label: string }[] = [
  { value: RenderedClipLayout.DEFAULT, label: 'Default' },
  { value: RenderedClipLayout.FACECAM_TOP_50, label: '50/50' },
  { value: RenderedClipLayout.FACECAM_TOP_40, label: '40/60' },
  { value: RenderedClipLayout.FACECAM_TOP_30, label: '30/70' }
];

function formatAspectRatioPreset(preset: AspectRatioPreset) {
  return (
    ASPECT_RATIO_PRESETS.find((item) => item.value === preset)?.label || preset
  );
}

function formatLayoutPreset(preset: LayoutPreset | string) {
  return LAYOUT_PRESETS.find((item) => item.value === preset)?.label || preset;
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

function formatReviewStatus(status: string) {
  if (status === ClipCandidateReviewStatus.DISCARDED) {
    return 'Rejected';
  }

  if (status === ClipCandidateReviewStatus.PENDING) {
    return 'Pending';
  }

  return status.replaceAll('_', ' ');
}

function reviewStatusClasses(status: string) {
  if (status === ClipCandidateReviewStatus.APPROVED) {
    return 'bg-emerald-400/12 text-emerald-200 ring-emerald-300/20';
  }

  if (status === ClipCandidateReviewStatus.DISCARDED) {
    return 'bg-red-400/12 text-red-200 ring-red-300/20';
  }

  return 'bg-muted text-muted-foreground ring-border/80';
}

function generatedAssetGroupTitle(assetType: string) {
  if (assetType === 'x_post') {
    return 'X posts';
  }

  if (assetType === 'linkedin_post') {
    return 'LinkedIn posts';
  }

  return assetType.replaceAll('_', ' ');
}

function GeneratedAssetsSection({ assets }: { assets: EditorGeneratedAsset[] }) {
  const { toast } = useToast();
  const groupedAssets = useMemo(
    () =>
      assets.reduce<Record<string, EditorGeneratedAsset[]>>((groups, asset) => {
        groups[asset.assetType] ||= [];
        groups[asset.assetType].push(asset);
        return groups;
      }, {}),
    [assets]
  );
  const assetTypes = Object.keys(groupedAssets);

  if (assetTypes.length === 0) {
    return null;
  }

  async function copyAsset(asset: EditorGeneratedAsset) {
    try {
      await navigator.clipboard.writeText(asset.content.trim());
      toast({
        title: 'Post copied',
        description: 'The draft is ready to paste.',
        icon: successToastIcon
      });
    } catch {
      toast({
        title: 'Unable to copy post',
        description: 'Your browser blocked clipboard access.',
        variant: 'destructive'
      });
    }
  }

  return (
    <section className="mt-8 space-y-5 border-t border-white/10 pt-6">
      <div>
        <p className="text-sm text-blue-200">Generated posts</p>
        <h2 className="mt-1 text-lg font-semibold text-white">
          Review channel drafts
        </h2>
      </div>

      {assetTypes.map((assetType) => (
        <div key={assetType} className="space-y-3">
          <h3 className="text-sm font-semibold text-zinc-200">
            {generatedAssetGroupTitle(assetType)}
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            {groupedAssets[assetType].map((asset) => (
              <article
                key={asset.id}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-sm font-semibold text-white">
                    {asset.title || generatedAssetGroupTitle(asset.assetType)}
                  </h4>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-zinc-300 hover:bg-white/10"
                    onClick={() => copyAsset(asset)}
                    aria-label="Copy generated post"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-300">
                  {asset.content}
                </p>
              </article>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
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
  const titleClass = tone === 'error' ? 'text-red-100' : 'text-white';
  const descriptionClass = tone === 'error' ? 'text-red-200/80' : 'text-zinc-400';

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="max-w-lg text-center">
        {tone === 'loading' ? (
          <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-blue-200" />
        ) : tone === 'error' ? (
          <X className="mx-auto mb-4 h-10 w-10 text-red-200" />
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

function workflowStatusClasses(status: string | null | undefined) {
  if (status === 'ready' || status === 'approved') {
    return 'bg-emerald-400/12 text-emerald-200 ring-emerald-300/20';
  }

  if (status === 'failed' || status === 'discarded') {
    return 'bg-red-400/12 text-red-200 ring-red-300/20';
  }

  if (
    status === 'pending' ||
    status === 'rendering' ||
    status === 'detecting' ||
    status === 'generating' ||
    status === 'processing'
  ) {
    return 'bg-amber-400/12 text-amber-200 ring-amber-300/20';
  }

  return 'bg-muted text-muted-foreground ring-border/80';
}

function getRenderedClip(
  candidate: EditorClipCandidate | null,
  variant: RenderedClipVariant,
  layout: LayoutPreset = RenderedClipLayout.DEFAULT
) {
  return (
    candidate?.renderedClips.find(
      (clip) => clip.variant === variant && clip.layout === layout
    ) || null
  );
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
  return Boolean(candidate?.facecamDetections.length);
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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) {
      return;
    }

    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [expiresAt]);

  if (!expiresAt) {
    return null;
  }

  const remainingMs = new Date(expiresAt).getTime() - now;

  if (remainingMs <= 0) {
    return (
      <span className="rounded-full bg-red-400/12 px-2 py-1 text-xs text-red-200 ring-1 ring-red-300/20">
        Expired
      </span>
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
    <span className="rounded-full bg-amber-400/12 px-2 py-1 text-xs text-amber-200 ring-1 ring-amber-300/20">
      {compact ? label : `Expires in ${label}`}
    </span>
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
        'w-full overflow-hidden rounded-xl border bg-surface-1 text-left transition',
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
          <span
            className={cn(
              'rounded-full px-2 py-1 text-[11px] capitalize ring-1 ring-inset',
              reviewStatusClasses(candidate.reviewStatus)
            )}
          >
            {formatReviewStatus(candidate.reviewStatus)}
          </span>
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
          Review queue
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
                  'rounded-lg px-2 py-1.5 text-xs capitalize transition',
                  filter === item
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background/60 text-muted-foreground hover:text-foreground'
                )}
              >
                {item} {counts[item]}
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
      <div className="mx-auto flex max-w-5xl items-center gap-3 overflow-x-auto">
        <span className="shrink-0 text-sm text-blue-200">
          Original clips ({candidates.length})
        </span>
        <div className="h-4 w-px shrink-0 bg-white/10" />
        {(['all', 'pending', 'approved', 'rejected'] as ReviewFilter[]).map(
          (item) => (
            <button
              key={item}
              type="button"
              onClick={() => onFilterChange(item)}
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1 text-xs capitalize transition',
                filter === item
                  ? 'bg-white text-black'
                  : 'text-zinc-400 hover:bg-white/10 hover:text-white'
              )}
            >
              {item}
            </button>
          )
        )}
        {filteredCandidates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => onSelect(candidate.id)}
            className={cn(
              'shrink-0 rounded-md border px-3 py-1 text-xs transition',
              candidate.id === selectedCandidateId
                ? 'border-blue-300 bg-blue-300/15 text-blue-100'
                : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:text-white'
            )}
          >
            #{candidate.rank}
          </button>
        ))}
      </div>
    </div>
  );
}

function ApprovalControls({
  projectId,
  candidate,
  selectedAspectRatio,
  selectedLayout,
  captionsEnabled
}: {
  projectId: number;
  candidate: EditorClipCandidate;
  selectedAspectRatio: AspectRatioPreset;
  selectedLayout: LayoutPreset;
  captionsEnabled: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [
    approveState,
    approveFormAction,
    isApprovePending
  ] = useActionState<ActionState, FormData>(
    approveClipCandidateAndQueueRender,
    {}
  );
  const [rejectState, rejectFormAction, isRejectPending] = useActionState<ActionState, FormData>(
    updateClipCandidateReviewStatus,
    {}
  );

  useEffect(() => {
    if (approveState.success) {
      toast({
        title: 'Clip approved',
        description: approveState.success,
        icon: successToastIcon
      });
      router.refresh();
      return;
    }

    if (approveState.error) {
      toast({
        title: 'Unable to approve clip',
        description: approveState.error,
        variant: 'destructive'
      });
    }
  }, [approveState.error, approveState.success, router, toast]);

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
    <div className="grid grid-cols-2 gap-2">
      <form action={approveFormAction}>
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              disabled={isApprovePending}
              variant="outline"
              size="icon"
              className="w-full border-white/10 bg-white/[0.04] text-white hover:bg-emerald-400/15 hover:text-emerald-200"
            >
              {isApprovePending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="sr-only">Approve</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Approve and render {formatAspectRatioPreset(selectedAspectRatio)}{' '}
            {formatLayoutPreset(selectedLayout)}{' '}
            {captionsEnabled ? 'with captions' : 'without captions'}
          </TooltipContent>
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
            className="w-full border-white/10 bg-white/[0.04] text-white hover:bg-red-400/15 hover:text-red-200"
          >
            {isRejectPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ThumbsDown className="h-4 w-4" />
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

function ClipScorePanel({
  projectId,
  candidate,
  selectedAspectRatio,
  selectedLayout,
  captionsEnabled
}: {
  projectId: number;
  candidate: EditorClipCandidate;
  selectedAspectRatio: AspectRatioPreset;
  selectedLayout: LayoutPreset;
  captionsEnabled: boolean;
}) {
  const grades = scoreGrade(candidate.confidence);
  const rows = [
    ['Hook', grades.hook],
    ['Flow', grades.flow],
    ['Value', grades.value],
    ['Trend', grades.trend]
  ];

  return (
    <div className="w-24 shrink-0 space-y-3 pt-2">
      <ApprovalControls
        projectId={projectId}
        candidate={candidate}
        selectedAspectRatio={selectedAspectRatio}
        selectedLayout={selectedLayout}
        captionsEnabled={captionsEnabled}
      />
      <div className="text-center">
        <span className="text-3xl font-semibold text-emerald-400">
          {candidate.confidence}
        </span>
        <span className="text-sm font-semibold text-zinc-400">/100</span>
      </div>
      <div className="space-y-2 text-sm">
        {rows.map(([label, grade]) => (
          <div key={label} className="flex items-center justify-between gap-2">
            <span
              className={cn(
                'font-semibold',
                grade.startsWith('A')
                  ? 'text-emerald-400'
                  : grade.startsWith('B')
                    ? 'text-yellow-300'
                    : 'text-orange-400'
              )}
            >
              {grade}
            </span>
            <span className="text-zinc-300">{label}</span>
          </div>
        ))}
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

function ClipPreviewPanel({
  candidate,
  previewClip,
  selectedRenderClip,
  selectedAspectRatio,
  selectedLayout,
  fullTranscript
}: {
  candidate: EditorClipCandidate | null;
  previewClip: EditorRenderedClip | null;
  selectedRenderClip: EditorRenderedClip | null;
  selectedAspectRatio: AspectRatioPreset;
  selectedLayout: LayoutPreset;
  fullTranscript: string | null;
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

  return (
    <section className="min-w-0 flex-1">
      <div className="mb-7 flex items-start gap-3">
        <h1 className="max-w-2xl text-2xl font-semibold leading-tight text-white">
          <span className="text-blue-200">#{candidate.rank}</span>{' '}
          {candidate.title}
        </h1>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="mt-1 rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white"
            >
              <Pencil className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Edit title</TooltipContent>
        </Tooltip>
      </div>

      <div className="grid min-w-0 gap-0 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="relative flex aspect-[9/16] min-h-[24rem] items-center justify-center overflow-hidden rounded-t-lg border border-white/10 bg-black lg:rounded-l-lg lg:rounded-tr-none">
          {selectedRenderFailed ? (
            <div className="flex h-full w-full items-center justify-center bg-black p-5 text-center">
              <div>
                <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-red-400/15 text-red-200 ring-1 ring-red-300/20">
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

        <div className="min-w-0 rounded-b-lg border border-white/10 bg-[#08080a] lg:rounded-r-lg lg:rounded-bl-none">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <p className="text-sm text-zinc-300">Scene analysis</p>
            <div className="flex items-center rounded-md border border-white/10 bg-white/[0.03] p-1 text-xs">
              <button
                type="button"
                onClick={() => setTranscriptView('clip')}
                className={cn(
                  'rounded px-2.5 py-1 transition',
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
                  'rounded px-2.5 py-1 transition disabled:cursor-not-allowed disabled:opacity-40',
                  transcriptView === 'full'
                    ? 'bg-white text-black'
                    : 'text-zinc-400 hover:text-white'
                )}
              >
                Full transcript
              </button>
            </div>
          </div>
          <div className="space-y-4 p-4 text-sm leading-6">
            <div>
              {!showFullTranscript ? (
                <>
                  <p className="font-mono text-zinc-400">
                    [{formatClipTimestamp(candidate.startTimeMs)}-
                    {formatClipTimestamp(candidate.endTimeMs)}]
                  </p>
                  <p className="mt-1 font-semibold text-white">
                    {candidate.transcriptExcerpt}
                  </p>
                </>
              ) : (
                <div className="max-h-48 overflow-y-auto">
                  <p className="whitespace-pre-wrap font-semibold text-white">
                    {trimmedFullTranscript}
                  </p>
                </div>
              )}
            </div>
            <div className="border-t border-white/10 pt-4">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                Why it was selected
              </p>
              <p className="mt-2 text-zinc-300">{candidate.whyItWorks}</p>
              <p className="mt-2 text-zinc-400">{candidate.platformFit}</p>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <span
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs capitalize ring-1 ring-inset',
                  reviewStatusClasses(candidate.reviewStatus)
                )}
              >
                {formatReviewStatus(candidate.reviewStatus)}
              </span>
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-xs capitalize text-zinc-400 ring-1 ring-white/10">
                {formatAspectRatioPreset(selectedAspectRatio)}
              </span>
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-zinc-400 ring-1 ring-white/10">
                {formatLayoutPreset(selectedLayout)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ClipActionPanel({
  projectId,
  candidate,
  previewClip,
  selectedAspectRatio,
  selectedLayout,
  captionsEnabled,
  onAspectRatioChange,
  onLayoutChange,
  onCaptionsEnabledChange
}: {
  projectId: number;
  candidate: EditorClipCandidate | null;
  previewClip: EditorRenderedClip | null;
  selectedAspectRatio: AspectRatioPreset;
  selectedLayout: LayoutPreset;
  captionsEnabled: boolean;
  onAspectRatioChange: (aspectRatio: AspectRatioPreset) => void;
  onLayoutChange: (layout: LayoutPreset) => void;
  onCaptionsEnabledChange: (enabled: boolean) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [renderState, renderAction, isRenderPending] = useActionState<
    ActionState,
    FormData
  >(renderApprovedClip, {});
  const [facecamState, facecamAction, isFacecamPending] = useActionState<
    ActionState,
    FormData
  >(detectClipFacecam, {});
  const [saveClipState, saveClipAction, isSaveClipPending] = useActionState<
    ActionState,
    FormData
  >(saveApprovedClip, {});

  useEffect(() => {
    const state = renderState.success
      ? renderState
      : facecamState.success
        ? facecamState
        : saveClipState.success
          ? saveClipState
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
    facecamState,
    renderState,
    router,
    saveClipState,
    toast,
  ]);

  if (!candidate) {
    return (
      <aside className="border-l border-border/70 bg-card p-4 text-sm text-muted-foreground">
        Select a candidate to approve, reject, render, and export.
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
  const canRenderTrimmed =
    candidate.sourceAssetType === SourceAssetType.UPLOADED_FILE &&
    candidate.reviewStatus === ClipCandidateReviewStatus.APPROVED &&
    !sourceMediaUnavailable;
  const canDetectFacecam =
    candidate.sourceAssetType === SourceAssetType.UPLOADED_FILE &&
    !sourceMediaUnavailable &&
    ![FacecamDetectionStatus.PENDING, FacecamDetectionStatus.DETECTING].includes(
      candidate.facecamDetectionStatus as FacecamDetectionStatus
    );
  const candidateHasFacecam = hasFacecam(candidate);
  const actionError =
    renderState.error ||
    facecamState.error ||
    saveClipState.error ||
    null;
  const hasSavableRenderedClip =
    candidate.reviewStatus === ClipCandidateReviewStatus.APPROVED &&
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
        'Approve this clip to render and preview the selected format.',
      icon: successToastIcon
    });
  };

  const selectLayout = (layout: LayoutPreset) => {
    if (layout !== RenderedClipLayout.DEFAULT && !candidateHasFacecam) {
      return;
    }

    onLayoutChange(layout);
    toast({
      title: `${formatLayoutPreset(layout)} layout selected`,
      description: candidateHasFacecam
        ? 'Approve this clip to render and preview the selected layout.'
        : 'Default layout selected.',
      icon: successToastIcon
    });
  };

  return (
    <aside className="w-full shrink-0 lg:w-40">
      <div className="space-y-5">
        <div>
          <div className="flex flex-col gap-4">
            <div className="grid gap-2">
              <form action={renderAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <input
                  type="hidden"
                  name="clipCandidateId"
                  value={candidate.id}
                />
                <input
                  type="hidden"
                  name="captionsEnabled"
                  value={String(captionsEnabled)}
                />
                <Button
                  type="submit"
                  size="sm"
                  className="w-full justify-start bg-white/10 text-white hover:bg-white/15"
                  disabled={!canRenderTrimmed || isRenderPending}
                >
                  {isRenderPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Scissors className="h-4 w-4" />
                  )}
                  Edit clip
                </Button>
              </form>
              <form action={saveClipAction}>
                <input
                  type="hidden"
                  name="clipCandidateId"
                  value={candidate.id}
                />
                <Button
                  type="submit"
                  size="sm"
                  className="w-full justify-start bg-white/10 text-white hover:bg-white/15"
                  disabled={!hasSavableRenderedClip || isSaveClipPending}
                >
                  {isSaveClipPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  Save clip
                </Button>
              </form>
            </div>
            <div className="grid gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    className="w-full justify-start bg-white/10 text-white hover:bg-white/15"
                  >
                    <Crop className="h-4 w-4" />
                    {formatAspectRatioPreset(selectedAspectRatio)}
                  </Button>
                </DropdownMenuTrigger>
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
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    className="w-full justify-start bg-white/10 text-white hover:bg-white/15"
                  >
                    <SplitSquareVertical className="h-4 w-4" />
                    {formatLayoutPreset(selectedLayout)}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-32">
                  <DropdownMenuRadioGroup
                    value={selectedLayout}
                    onValueChange={(value) =>
                      selectLayout(value as LayoutPreset)
                    }
                  >
                    {LAYOUT_PRESETS.map((layout) => {
                      const disabled =
                        layout.value !== RenderedClipLayout.DEFAULT &&
                        !candidateHasFacecam;

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
              <form action={facecamAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <input
                  type="hidden"
                  name="clipCandidateId"
                  value={candidate.id}
                />
                <Button
                  type="submit"
                  size="sm"
                  className="w-full justify-start bg-white/10 text-white hover:bg-white/15"
                  disabled={!canDetectFacecam || isFacecamPending}
                >
                  {isFacecamPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ScanFace className="h-4 w-4" />
                  )}
                  Facecam
                </Button>
              </form>
              <Button
                type="button"
                size="sm"
                className={cn(
                  'justify-start hover:bg-white/15',
                  captionsEnabled
                    ? 'bg-white text-black hover:text-black'
                    : 'bg-white/10 text-white'
                )}
                onClick={() => onCaptionsEnabledChange(!captionsEnabled)}
              >
                <Captions className="h-4 w-4" />
                {captionsEnabled ? 'Captions' : 'No captions'}
              </Button>
            </div>
            <div className="grid gap-2">
              <Button
                type="button"
                size="sm"
                className="justify-start bg-white/10 text-white hover:bg-white/15"
                onClick={() =>
                  copyCandidateText('Caption', candidate.captionCopy)
                }
              >
                <Captions className="h-4 w-4" />
                Copy caption
              </Button>
              {hasCandidateHook(candidate.hook) ? (
                <Button
                  type="button"
                  size="sm"
                  className="justify-start bg-white/10 text-white hover:bg-white/15"
                  onClick={() => copyCandidateText('Hook', candidate.hook)}
                >
                  <Copy className="h-4 w-4" />
                  Copy hook
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                className="justify-start bg-white/10 text-white hover:bg-white/15"
                onClick={() =>
                  copyCandidateText(
                    'Transcript excerpt',
                    candidate.transcriptExcerpt
                  )
                }
              >
                <Copy className="h-4 w-4" />
                Copy transcript
              </Button>
            </div>
            <div className="grid gap-2">
              {/* TODO: Wire these actions when durable backend workflows exist. */}
              <Button
                type="button"
                size="sm"
                className="justify-start bg-white/10 text-white hover:bg-white/15"
                disabled
              >
                <Mic2 className="h-4 w-4" />
                Enhance speech
              </Button>
              <Button
                type="button"
                size="sm"
                className="justify-start bg-white/10 text-white hover:bg-white/15"
                disabled
              >
                <Copy className="h-4 w-4" />
                Duplicate
              </Button>
              <Button
                type="button"
                size="sm"
                className="justify-start bg-white/10 text-white hover:bg-white/15"
                disabled
              >
                <RotateCcw className="h-4 w-4" />
                Regenerate
              </Button>
              {previewClip ? (
                <Button
                  asChild
                  size="sm"
                  className="w-full justify-start bg-white text-black hover:bg-zinc-200"
                >
                  <a
                    href={`/api/rendered-clips/${previewClip.id}/download?download=1`}
                    download
                  >
                    <Download className="h-4 w-4" />
                    Download HD
                  </a>
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="justify-start bg-white/10 text-white hover:bg-white/15"
                  disabled
                >
                  <Download className="h-4 w-4" />
                  Download HD
                </Button>
              )}
            </div>
          </div>
          {actionError ? (
            <p className="mt-3 rounded-lg border border-red-300/20 bg-red-400/10 p-2 text-xs leading-5 text-red-200">
              {actionError}
            </p>
          ) : null}
        </div>
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <p className="text-sm font-semibold text-foreground">Facecam</p>
          <span
            className={cn(
              'mt-2 inline-flex rounded-full px-2 py-1 text-xs capitalize ring-1 ring-inset',
              workflowStatusClasses(candidate.facecamDetectionStatus)
            )}
          >
            {candidate.facecamDetectionStatus.replaceAll('_', ' ')}
          </span>
        </div>
      </div>
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
            'rounded-lg px-3 py-2 text-sm capitalize',
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
  generatedAssets,
  autoSaveApprovedClipsEnabled
}: ProjectClipEditorProps) {
  const router = useRouter();
  const [selectedSourceAssetId, setSelectedSourceAssetId] = useState(
    sourceAssets[0]?.id ?? null
  );
  const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(
    clipCandidates[0]?.id ?? null
  );
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [selectedAspectRatio, setSelectedAspectRatio] =
    useState<AspectRatioPreset>('9_16');
  const [selectedLayout, setSelectedLayout] = useState<LayoutPreset>(
    RenderedClipLayout.DEFAULT
  );
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [activeTab, setActiveTab] = useState<'clips' | 'preview' | 'actions'>(
    'preview'
  );

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
  const selectedCandidate =
    activeCandidates.find((candidate) => candidate.id === selectedCandidateId) ||
    activeCandidates[0] ||
    null;
  const selectedRatioClip = getRenderedClip(
    selectedCandidate,
    getRenderedClipVariantForAspectRatio(selectedAspectRatio),
    selectedLayout
  );
  const fallbackRenderedClip =
    selectedCandidate?.renderedClips.find(
      (clip) =>
        clip.variant !== RenderedClipVariant.TRIMMED_ORIGINAL &&
        clip.layout === selectedLayout &&
        clip.status === 'ready' &&
        !isMediaUnavailable(clip)
    ) ||
    null;
  const trimmedClip = getRenderedClip(
    selectedCandidate,
    RenderedClipVariant.TRIMMED_ORIGINAL
  );
  const previewClip =
    selectedRatioClip?.status === 'ready' && !isMediaUnavailable(selectedRatioClip)
      ? selectedRatioClip
      : fallbackRenderedClip
        ? fallbackRenderedClip
      : trimmedClip?.status === 'ready' && !isMediaUnavailable(trimmedClip)
        ? trimmedClip
        : null;
  const hasActiveWorkflow = hasActiveWorkflowState(sourceAssets);

  useEffect(() => {
    if (activeCandidates.length > 0 && !selectedCandidate) {
      setSelectedCandidateId(activeCandidates[0].id);
    }
  }, [activeCandidates, selectedCandidate]);

  useEffect(() => {
    if (selectedLayout !== RenderedClipLayout.DEFAULT && !hasFacecam(selectedCandidate)) {
      setSelectedLayout(RenderedClipLayout.DEFAULT);
    }
  }, [selectedCandidate, selectedLayout]);

  useEffect(() => {
    if (!hasActiveWorkflow || activeCandidates.length > 0) {
      return;
    }

    const interval = window.setInterval(() => {
      router.refresh();
    }, 3000);

    return () => window.clearInterval(interval);
  }, [activeCandidates.length, hasActiveWorkflow, router]);

  if (sourceAssets.length === 0) {
    return <EmptyUploadWorkspace project={project} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
        {sourceAssets.length > 1 ? (
          <div className="flex gap-2 overflow-x-auto border-b border-border/70 px-4 py-2">
            {sourceAssets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                onClick={() => {
                  setSelectedSourceAssetId(asset.id);
                  const firstCandidate = sortedCandidates.find(
                    (candidate) => candidate.sourceAssetId === asset.id
                  );
                  setSelectedCandidateId(firstCandidate?.id ?? null);
                }}
                className={cn(
                  'flex min-w-48 items-center gap-2 rounded-md border px-3 py-2 text-left text-xs',
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
          <CandidateStrip
            candidates={activeCandidates}
            selectedCandidateId={selectedCandidate?.id || null}
            filter={filter}
            onFilterChange={setFilter}
            onSelect={(id) => {
              setSelectedCandidateId(id);
              setActiveTab('preview');
            }}
          />
        ) : null}

        {activeCandidates.length > 0 ? (
          <MobileReviewTabs activeTab={activeTab} onTabChange={setActiveTab} />
        ) : null}

        {activeCandidates.length === 0 ? (
          <EmptyClipWorkflowState
            projectId={project.id}
            sourceAsset={activeSource}
          />
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
            <div className="mx-auto max-w-[68rem]">
              <div className="mb-8 flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-blue-200">
                    Original clips ({activeCandidates.length})
                  </p>
                  <div className="mt-8 max-w-3xl rounded-lg border border-white/0 bg-transparent p-0">
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
                            className="rounded-md p-1 text-zinc-300 hover:bg-white/10"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Dismiss</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </div>

                <div className="hidden items-center gap-2 lg:flex">
                  <SaveProjectControl projectId={project.id} />
                  <AutoSaveApprovedClipsControl
                    enabled={autoSaveApprovedClipsEnabled}
                  />
                </div>
              </div>

              {selectedCandidate ? (
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
                  <div className={cn(activeTab !== 'clips' && 'hidden lg:block')}>
                    <ClipScorePanel
                      projectId={project.id}
                      candidate={selectedCandidate}
                      selectedAspectRatio={selectedAspectRatio}
                      selectedLayout={selectedLayout}
                      captionsEnabled={captionsEnabled}
                    />
                  </div>
                  <div className={cn(activeTab !== 'preview' && 'hidden lg:block', 'min-w-0 flex-1')}>
                    <ClipPreviewPanel
                      candidate={selectedCandidate}
                      previewClip={previewClip}
                      selectedRenderClip={selectedRatioClip}
                      selectedAspectRatio={selectedAspectRatio}
                      selectedLayout={selectedLayout}
                      fullTranscript={activeSource?.transcriptContent || null}
                    />
                  </div>
                  <div className={cn(activeTab !== 'actions' && 'hidden lg:block')}>
                    <ClipActionPanel
                      projectId={project.id}
                      candidate={selectedCandidate}
                      previewClip={previewClip}
                      selectedAspectRatio={selectedAspectRatio}
                      selectedLayout={selectedLayout}
                      captionsEnabled={captionsEnabled}
                      onAspectRatioChange={setSelectedAspectRatio}
                      onLayoutChange={setSelectedLayout}
                      onCaptionsEnabledChange={setCaptionsEnabled}
                    />
                  </div>
                </div>
              ) : null}

              <GeneratedAssetsSection assets={generatedAssets} />
            </div>
          </main>
        )}
    </div>
  );
}

export function ProjectClipEditor(props: ProjectClipEditorProps) {
  return <ProjectReviewPage {...props} />;
}
