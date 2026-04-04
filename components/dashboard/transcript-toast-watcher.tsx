'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { useToast } from '@/hooks/use-toast';
import { successToastIcon } from '@/components/ui/toaster';

type TranscriptStatusItem = {
  sourceAssetId: number;
  sourceAssetTitle: string;
  sourceAssetStatus: string;
  transcriptId: number | null;
  transcriptStatus: string;
  failureReason: string | null;
  updatedAt: string;
};

type TranscriptStatusesResponse = {
  items: TranscriptStatusItem[];
};

const ACTIVE_SOURCE_ASSET_STATUSES = new Set(['uploaded', 'processing']);
const ACTIVE_TRANSCRIPT_STATUSES = new Set(['pending', 'processing']);
const TRANSCRIPT_TRACKING_REFRESH_EVENT = 'transcript-tracking:refresh';
const TRACKED_STATUSES = new Set(['pending', 'processing', 'ready', 'failed']);

const fetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Failed to fetch transcript statuses.');
  }

  return (await response.json()) as TranscriptStatusesResponse;
};

function hasActiveTranscriptWork(items: TranscriptStatusItem[]) {
  return items.some(
    (item) =>
      ACTIVE_SOURCE_ASSET_STATUSES.has(item.sourceAssetStatus) ||
      ACTIVE_TRANSCRIPT_STATUSES.has(item.transcriptStatus)
  );
}

function isToastableTransition(previousStatus: string, currentStatus: string) {
  return (
    (previousStatus === 'pending' || previousStatus === 'processing') &&
    (currentStatus === 'ready' || currentStatus === 'failed')
  );
}

export function TranscriptToastWatcher() {
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();
  const hasSeededStatusesRef = useRef(false);
  const lastSeenStatusesRef = useRef<Map<number, string>>(new Map());
  const hasTriggeredRefreshRef = useRef(false);
  const { data, mutate } = useSWR<TranscriptStatusesResponse>(
    '/api/transcripts/statuses',
    fetcher,
    {
      refreshInterval: (latestData) =>
        latestData?.items && hasActiveTranscriptWork(latestData.items) ? 4000 : 0,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    }
  );

  const currentItems = data?.items || [];
  const latestStatusMap = useMemo(
    () =>
      new Map(
        currentItems
          .filter((item) => TRACKED_STATUSES.has(item.transcriptStatus))
          .map((item) => [item.sourceAssetId, item.transcriptStatus])
      ),
    [currentItems]
  );

  const revalidateStatuses = useCallback(() => {
    void mutate();
  }, [mutate]);

  useEffect(() => {
    revalidateStatuses();
  }, [pathname, revalidateStatuses]);

  useEffect(() => {
    const handleTrackingRefresh = () => {
      revalidateStatuses();
    };

    window.addEventListener(
      TRANSCRIPT_TRACKING_REFRESH_EVENT,
      handleTrackingRefresh
    );

    return () => {
      window.removeEventListener(
        TRANSCRIPT_TRACKING_REFRESH_EVENT,
        handleTrackingRefresh
      );
    };
  }, [revalidateStatuses]);

  useEffect(() => {
    if (currentItems.length === 0) {
      lastSeenStatusesRef.current = new Map();
      hasSeededStatusesRef.current = true;
      hasTriggeredRefreshRef.current = false;
      return;
    }

    if (!hasSeededStatusesRef.current) {
      lastSeenStatusesRef.current = latestStatusMap;
      hasSeededStatusesRef.current = true;
      return;
    }

    let shouldRefresh = false;

    currentItems.forEach((item) => {
      const previousStatus = lastSeenStatusesRef.current.get(item.sourceAssetId);

      if (
        !previousStatus ||
        previousStatus === item.transcriptStatus ||
        !isToastableTransition(previousStatus, item.transcriptStatus)
      ) {
        return;
      }

      if (item.transcriptStatus === 'ready') {
        toast({
          title: 'Transcript ready',
          description: `${item.sourceAssetTitle} is ready for downstream workflows.`,
          icon: successToastIcon,
        });
        shouldRefresh = true;
        return;
      }

      toast({
        title: 'Transcript failed',
        description:
          item.failureReason ||
          `${item.sourceAssetTitle} could not be transcribed.`,
        variant: 'destructive',
      });
      shouldRefresh = true;
    });

    lastSeenStatusesRef.current = latestStatusMap;

    if (shouldRefresh && !hasTriggeredRefreshRef.current) {
      hasTriggeredRefreshRef.current = true;
      router.refresh();
      window.setTimeout(() => {
        hasTriggeredRefreshRef.current = false;
      }, 1000);
    }
  }, [currentItems, latestStatusMap, router, toast]);

  return null;
}

export { TRANSCRIPT_TRACKING_REFRESH_EVENT };
