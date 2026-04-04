'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { BookmarkPlus, Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { successToastIcon } from '@/components/ui/toaster';
import { useToast } from '@/hooks/use-toast';
import { updateClipCandidateReviewStatus } from '@/lib/disburse/actions';

type ClipCandidateActionState = {
  error?: string;
  success?: string;
};

type ClipCandidateCardProps = {
  contentPackId: number;
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

export function ClipCandidateCard({
  contentPackId,
  candidate,
}: ClipCandidateCardProps) {
  const router = useRouter();
  const { toast } = useToast();
  const lastToastKeyRef = useRef<string | null>(null);
  const [state, formAction, isPending] = useActionState<
    ClipCandidateActionState,
    FormData
  >(updateClipCandidateReviewStatus, {});

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
    </div>
  );
}
