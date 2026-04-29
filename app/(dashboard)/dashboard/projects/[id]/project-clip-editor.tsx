'use client';

import Link from 'next/link';
import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Captions,
  Check,
  Clapperboard,
  Copy,
  Download,
  Filter,
  FileVideo,
  Loader2,
  Mic2,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  ScanFace,
  Scissors,
  Sparkles,
  SplitSquareVertical,
  ThumbsDown,
  WandSparkles,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { successToastIcon } from '@/components/ui/toaster';
import { useToast } from '@/hooks/use-toast';
import {
  detectClipFacecam,
  formatRenderedClipShortForm,
  generateShortFormPack,
  renderApprovedClip,
  saveApprovedClip,
  saveProject,
  updateAutoSaveApprovedClipsSetting,
  updateClipCandidateReviewStatus
} from '@/lib/disburse/actions';
import {
  ClipCandidateReviewStatus,
  FacecamDetectionStatus,
  RenderedClipVariant,
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
type LayoutPreset =
  | 'auto'
  | 'overlay'
  | 'split'
  | 'facecam_focus'
  | 'gameplay_focus'
  | 'manual_crop';

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
  variant: RenderedClipVariant
) {
  return (
    candidate?.renderedClips.find((clip) => clip.variant === variant) || null
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

function splitTranscript(content: string | null) {
  if (!content) {
    return [];
  }

  return content
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 10);
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
  candidate
}: {
  candidate: EditorClipCandidate;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    updateClipCandidateReviewStatus,
    {}
  );

  useEffect(() => {
    if (state.success) {
      toast({
        title: 'Clip updated',
        description: state.success,
        icon: successToastIcon
      });
      router.refresh();
      return;
    }

    if (state.error) {
      toast({
        title: 'Unable to update clip',
        description: state.error,
        variant: 'destructive'
      });
    }
  }, [router, state.error, state.success, toast]);

  return (
    <form action={formAction} className="grid grid-cols-2 gap-2">
      <input type="hidden" name="contentPackId" value={candidate.contentPackId} />
      <input type="hidden" name="clipCandidateId" value={candidate.id} />
      <Button
        type="submit"
        name="reviewStatus"
        value={ClipCandidateReviewStatus.APPROVED}
        disabled={isPending}
        variant="outline"
        size="icon"
        className="border-white/10 bg-white/[0.04] text-white hover:bg-emerald-400/15 hover:text-emerald-200"
        title="Approve"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Check className="h-4 w-4" />
        )}
        <span className="sr-only">Approve</span>
      </Button>
      <Button
        type="submit"
        name="reviewStatus"
        value={ClipCandidateReviewStatus.DISCARDED}
        disabled={isPending}
        variant="outline"
        size="icon"
        className="border-white/10 bg-white/[0.04] text-white hover:bg-red-400/15 hover:text-red-200"
        title="Reject"
      >
        <ThumbsDown className="h-4 w-4" />
        <span className="sr-only">Reject</span>
      </Button>
    </form>
  );
}

