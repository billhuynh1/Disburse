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
  transcriptItems?: TranscriptStatusItem[];
  renderedClipItems?: RenderedClipStatusItem[];
  shortFormPackItems?: ShortFormPackStatusItem[];
  facecamDetectionItems?: FacecamDetectionStatusItem[];
};

type RenderedClipStatusItem = {
  renderedClipId: number;
  clipCandidateId: number;
  sourceAssetId: number;
  sourceAssetTitle: string;
  clipTitle: string;
  variant: string;
  renderedClipStatus: string;
  failureReason: string | null;
  updatedAt: string;
};

type ShortFormPackStatusItem = {
  contentPackId: number;
  sourceAssetId: number;
  sourceAssetTitle: string;
  contentPackName: string;
  contentPackStatus: string;
  failureReason: string | null;
  updatedAt: string;
};

type FacecamDetectionStatusItem = {
  clipCandidateId: number;
  sourceAssetId: number;
  sourceAssetTitle: string;
  clipTitle: string;
  facecamDetectionStatus: string;
  failureReason: string | null;
  updatedAt: string;
};

const ACTIVE_SOURCE_ASSET_STATUSES = new Set(['uploaded', 'processing']);
const ACTIVE_TRANSCRIPT_STATUSES = new Set(['pending', 'processing']);
const ACTIVE_RENDERED_CLIP_STATUSES = new Set(['pending', 'rendering']);
const ACTIVE_SHORT_FORM_PACK_STATUSES = new Set(['pending', 'generating']);
const ACTIVE_FACECAM_DETECTION_STATUSES = new Set(['pending', 'detecting']);
const TRANSCRIPT_TRACKING_REFRESH_EVENT = 'transcript-tracking:refresh';
const TRACKED_STATUSES = new Set(['pending', 'processing', 'ready', 'failed']);
const TRACKED_RENDERED_CLIP_STATUSES = new Set([
  'pending',
  'rendering',
  'ready',
  'failed',
]);
const TRACKED_SHORT_FORM_PACK_STATUSES = new Set([
  'pending',
  'generating',
  'ready',
  'failed',
]);
const TRACKED_FACECAM_DETECTION_STATUSES = new Set([
  'pending',
  'detecting',
  'ready',
  'not_found',
  'failed',
]);

const fetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Failed to fetch transcript statuses.');
  }

  const data = (await response.json()) as TranscriptStatusesResponse;

  return {
    transcriptItems: data.transcriptItems || [],
    renderedClipItems: data.renderedClipItems || [],
    shortFormPackItems: data.shortFormPackItems || [],
    facecamDetectionItems: data.facecamDetectionItems || [],
  } satisfies {
    transcriptItems: TranscriptStatusItem[];
    renderedClipItems: RenderedClipStatusItem[];
    shortFormPackItems: ShortFormPackStatusItem[];
    facecamDetectionItems: FacecamDetectionStatusItem[];
  };
};

function hasActiveTranscriptWork(items: TranscriptStatusItem[]) {
  return items.some(
    (item) =>
      ACTIVE_SOURCE_ASSET_STATUSES.has(item.sourceAssetStatus) ||
      ACTIVE_TRANSCRIPT_STATUSES.has(item.transcriptStatus)
  );
}

function hasActiveRenderedClipWork(items: RenderedClipStatusItem[]) {
  return items.some((item) =>
    ACTIVE_RENDERED_CLIP_STATUSES.has(item.renderedClipStatus)
  );
}

function hasActiveShortFormPackWork(items: ShortFormPackStatusItem[]) {
  return items.some((item) =>
    ACTIVE_SHORT_FORM_PACK_STATUSES.has(item.contentPackStatus)
  );
}

function hasActiveFacecamDetectionWork(items: FacecamDetectionStatusItem[]) {
  return items.some((item) =>
    ACTIVE_FACECAM_DETECTION_STATUSES.has(item.facecamDetectionStatus)
  );
}

function isToastableTransition(previousStatus: string, currentStatus: string) {
  return (
    (
      previousStatus === 'pending' ||
      previousStatus === 'processing' ||
      previousStatus === 'rendering' ||
      previousStatus === 'detecting'
    ) &&
    (currentStatus === 'ready' ||
      currentStatus === 'not_found' ||
      currentStatus === 'failed')
  );
}

function getRenderedClipVariantLabel(variant: string) {
  return variant === 'vertical_short_form' ? 'Vertical clip' : 'Clip';
}

