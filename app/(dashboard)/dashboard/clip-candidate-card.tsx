'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { BookmarkPlus, Check, Loader2, Scissors, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { successToastIcon } from '@/components/ui/toaster';
import { useToast } from '@/hooks/use-toast';
import {
  formatRenderedClipShortForm,
  renderApprovedClip,
  updateClipCandidateReviewStatus
} from '@/lib/disburse/actions';
import { formatSourceAssetFileSize } from '@/lib/disburse/presentation';
import { RenderedClipVariant, SourceAssetType } from '@/lib/db/schema';
import { TRANSCRIPT_TRACKING_REFRESH_EVENT } from '@/components/dashboard/transcript-toast-watcher';

type ClipCandidateActionState = {
  error?: string;
  success?: string;
};

type RenderClipActionState = {
  error?: string;
  success?: string;
};

type FormatVerticalActionState = {
  error?: string;
  success?: string;
};

type ClipCandidateCardProps = {
  contentPackId: number;
  projectId: number;
  sourceAssetType: string;
  candidate: {
    id: number;
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
    renderedClips: {
      id: number;
      variant: string;
      status: string;
      title: string;
      durationMs: number;
      fileSizeBytes: number | null;
      failureReason: string | null;
    }[];
  };
};

function formatTimestamp(totalMs: number) {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }

  return [minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatReviewStatus(status: string) {
  return status.replaceAll('_', ' ');
}

function getRenderedClipVariant(
  renderedClips: ClipCandidateCardProps['candidate']['renderedClips'],
  variant: RenderedClipVariant
) {
  return renderedClips.find((renderedClip) => renderedClip.variant === variant) || null;
}

export function ClipCandidateCard({
  contentPackId,
  projectId,
  sourceAssetType,
  candidate,
}: ClipCandidateCardProps) {
  const router = useRouter();
  const { toast } = useToast();
  const lastToastKeyRef = useRef<string | null>(null);
  const renderToastKeyRef = useRef<string | null>(null);
  const verticalToastKeyRef = useRef<string | null>(null);
  const [state, formAction, isPending] = useActionState<
    ClipCandidateActionState,
    FormData
  >(updateClipCandidateReviewStatus, {});
  const [renderState, renderAction, isRenderPending] = useActionState<
    RenderClipActionState,
    FormData
  >(renderApprovedClip, {});
  const [formatVerticalState, formatVerticalAction, isFormatVerticalPending] =
    useActionState<FormatVerticalActionState, FormData>(
      formatRenderedClipShortForm,
      {}
    );
  const trimmedClip = getRenderedClipVariant(
    candidate.renderedClips,
    RenderedClipVariant.TRIMMED_ORIGINAL
  );
  const verticalClip = getRenderedClipVariant(
    candidate.renderedClips,
    RenderedClipVariant.VERTICAL_SHORT_FORM
  );
  const canRenderTrimmed =
    sourceAssetType === SourceAssetType.UPLOADED_FILE &&
    candidate.reviewStatus === 'approved';
  const canRenderVertical =
    canRenderTrimmed && trimmedClip?.status === 'ready';

  useEffect(() => {
    if (state.success) {
      const toastKey = `success:${state.success}`;

      if (lastToastKeyRef.current !== toastKey) {
        toast({
          title: 'Clip candidate updated',
          description: state.success,
          icon: successToastIcon,
        });
        lastToastKeyRef.current = toastKey;
      }

      router.refresh();
      return;
    }

    if (state.error) {
      const toastKey = `error:${state.error}`;

      if (lastToastKeyRef.current !== toastKey) {
        toast({
          title: 'Unable to update clip candidate',
          description: state.error,
          variant: 'destructive',
        });
        lastToastKeyRef.current = toastKey;
      }
    }
  }, [router, state.error, state.success, toast]);

  useEffect(() => {
    if (renderState.success) {
      const toastKey = `success:${renderState.success}`;

      if (renderToastKeyRef.current !== toastKey) {
        toast({
          title: 'Clip queued',
          description: renderState.success,
          icon: successToastIcon
        });
        renderToastKeyRef.current = toastKey;
      }

      window.dispatchEvent(new Event(TRANSCRIPT_TRACKING_REFRESH_EVENT));
      router.refresh();
      return;
    }

    if (renderState.error) {
      const toastKey = `error:${renderState.error}`;

      if (renderToastKeyRef.current !== toastKey) {
        toast({
          title: 'Unable to render clip',
          description: renderState.error,
          variant: 'destructive'
        });
        renderToastKeyRef.current = toastKey;
      }
    }
  }, [renderState.error, renderState.success, router, toast]);

  useEffect(() => {
    if (formatVerticalState.success) {
      const toastKey = `success:${formatVerticalState.success}`;

      if (verticalToastKeyRef.current !== toastKey) {
        toast({
          title: 'Vertical version queued',
          description: formatVerticalState.success,
          icon: successToastIcon
        });
        verticalToastKeyRef.current = toastKey;
      }

      window.dispatchEvent(new Event(TRANSCRIPT_TRACKING_REFRESH_EVENT));
      router.refresh();
      return;
    }

    if (formatVerticalState.error) {
      const toastKey = `error:${formatVerticalState.error}`;

      if (verticalToastKeyRef.current !== toastKey) {
        toast({
          title: 'Unable to make vertical version',
          description: formatVerticalState.error,
          variant: 'destructive'
        });
        verticalToastKeyRef.current = toastKey;
      }
    }
  }, [formatVerticalState.error, formatVerticalState.success, router, toast]);

  return (
    <div className="rounded-xl border border-border/70 bg-surface-1 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Rank #{candidate.rank}
          </p>
          <h3 className="mt-1 text-base font-medium text-foreground">
            {candidate.title}
          </h3>
          <p className="mt-1 text-sm text-foreground">{candidate.hook}</p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>
            {formatTimestamp(candidate.startTimeMs)} -{' '}
            {formatTimestamp(candidate.endTimeMs)}
          </p>
          <p className="mt-1">
            {Math.round(candidate.durationMs / 1000)}s • {candidate.confidence}% confidence
          </p>
          <p className="mt-1 capitalize">{formatReviewStatus(candidate.reviewStatus)}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Summary
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{candidate.summary}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Why It Works
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{candidate.whyItWorks}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Platform Fit
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{candidate.platformFit}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Caption Copy
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{candidate.captionCopy}</p>
        </div>
      </div>

      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Transcript Excerpt
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {candidate.transcriptExcerpt}
        </p>
      </div>

      <form action={formAction} className="mt-4 flex flex-wrap gap-2">
        <input type="hidden" name="contentPackId" value={contentPackId} />
        <input type="hidden" name="clipCandidateId" value={candidate.id} />

        <Button
          type="submit"
          variant="outline"
          size="sm"
          name="reviewStatus"
          value="approved"
          disabled={isPending}
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Approve
        </Button>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          name="reviewStatus"
          value="saved_for_later"
          disabled={isPending}
        >
          <BookmarkPlus className="h-4 w-4" />
          Keep for Later
        </Button>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          name="reviewStatus"
          value="discarded"
          disabled={isPending}
        >
          <X className="h-4 w-4" />
          Discard
        </Button>
      </form>

      <div className="mt-4 rounded-xl bg-background/60 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Rendered Clip
            </p>
            {trimmedClip ? (
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="capitalize">{trimmedClip.status}</span>
                {trimmedClip.fileSizeBytes
                  ? ` • ${formatSourceAssetFileSize(trimmedClip.fileSizeBytes)}`
                  : ''}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                No rendered clip yet.
              </p>
            )}
          </div>

          {canRenderTrimmed ? (
            <form action={renderAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="clipCandidateId" value={candidate.id} />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={isRenderPending}
              >
                {isRenderPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Queueing...
                  </>
                ) : (
                  <>
                    <Scissors className="h-4 w-4" />
                    {trimmedClip ? 'Render Again' : 'Render Clip'}
                  </>
                )}
              </Button>
            </form>
          ) : null}
        </div>

        {trimmedClip?.status === 'pending' || trimmedClip?.status === 'rendering' ? (
          <p className="mt-3 text-sm text-muted-foreground">
            This clip is queued for background rendering.
          </p>
        ) : null}

        {trimmedClip?.status === 'failed' && trimmedClip.failureReason ? (
          <p className="mt-3 text-sm text-red-600">{trimmedClip.failureReason}</p>
        ) : null}

        {trimmedClip?.status === 'ready' ? (
          <div className="mt-3 space-y-3">
            <video
              controls
              preload="metadata"
              className="w-full rounded-xl bg-black"
              src={`/api/rendered-clips/${trimmedClip.id}/download`}
            />
            <a
              href={`/api/rendered-clips/${trimmedClip.id}/download`}
              className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:text-secondary hover:underline"
            >
              Download clip
            </a>
          </div>
        ) : null}
      </div>

      <div className="mt-4 rounded-xl bg-background/60 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Short-Form Version
            </p>
            {verticalClip ? (
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="capitalize">{verticalClip.status}</span>
                {verticalClip.fileSizeBytes
                  ? ` • ${formatSourceAssetFileSize(verticalClip.fileSizeBytes)}`
                  : ''}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                No vertical short-form version yet.
              </p>
            )}
          </div>

          {canRenderVertical ? (
            <form action={formatVerticalAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="clipCandidateId" value={candidate.id} />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={isFormatVerticalPending}
              >
                {isFormatVerticalPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Queueing...
                  </>
                ) : (
                  <>
                    <Scissors className="h-4 w-4" />
                    {verticalClip ? 'Make Vertical Again' : 'Make Vertical'}
                  </>
                )}
              </Button>
            </form>
          ) : null}
        </div>

        {!trimmedClip || trimmedClip.status !== 'ready' ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Render the trimmed clip first to unlock the vertical short-form version.
          </p>
        ) : null}

        {verticalClip?.status === 'pending' || verticalClip?.status === 'rendering' ? (
          <p className="mt-3 text-sm text-muted-foreground">
            The vertical short-form version is queued for background rendering.
          </p>
        ) : null}

        {verticalClip?.status === 'failed' && verticalClip.failureReason ? (
          <p className="mt-3 text-sm text-red-600">{verticalClip.failureReason}</p>
        ) : null}

        {verticalClip?.status === 'ready' ? (
          <div className="mt-3 space-y-3">
            <video
              controls
              preload="metadata"
              className="mx-auto aspect-[9/16] max-h-[32rem] rounded-xl bg-black"
              src={`/api/rendered-clips/${verticalClip.id}/download`}
            />
            <a
              href={`/api/rendered-clips/${verticalClip.id}/download`}
              className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:text-secondary hover:underline"
            >
              Download vertical clip
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