function ClipScorePanel({ candidate }: { candidate: EditorClipCandidate }) {
  const grades = scoreGrade(candidate.confidence);
  const rows = [
    ['Hook', grades.hook],
    ['Flow', grades.flow],
    ['Value', grades.value],
    ['Trend', grades.trend]
  ];

  return (
    <div className="w-24 shrink-0 space-y-3 pt-2">
      <ApprovalControls candidate={candidate} />
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
  selectedLayout
}: {
  candidate: EditorClipCandidate | null;
  previewClip: EditorRenderedClip | null;
  selectedLayout: LayoutPreset;
}) {
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
  const previewLabel = previewClip
    ? 'Rendered clip'
    : sourcePreviewUrl || youtubePreviewUrl
      ? 'Candidate preview'
      : 'No media preview';

  return (
    <section className="min-w-0 flex-1">
      <div className="mb-7 flex items-start gap-3">
        <h1 className="max-w-2xl text-2xl font-semibold leading-tight text-white">
          <span className="text-blue-200">#{candidate.rank}</span>{' '}
          {candidate.title}
        </h1>
        <button
          type="button"
          className="mt-1 rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white"
          title="Edit title"
        >
          <Pencil className="h-4 w-4" />
        </button>
      </div>

      <div className="grid min-w-0 gap-2 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="relative flex aspect-[9/16] min-h-[24rem] items-center justify-center overflow-hidden rounded-t-lg border border-white/10 bg-black lg:rounded-l-lg lg:rounded-tr-none">
          {previewClip ? (
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
          <div className="absolute left-3 top-3 rounded bg-black/55 px-2 py-1 text-[11px] font-semibold uppercase text-white/80">
            {previewLabel}
          </div>
          <div className="absolute right-3 top-3 rounded-full bg-black/65 px-2 py-1 text-xs font-semibold text-white">
            {formatClipTimestamp(candidate.durationMs)}
          </div>
        </div>

        <div className="min-w-0 rounded-b-lg border border-white/10 bg-[#08080a] lg:rounded-r-lg lg:rounded-bl-none">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <p className="text-sm text-zinc-300">Scene analysis</p>
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="size-4 rounded border border-white/25" />
              Transcript only
            </div>
          </div>
          <div className="space-y-4 p-4 text-sm leading-6">
            <div>
              <p className="font-mono text-zinc-400">
                [{formatClipTimestamp(candidate.startTimeMs)}-
                {formatClipTimestamp(candidate.endTimeMs)}]
              </p>
              <p className="mt-1 font-semibold text-white">
                {candidate.transcriptExcerpt}
              </p>
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
                {selectedLayout.replaceAll('_', ' ')}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ClipLayoutSelector({
  candidate,
  selectedLayout,
  onChange
}: {
  candidate: EditorClipCandidate | null;
  selectedLayout: LayoutPreset;
  onChange: (layout: LayoutPreset) => void;
}) {
  const facecamAvailable = hasFacecam(candidate);
  const layouts: { value: LayoutPreset; label: string; facecam?: boolean }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'overlay', label: 'Overlay', facecam: true },
    { value: 'split', label: 'Split', facecam: true },
    { value: 'facecam_focus', label: 'Facecam Focus', facecam: true },
    { value: 'gameplay_focus', label: 'Gameplay Focus' },
    { value: 'manual_crop', label: 'Manual Crop' }
  ];

  return (
    <div>
      <p className="mb-3 text-sm font-semibold text-foreground">Layout</p>
      <div className="grid gap-2">
        {layouts.map((layout) => {
          const disabled = Boolean(layout.facecam && !facecamAvailable);

          return (
            <button
              key={layout.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(layout.value)}
              className={cn(
                'flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-45',
                selectedLayout === layout.value
                  ? 'border-primary/60 bg-primary/15 text-primary'
                  : 'border-border/70 bg-background/40 text-muted-foreground hover:text-foreground'
              )}
            >
              {layout.label}
              {layout.facecam ? <ScanFace className="h-4 w-4" /> : null}
            </button>
          );
        })}
      </div>
      {!facecamAvailable ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Facecam-specific layouts unlock after facecam detection finds a stable
          region.
        </p>
      ) : null}
      {/* TODO: Persist per-clip layout when a clip settings endpoint or schema exists. */}
    </div>
  );
}

function ClipActionPanel({
  projectId,
  candidate,
  previewClip,
  selectedLayout,
  onLayoutChange
}: {
  projectId: number;
  candidate: EditorClipCandidate | null;
  previewClip: EditorRenderedClip | null;
  selectedLayout: LayoutPreset;
  onLayoutChange: (layout: LayoutPreset) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [renderState, renderAction, isRenderPending] = useActionState<
    ActionState,
    FormData
  >(renderApprovedClip, {});
  const [verticalState, verticalAction, isVerticalPending] = useActionState<
    ActionState,
    FormData
  >(formatRenderedClipShortForm, {});
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
      : verticalState.success
        ? verticalState
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
    verticalState
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
  const canRenderVertical =
    canRenderTrimmed &&
    trimmedClip?.status === 'ready' &&
    !isMediaUnavailable(trimmedClip);
  const canDetectFacecam =
    candidate.sourceAssetType === SourceAssetType.UPLOADED_FILE &&
    !sourceMediaUnavailable &&
    ![FacecamDetectionStatus.PENDING, FacecamDetectionStatus.DETECTING].includes(
      candidate.facecamDetectionStatus as FacecamDetectionStatus
    );
  const verticalClip = getRenderedClip(
    candidate,
    RenderedClipVariant.VERTICAL_SHORT_FORM
  );
  const actionError =
    renderState.error ||
    verticalState.error ||
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

  return (
    <aside className="w-full shrink-0 lg:w-40">
      <div className="space-y-5">
        <div>
          <div className="grid gap-2">
            <form action={renderAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="clipCandidateId" value={candidate.id} />
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
              <input type="hidden" name="clipCandidateId" value={candidate.id} />
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
            <form action={verticalAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="clipCandidateId" value={candidate.id} />
              <Button
                type="submit"
                size="sm"
                className="w-full justify-start bg-white/10 text-white hover:bg-white/15"
                disabled={!canRenderVertical || isVerticalPending}
              >
                {isVerticalPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <SplitSquareVertical className="h-4 w-4" />
                )}
                9:16
              </Button>
            </form>
            <form action={facecamAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="clipCandidateId" value={candidate.id} />
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
              className="justify-start bg-white/10 text-white hover:bg-white/15"
              onClick={() => copyCandidateText('Caption', candidate.captionCopy)}
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
                copyCandidateText('Transcript excerpt', candidate.transcriptExcerpt)
              }
            >
              <Copy className="h-4 w-4" />
              Copy transcript
            </Button>
            {/* TODO: Wire these actions when durable backend workflows exist. */}
            <Button type="button" size="sm" className="justify-start bg-white/10 text-white hover:bg-white/15" disabled>
              <Mic2 className="h-4 w-4" />
              Enhance speech
            </Button>
            <Button type="button" size="sm" className="justify-start bg-white/10 text-white hover:bg-white/15" disabled>
              <Copy className="h-4 w-4" />
              Duplicate
            </Button>
            <Button type="button" size="sm" className="justify-start bg-white/10 text-white hover:bg-white/15" disabled>
              <RotateCcw className="h-4 w-4" />
              Regenerate
            </Button>
            {previewClip ? (
              <Button asChild size="sm" className="w-full justify-start bg-white text-black hover:bg-zinc-200">
                <a href={`/api/rendered-clips/${previewClip.id}/download`}>
                  <Download className="h-4 w-4" />
                  Download HD
                </a>
              </Button>
            ) : null}
          </div>
          {actionError ? (
            <p className="mt-3 rounded-lg border border-red-300/20 bg-red-400/10 p-2 text-xs leading-5 text-red-200">
              {actionError}
            </p>
          ) : null}
        </div>

        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <p className="mb-3 text-sm font-semibold text-foreground">
            Export status
          </p>
          <div className="space-y-2">
            {[
              ['Trimmed original', trimmedClip],
              ['Vertical short form', verticalClip]
            ].map(([label, clip]) => (
              <div
                key={label as string}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/40 px-3 py-2 text-sm"
              >
                <span className="text-muted-foreground">{label as string}</span>
                <span
                  className={cn(
                    'rounded-full px-2 py-1 text-[11px] capitalize ring-1 ring-inset',
                    workflowStatusClasses((clip as EditorRenderedClip | null)?.status)
                  )}
                >
                  {(clip as EditorRenderedClip | null)?.retentionStatus === 'saved'
                    ? 'saved'
                    : (clip as EditorRenderedClip | null)?.status?.replaceAll('_', ' ') ||
                      'not started'}
                </span>
                {(clip as EditorRenderedClip | null)?.retentionStatus ===
                  'temporary' ? (
                  <ExpirationCountdown
                    expiresAt={(clip as EditorRenderedClip).expiresAt}
                    compact
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <ClipLayoutSelector
            candidate={candidate}
            selectedLayout={selectedLayout}
            onChange={onLayoutChange}
          />
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
          {candidate.facecamDetections[0] ? (
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              <p>
                Position: {candidate.facecamDetections[0].xPx}px,{' '}
                {candidate.facecamDetections[0].yPx}px
              </p>
              <p>
                Size: {candidate.facecamDetections[0].widthPx}x
                {candidate.facecamDetections[0].heightPx}
              </p>
              <p>Confidence: {candidate.facecamDetections[0].confidence}%</p>
            </div>
          ) : null}
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
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Check className="h-4 w-4" />
        )}
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
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Check className="h-4 w-4" />
        )}
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
  const [selectedSourceAssetId, setSelectedSourceAssetId] = useState(
    sourceAssets[0]?.id ?? null
  );
  const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(
    clipCandidates[0]?.id ?? null
  );
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [selectedLayout, setSelectedLayout] = useState<LayoutPreset>('auto');
  const [activeTab, setActiveTab] = useState<'clips' | 'preview' | 'actions'>(
    'preview'
  );
  const [generateState, generateAction, isGeneratePending] = useActionState<
    ActionState,
    FormData
  >(generateShortFormPack, {});

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
  const verticalClip = getRenderedClip(
    selectedCandidate,
    RenderedClipVariant.VERTICAL_SHORT_FORM
  );
  const trimmedClip = getRenderedClip(
    selectedCandidate,
    RenderedClipVariant.TRIMMED_ORIGINAL
  );
  const previewClip =
    verticalClip?.status === 'ready' && !isMediaUnavailable(verticalClip)
      ? verticalClip
      : trimmedClip?.status === 'ready' && !isMediaUnavailable(trimmedClip)
        ? trimmedClip
        : null;
  const canGenerateForActiveSource =
    activeSource?.assetType !== SourceAssetType.PASTED_TRANSCRIPT &&
    activeSource?.transcriptStatus === TranscriptStatus.READY;
  const transcriptParts = splitTranscript(activeSource?.transcriptContent || null);

  useEffect(() => {
    if (activeCandidates.length > 0 && !selectedCandidate) {
      setSelectedCandidateId(activeCandidates[0].id);
    }
  }, [activeCandidates, selectedCandidate]);

  useEffect(() => {
    if (generateState.success) {
      window.dispatchEvent(new Event(TRANSCRIPT_TRACKING_REFRESH_EVENT));
    }
  }, [generateState.success]);

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

        <MobileReviewTabs activeTab={activeTab} onTabChange={setActiveTab} />

        {activeCandidates.length === 0 ? (
          <main className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="max-w-lg rounded-xl border border-white/10 bg-white/[0.03] p-6 text-center">
              <Clapperboard className="mx-auto mb-4 h-10 w-10 text-blue-200" />
              <h2 className="text-xl font-semibold text-white">
                No candidates yet
              </h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Generate clips after the transcript is ready. The ranked review
                queue will appear here.
              </p>
              {canGenerateForActiveSource && activeSource ? (
                <form action={generateAction} className="mt-5">
                  <input type="hidden" name="projectId" value={project.id} />
                  <input
                    type="hidden"
                    name="sourceAssetId"
                    value={activeSource.id}
                  />
                  <Button type="submit" disabled={isGeneratePending}>
                    {isGeneratePending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    Generate clips
                  </Button>
                </form>
              ) : null}
              {activeSource?.transcriptFailureReason ||
              activeSource?.failureReason ? (
                <p className="mt-4 text-sm text-red-300">
                  {activeSource.transcriptFailureReason ||
                    activeSource.failureReason}
                </p>
              ) : null}
            </div>
          </main>
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
                      <button
                        type="button"
                        className="rounded-md p-1 text-zinc-300 hover:bg-white/10"
                        title="Dismiss"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="hidden items-center gap-2 lg:flex">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/dashboard/projects/${project.id}/setup`}>
                      <WandSparkles className="h-4 w-4" />
                      Setup
                    </Link>
                  </Button>
                  <SaveProjectControl projectId={project.id} />
                  <AutoSaveApprovedClipsControl
                    enabled={autoSaveApprovedClipsEnabled}
                  />
                  {previewClip ? (
                    <Button asChild size="sm">
                      <a href={`/api/rendered-clips/${previewClip.id}/download`}>
                        <Download className="h-4 w-4" />
                        Export
                      </a>
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm">
                    <Check className="h-4 w-4" />
                    Select
                  </Button>
                  <Button variant="ghost" size="sm">
                    <Filter className="h-4 w-4" />
                    Filter
                  </Button>
                  <Button variant="ghost" size="icon">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {selectedCandidate ? (
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
                  <div className={cn(activeTab !== 'clips' && 'hidden lg:block')}>
                    <ClipScorePanel candidate={selectedCandidate} />
                  </div>
                  <div className={cn(activeTab !== 'preview' && 'hidden lg:block', 'min-w-0 flex-1')}>
                    <ClipPreviewPanel
                      candidate={selectedCandidate}
                      previewClip={previewClip}
                      selectedLayout={selectedLayout}
                    />
                  </div>
                  <div className={cn(activeTab !== 'actions' && 'hidden lg:block')}>
                    <ClipActionPanel
                      projectId={project.id}
                      candidate={selectedCandidate}
                      previewClip={previewClip}
                      selectedLayout={selectedLayout}
                      onLayoutChange={setSelectedLayout}
                    />
                  </div>
                </div>
              ) : null}

              {transcriptParts.length > 0 ? (
                <div className="mt-8 hidden max-h-24 overflow-y-auto border-t border-white/10 pt-4 text-xs leading-5 text-zinc-500 xl:block">
                  {transcriptParts.map((part, index) => (
                    <span key={`${index}-${part.slice(0, 12)}`} className="mr-4">
                      {part}
                    </span>
                  ))}
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