export function TranscriptToastWatcher() {
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();
  const hasSeededStatusesRef = useRef(false);
  const lastSeenStatusesRef = useRef<Map<number, string>>(new Map());
  const hasSeededRenderedClipStatusesRef = useRef(false);
  const lastSeenRenderedClipStatusesRef = useRef<Map<number, string>>(new Map());
  const hasSeededShortFormPackStatusesRef = useRef(false);
  const lastSeenShortFormPackStatusesRef = useRef<Map<number, string>>(new Map());
  const hasSeededFacecamDetectionStatusesRef = useRef(false);
  const lastSeenFacecamDetectionStatusesRef = useRef<Map<number, string>>(
    new Map()
  );
  const hasTriggeredRefreshRef = useRef(false);
  const { data, mutate } = useSWR<TranscriptStatusesResponse>(
    '/api/transcripts/statuses',
    fetcher,
    {
      refreshInterval: (latestData) =>
        latestData &&
        (hasActiveTranscriptWork(latestData.transcriptItems || []) ||
          hasActiveRenderedClipWork(latestData.renderedClipItems || []) ||
          hasActiveShortFormPackWork(latestData.shortFormPackItems || []) ||
          hasActiveFacecamDetectionWork(latestData.facecamDetectionItems || []))
          ? 4000
          : 0,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    }
  );

  const currentItems = data?.transcriptItems || [];
  const currentRenderedClipItems = data?.renderedClipItems || [];
  const currentShortFormPackItems = data?.shortFormPackItems || [];
  const currentFacecamDetectionItems = data?.facecamDetectionItems || [];
  const latestStatusMap = useMemo(
    () =>
      new Map(
        currentItems
          .filter((item) => TRACKED_STATUSES.has(item.transcriptStatus))
          .map((item) => [item.sourceAssetId, item.transcriptStatus])
      ),
    [currentItems]
  );
  const latestRenderedClipStatusMap = useMemo(
    () =>
      new Map(
        currentRenderedClipItems
          .filter((item) =>
            TRACKED_RENDERED_CLIP_STATUSES.has(item.renderedClipStatus)
          )
          .map((item) => [item.renderedClipId, item.renderedClipStatus])
      ),
    [currentRenderedClipItems]
  );
  const latestShortFormPackStatusMap = useMemo(
    () =>
      new Map(
        currentShortFormPackItems
          .filter((item) =>
            TRACKED_SHORT_FORM_PACK_STATUSES.has(item.contentPackStatus)
          )
          .map((item) => [item.contentPackId, item.contentPackStatus])
      ),
    [currentShortFormPackItems]
  );
  const latestFacecamDetectionStatusMap = useMemo(
    () =>
      new Map(
        currentFacecamDetectionItems
          .filter((item) =>
            TRACKED_FACECAM_DETECTION_STATUSES.has(
              item.facecamDetectionStatus
            )
          )
          .map((item) => [
            item.clipCandidateId,
            item.facecamDetectionStatus,
          ])
      ),
    [currentFacecamDetectionItems]
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

  useEffect(() => {
    if (currentRenderedClipItems.length === 0) {
      lastSeenRenderedClipStatusesRef.current = new Map();
      hasSeededRenderedClipStatusesRef.current = true;
      return;
    }

    if (!hasSeededRenderedClipStatusesRef.current) {
      lastSeenRenderedClipStatusesRef.current = latestRenderedClipStatusMap;
      hasSeededRenderedClipStatusesRef.current = true;
      return;
    }

    let shouldRefresh = false;

    currentRenderedClipItems.forEach((item) => {
      const previousStatus = lastSeenRenderedClipStatusesRef.current.get(
        item.renderedClipId
      );

      if (
        !previousStatus ||
        previousStatus === item.renderedClipStatus ||
        !isToastableTransition(previousStatus, item.renderedClipStatus)
      ) {
        return;
      }

      if (item.renderedClipStatus === 'ready') {
        toast({
          title: `${getRenderedClipVariantLabel(item.variant)} ready`,
          description: `${item.clipTitle} is rendered and ready to preview.`,
          icon: successToastIcon
        });
        shouldRefresh = true;
        return;
      }

      toast({
        title: `${getRenderedClipVariantLabel(item.variant)} failed`,
        description:
          item.failureReason ||
          `${item.sourceAssetTitle} could not be rendered into a clip.`,
        variant: 'destructive'
      });
      shouldRefresh = true;
    });

    lastSeenRenderedClipStatusesRef.current = latestRenderedClipStatusMap;

    if (shouldRefresh && !hasTriggeredRefreshRef.current) {
      hasTriggeredRefreshRef.current = true;
      router.refresh();
      window.setTimeout(() => {
        hasTriggeredRefreshRef.current = false;
      }, 1000);
    }
  }, [currentRenderedClipItems, latestRenderedClipStatusMap, router, toast]);

  useEffect(() => {
    if (currentShortFormPackItems.length === 0) {
      lastSeenShortFormPackStatusesRef.current = new Map();
      hasSeededShortFormPackStatusesRef.current = true;
      return;
    }

    if (!hasSeededShortFormPackStatusesRef.current) {
      lastSeenShortFormPackStatusesRef.current = latestShortFormPackStatusMap;
      hasSeededShortFormPackStatusesRef.current = true;
      return;
    }

    let shouldRefresh = false;

    currentShortFormPackItems.forEach((item) => {
      const previousStatus = lastSeenShortFormPackStatusesRef.current.get(
        item.contentPackId
      );

      if (
        !previousStatus ||
        previousStatus === item.contentPackStatus ||
        !isToastableTransition(previousStatus, item.contentPackStatus)
      ) {
        return;
      }

      if (item.contentPackStatus === 'ready') {
        toast({
          title: 'Clip candidates ready',
          description: `${item.sourceAssetTitle} now has clip candidates ready to review.`,
          icon: successToastIcon,
        });
        shouldRefresh = true;
        return;
      }

      toast({
        title: 'Clip generation failed',
        description:
          item.failureReason ||
          `${item.contentPackName} could not generate clip candidates.`,
        variant: 'destructive',
      });
      shouldRefresh = true;
    });

    lastSeenShortFormPackStatusesRef.current = latestShortFormPackStatusMap;

    if (shouldRefresh && !hasTriggeredRefreshRef.current) {
      hasTriggeredRefreshRef.current = true;
      router.refresh();
      window.setTimeout(() => {
        hasTriggeredRefreshRef.current = false;
      }, 1000);
    }
  }, [
    currentShortFormPackItems,
    latestShortFormPackStatusMap,
    router,
    toast,
  ]);

  useEffect(() => {
    if (currentFacecamDetectionItems.length === 0) {
      lastSeenFacecamDetectionStatusesRef.current = new Map();
      hasSeededFacecamDetectionStatusesRef.current = true;
      return;
    }

    if (!hasSeededFacecamDetectionStatusesRef.current) {
      lastSeenFacecamDetectionStatusesRef.current =
        latestFacecamDetectionStatusMap;
      hasSeededFacecamDetectionStatusesRef.current = true;
      return;
    }

    let shouldRefresh = false;

    currentFacecamDetectionItems.forEach((item) => {
      const previousStatus = lastSeenFacecamDetectionStatusesRef.current.get(
        item.clipCandidateId
      );

      if (
        !previousStatus ||
        previousStatus === item.facecamDetectionStatus ||
        !isToastableTransition(previousStatus, item.facecamDetectionStatus)
      ) {
        return;
      }

      if (item.facecamDetectionStatus === 'ready') {
        toast({
          title: 'Facecam detected',
          description: `${item.clipTitle} has a suggested facecam crop.`,
          icon: successToastIcon,
        });
        shouldRefresh = true;
        return;
      }

      if (item.facecamDetectionStatus === 'not_found') {
        toast({
          title: 'No facecam detected',
          description: `${item.clipTitle} did not have a stable facecam region.`,
        });
        shouldRefresh = true;
        return;
      }

      toast({
        title: 'Facecam detection failed',
        description:
          item.failureReason ||
          `${item.sourceAssetTitle} could not be analyzed for a facecam.`,
        variant: 'destructive',
      });
      shouldRefresh = true;
    });

    lastSeenFacecamDetectionStatusesRef.current =
      latestFacecamDetectionStatusMap;

    if (shouldRefresh && !hasTriggeredRefreshRef.current) {
      hasTriggeredRefreshRef.current = true;
      router.refresh();
      window.setTimeout(() => {
        hasTriggeredRefreshRef.current = false;
      }, 1000);
    }
  }, [
    currentFacecamDetectionItems,
    latestFacecamDetectionStatusMap,
    router,
    toast,
  ]);

  return null;
}

export { TRANSCRIPT_TRACKING_REFRESH_EVENT };
