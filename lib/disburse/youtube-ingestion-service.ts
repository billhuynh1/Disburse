import 'server-only';

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  sourceAssets,
  SourceAssetType,
  TranscriptStatus,
} from '@/lib/db/schema';
import {
  assertTranscriptReadyState,
  markTranscriptProcessing,
  upsertTranscriptReady,
} from '@/lib/disburse/transcript-service';
import type { TimestampedTranscriptSegment } from '@/lib/disburse/openai-transcription';

type YoutubePlayerResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl: string;
        languageCode?: string;
        name?: {
          simpleText?: string;
          runs?: Array<{ text?: string }>;
        };
        kind?: string;
      }>;
    };
  };
  videoDetails?: {
    title?: string;
  };
};

type YoutubeTranscriptJson3 = {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    segs?: Array<{
      utf8?: string;
    }>;
  }>;
};

function parseYouTubeUrl(url: string) {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The stored YouTube URL is invalid.');
  }

  if (
    parsed.hostname === 'youtu.be' &&
    parsed.pathname.replace(/\//g, '').trim()
  ) {
    return parsed.pathname.replace(/\//g, '').trim();
  }

  if (
    parsed.hostname === 'www.youtube.com' ||
    parsed.hostname === 'youtube.com' ||
    parsed.hostname === 'm.youtube.com'
  ) {
    const watchId = parsed.searchParams.get('v')?.trim();

    if (watchId) {
      return watchId;
    }

    const pathParts = parsed.pathname.split('/').filter(Boolean);

    if (pathParts[0] === 'shorts' && pathParts[1]) {
      return pathParts[1];
    }
  }

  throw new Error('The YouTube URL format is not supported.');
}

async function fetchYouTubeWatchPage(videoId: string) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`YouTube page request failed with status ${response.status}.`);
  }

  return await response.text();
}

function extractPlayerResponse(html: string): YoutubePlayerResponse {
  const patterns = [
    /ytInitialPlayerResponse\s*=\s*(\{.+?\});/s,
    /"ytInitialPlayerResponse"\s*:\s*(\{.+?\})\s*,\s*"/s,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (!match?.[1]) {
      continue;
    }

    try {
      return JSON.parse(match[1]) as YoutubePlayerResponse;
    } catch {
      continue;
    }
  }

  throw new Error('Unable to read YouTube video metadata.');
}

function readTrackName(
  track: NonNullable<
    NonNullable<
      NonNullable<YoutubePlayerResponse['captions']>['playerCaptionsTracklistRenderer']
    >['captionTracks']
  >[number]
) {
  if (track.name?.simpleText?.trim()) {
    return track.name.simpleText.trim();
  }

  return track.name?.runs?.map((run) => run.text || '').join('').trim() || '';
}

function chooseCaptionTrack(
  tracks: NonNullable<
    NonNullable<
      NonNullable<YoutubePlayerResponse['captions']>['playerCaptionsTracklistRenderer']
    >['captionTracks']
  >
) {
  const rankedTracks = [...tracks].sort((left, right) => {
    const leftEnglish = left.languageCode?.startsWith('en') ? 2 : 0;
    const rightEnglish = right.languageCode?.startsWith('en') ? 2 : 0;
    const leftManual = left.kind === 'asr' ? 0 : 1;
    const rightManual = right.kind === 'asr' ? 0 : 1;

    return rightEnglish + rightManual - (leftEnglish + leftManual);
  });

  return rankedTracks[0] || null;
}

async function fetchCaptionTrack(trackUrl: string) {
  const transcriptUrl = new URL(trackUrl);
  transcriptUrl.searchParams.set('fmt', 'json3');

  const response = await fetch(transcriptUrl.toString(), {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(
      `YouTube transcript request failed with status ${response.status}.`
    );
  }

  const body = (await response.json().catch(() => null)) as YoutubeTranscriptJson3 | null;

  if (!body) {
    throw new Error('YouTube transcript response was empty.');
  }

  return body;
}

function normalizeTranscriptSegments(
  transcript: YoutubeTranscriptJson3
): TimestampedTranscriptSegment[] {
  return (transcript.events || [])
    .map((event, index) => {
      const text = (event.segs || [])
        .map((segment) => segment.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      const startTimeMs = event.tStartMs ?? 0;
      const durationMs = event.dDurationMs ?? 0;
      const endTimeMs = startTimeMs + durationMs;

      return {
        sequence: index,
        startTimeMs,
        endTimeMs,
        text,
      };
    })
    .filter((segment) => segment.text.length > 0 && segment.endTimeMs > segment.startTimeMs);
}

export async function ingestYoutubeSourceAsset(sourceAssetId: number) {
  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: eq(sourceAssets.id, sourceAssetId),
    with: {
      transcript: {
        with: {
          segments: true,
        },
      },
    },
  });

  if (!sourceAsset) {
    throw new Error('Source asset not found.');
  }

  if (sourceAsset.assetType !== SourceAssetType.YOUTUBE_URL) {
    throw new Error('Only YouTube URL source assets can be ingested this way.');
  }

  if (
    sourceAsset.transcript?.status === TranscriptStatus.READY &&
    sourceAsset.transcript.content &&
    sourceAsset.transcript.segments.length > 0
  ) {
    return await assertTranscriptReadyState(sourceAsset.id);
  }

  await markTranscriptProcessing(sourceAsset.id, sourceAsset.userId);

  const videoId = parseYouTubeUrl(sourceAsset.storageUrl);
  const watchPage = await fetchYouTubeWatchPage(videoId);
  const playerResponse = extractPlayerResponse(watchPage);
  const captionTracks =
    playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  if (captionTracks.length === 0) {
    throw new Error('This YouTube video does not expose a transcript track.');
  }

  const selectedTrack = chooseCaptionTrack(captionTracks);

  if (!selectedTrack) {
    throw new Error('No usable YouTube transcript track was found.');
  }

  const transcriptBody = await fetchCaptionTrack(selectedTrack.baseUrl);
  const segments = normalizeTranscriptSegments(transcriptBody);

  if (segments.length === 0) {
    throw new Error('The YouTube transcript did not contain usable timestamped text.');
  }

  const content = segments.map((segment) => segment.text).join(' ');
  await upsertTranscriptReady({
    sourceAssetId: sourceAsset.id,
    userId: sourceAsset.userId,
    content,
    language: selectedTrack.languageCode?.trim() || null,
    segments,
  });

  const videoTitle = playerResponse.videoDetails?.title?.trim();

  if (videoTitle && sourceAsset.title.trim() === sourceAsset.storageUrl.trim()) {
    await db
      .update(sourceAssets)
      .set({
        title: videoTitle,
        updatedAt: new Date(),
      })
      .where(eq(sourceAssets.id, sourceAsset.id));
  }

  return await assertTranscriptReadyState(sourceAsset.id);
}
