'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Clock3,
  Loader2,
  Play,
  Scissors,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { successToastIcon } from '@/components/ui/toaster';
import { useToast } from '@/hooks/use-toast';
import { updateClipCandidateReviewStatus } from '@/lib/disburse/actions';
import { cn } from '@/lib/utils';

type ClipCandidateActionState = {
  error?: string;
  success?: string;
};

export type ClipCandidateCardCandidate = {
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
  facecamDetectionStatus: string;
  facecamDetectionFailureReason: string | null;
  facecamDetectedAt: Date | string | null;
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

type ClipCandidateCardProps = {
  contentPackId: number;
  projectId: number;
  sourceAssetType: string;
  candidate: ClipCandidateCardCandidate;
  selected?: boolean;
  onPreview?: (candidateId: number) => void;
};

export function formatClipTimestamp(totalMs: number) {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds]
      .map((value) => String(value).padStart(2, '0'))
      .join(':');
  }

  return [minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function formatReviewStatus(status: string) {
  return status.replaceAll('_', ' ');
}

function getStatusClasses(status: string) {
  if (status === 'approved') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }

  if (status === 'discarded') {
    return 'border-rose-200 bg-rose-50 text-rose-700';
  }

  if (status === 'saved_for_later') {
    return 'border-amber-200 bg-amber-50 text-amber-700';
  }

  return 'border-slate-200 bg-slate-50 text-slate-600';
}

export function ClipCandidateCard({
  contentPackId,
  candidate,
  selected = false,
  onPreview
}: ClipCandidateCardProps) {
  const router = useRouter();
  const { toast } = useToast();
  const lastToastKeyRef = useRef<string | null>(null);
  const [state, formAction, isPending] = useActionState<
    ClipCandidateActionState,
    FormData
  >(updateClipCandidateReviewStatus, {});
  const hasReadyRender = candidate.renderedClips.some(
    (clip) => clip.status === 'ready'
  );

  useEffect(() => {
    if (state.success) {
      const toastKey = `success:${state.success}`;

      if (lastToastKeyRef.current !== toastKey) {
        toast({
          title: 'Clip candidate updated',
          description: state.success,
          icon: successToastIcon
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
          variant: 'destructive'
        });
        lastToastKeyRef.current = toastKey;
      }
    }
  }, [router, state.error, state.success, toast]);

  return (
    <article
      className={cn(
        'group overflow-hidden rounded-2xl border bg-white text-slate-950 shadow-sm transition-all',
        selected
          ? 'border-cyan-500 shadow-[0_18px_40px_rgba(8,145,178,0.18)] ring-2 ring-cyan-100'
          : 'border-slate-200 hover:border-cyan-300 hover:shadow-md'
      )}
    >
      <button
        type="button"
        onClick={() => onPreview?.(candidate.id)}
        className="block w-full text-left"
      >
        <div className="relative aspect-video bg-[linear-gradient(135deg,#020617,#164e63_50%,#0891b2)]">
          <div className="absolute inset-3 rounded-xl border border-white/20 bg-black/20" />
          <div className="absolute left-3 top-3 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-900 shadow-sm">
            Clip {candidate.rank}
          </div>
          <div className="absolute right-3 top-3 rounded-full bg-black/45 px-2 py-1 text-xs font-medium text-white">
            {candidate.confidence}%
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-white text-cyan-700 shadow-lg">
              <Play className="h-5 w-5 fill-current" />
            </span>
          </div>
          <div className="absolute inset-x-3 bottom-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/25">
              <div
                className="h-full rounded-full bg-white"
                style={{
                  width: `${Math.max(8, Math.min(100, candidate.confidence))}%`
                }}
              />
            </div>
          </div>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <span
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium capitalize',
                getStatusClasses(candidate.reviewStatus)
              )}
            >
              {formatReviewStatus(candidate.reviewStatus)}
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <Clock3 className="h-3.5 w-3.5" />
              {formatClipTimestamp(candidate.startTimeMs)}-
              {formatClipTimestamp(candidate.endTimeMs)}
            </span>
          </div>

          <div>
            <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-slate-950">
              {candidate.title}
            </h3>
            <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-600">
              {candidate.hook}
            </p>
          </div>

          <p className="line-clamp-3 border-l-2 border-cyan-200 pl-3 text-xs leading-5 text-slate-500">
            {candidate.transcriptExcerpt}
          </p>
        </div>
      </button>

      <div className="border-t border-slate-100 bg-slate-50/80 p-3">
        <form action={formAction} className="grid grid-cols-3 gap-2">
          <input type="hidden" name="contentPackId" value={contentPackId} />
          <input type="hidden" name="clipCandidateId" value={candidate.id} />

          <Button
            type="button"
            variant={selected ? 'default' : 'outline'}
            size="sm"
            onClick={() => onPreview?.(candidate.id)}
            className={cn(
              'h-8 rounded-lg text-xs',
              selected
                ? 'bg-slate-950 text-white shadow-none hover:bg-slate-800'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-white'
            )}
          >
            <Play className="h-3.5 w-3.5" />
            Preview
          </Button>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            name="reviewStatus"
            value="approved"
            disabled={isPending}
            className="h-8 rounded-lg border-emerald-200 bg-white text-xs text-emerald-700 hover:bg-emerald-50"
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Approve
          </Button>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            name="reviewStatus"
            value="discarded"
            disabled={isPending}
            className="h-8 rounded-lg border-rose-200 bg-white text-xs text-rose-700 hover:bg-rose-50"
          >
            <X className="h-3.5 w-3.5" />
            Reject
          </Button>
        </form>

        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
          <span>{Math.round(candidate.durationMs / 1000)}s cut</span>
          <span className="inline-flex items-center gap-1">
            <Scissors className="h-3 w-3" />
            {hasReadyRender ? 'export ready' : 'not rendered'}
          </span>
        </div>
      </div>
    </article>
  );
}
