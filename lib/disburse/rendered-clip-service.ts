import 'server-only';

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidates,
  ClipCandidateReviewStatus,
  ContentPackKind,
  MediaRetentionStatus,
  RenderedClipLayout,
  renderedClips,
  RenderedClipStatus,
  RenderedClipVariant,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  type ReusableAsset,
} from '@/lib/db/schema';
import {
  buildStorageUrl,
  createPresignedDownload,
  createRenderedClipStorageKey,
  uploadStorageObject,
} from '@/lib/disburse/s3-storage';
import {
  assertMediaAvailable,
  autoSaveApprovedClipMedia,
  getTemporaryMediaExpiresAt,
} from '@/lib/disburse/media-retention-service';
import {
  createRenderedClipFailedNotification,
  createRenderedClipReadyNotification,
} from '@/lib/disburse/notification-service';
import { buildRenderedClipAssCaptions } from '@/lib/disburse/rendered-clip-captions';
import { getReusableFontAssetForUser } from '@/lib/disburse/reusable-asset-service';

const execFileAsync = promisify(execFile);
const RENDERED_CLIP_MIME_TYPE = 'video/mp4';
const FFMPEG_BINARY = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';

function normalizeFailureReason(reason: string) {
  const normalized = reason.trim();
  return normalized.length > 0
    ? normalized.slice(0, 5000)
    : 'Clip rendering failed.';
}

function formatSeconds(totalMs: number) {
  return (Math.max(totalMs, 0) / 1000).toFixed(3);
}

async function downloadStorageFile(storageKey: string) {
  const download = createPresignedDownload({ storageKey });
  const response = await fetch(download.downloadUrl, {
    method: download.method,
  });

  if (!response.ok) {
    throw new Error(`Storage download failed with status ${response.status}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function createSafeFontFilename(asset: ReusableAsset) {
  const extension = path.extname(asset.originalFilename) || '.ttf';
  const baseName =
    asset.title
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || `caption-font-${asset.id}`;

  return `${baseName}${extension}`;
}

async function prepareCaptionFont(params: {
  captionFontAssetId?: number;
  userId: number;
  fontsDir: string;
}) {
  const asset = await getReusableFontAssetForUser(
    params.captionFontAssetId,
    params.userId
  );

  if (!asset) {
    return null;
  }

  await fs.mkdir(params.fontsDir, { recursive: true });

  const fontBuffer = await downloadStorageFile(asset.storageKey);
  const fontPath = path.join(params.fontsDir, createSafeFontFilename(asset));
  await fs.writeFile(fontPath, fontBuffer);

  return {
    fontFamily: asset.title,
    fontsDir: params.fontsDir,
  };
}

async function runClipRender(params: {
  inputPath: string;
  outputPath: string;
  startTimeMs: number;
  durationMs: number;
  subtitlePath?: string | null;
  fontsDir?: string | null;
}) {
  const videoFilter = params.subtitlePath
    ? ['-vf', buildSubtitleFilter(params.subtitlePath, params.fontsDir)]
    : [];

  try {
    await execFileAsync(FFMPEG_BINARY, [
      '-y',
      '-ss',
      formatSeconds(params.startTimeMs),
      '-i',
      params.inputPath,
      '-t',
      formatSeconds(params.durationMs),
      '-map',
      '0:v:0?',
      '-map',
      '0:a:0?',
      ...videoFilter,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      params.outputPath,
    ]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'ffmpeg failed unexpectedly.';
    throw new Error(`ffmpeg render failed: ${message}`);
  }
}

async function runVerticalShortFormRender(params: {
  inputPath: string;
  outputPath: string;
  startTimeMs?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  layout?: RenderedClipLayout;
  subtitlePath?: string | null;
  fontsDir?: string | null;
  facecamDetection?: {
    frameWidth?: number;
    frameHeight?: number;
    xPx: number;
    yPx: number;
    widthPx: number;
    heightPx: number;
  } | null;
}) {
  const width = params.width ?? 1080;
  const height = params.height ?? 1920;
  const layout = params.layout ?? RenderedClipLayout.DEFAULT;
  const inputArgs =
    typeof params.startTimeMs === 'number'
      ? ['-ss', formatSeconds(params.startTimeMs), '-i', params.inputPath]
      : ['-i', params.inputPath];
  const durationArgs =
    typeof params.durationMs === 'number'
      ? ['-t', formatSeconds(params.durationMs)]
      : [];
  const videoFilter =
    layout === RenderedClipLayout.DEFAULT
      ? [
          `scale=${width}:${height}:force_original_aspect_ratio=increase`,
          `crop=${width}:${height}`,
          params.subtitlePath
            ? buildSubtitleFilter(params.subtitlePath, params.fontsDir)
            : null,
        ]
          .filter(Boolean)
          .join(',')
      : buildFacecamSplitFilter({
          width,
          height,
          layout,
          subtitlePath: params.subtitlePath,
          fontsDir: params.fontsDir,
          facecamDetection: params.facecamDetection,
        });
  const filterArgs =
    layout === RenderedClipLayout.DEFAULT
      ? ['-vf', videoFilter]
      : ['-filter_complex', videoFilter, '-map', '[vout]', '-map', '0:a:0?'];

  try {
    await execFileAsync(FFMPEG_BINARY, [
      '-y',
      ...inputArgs,
      ...durationArgs,
      ...filterArgs,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      params.outputPath,
    ]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'ffmpeg failed unexpectedly.';
    throw new Error(`ffmpeg vertical render failed: ${message}`);
  }
}

function buildFacecamSplitFilter(params: {
  width: number;
  height: number;
  layout: RenderedClipLayout;
  subtitlePath?: string | null;
  fontsDir?: string | null;
  facecamDetection?: {
    frameWidth?: number;
    frameHeight?: number;
    xPx: number;
    yPx: number;
    widthPx: number;
    heightPx: number;
  } | null;
}) {
  if (!params.facecamDetection) {
    throw new Error('A ready facecam detection is required for split layouts.');
  }

  const facecamRatio =
    params.layout === RenderedClipLayout.FACECAM_TOP_50
      ? 0.5
      : params.layout === RenderedClipLayout.FACECAM_TOP_40
        ? 0.4
        : 0.3;
  const facecamHeight = Math.round(params.height * facecamRatio);
  const mainHeight = params.height - facecamHeight;
  const facecamCrop = getStoredFacecamCrop(params.facecamDetection);

  const filterParts = [
    `split=2[main][face]`,
    `[face]crop=${facecamCrop.width}:${facecamCrop.height}:${facecamCrop.x}:${facecamCrop.y},scale=${params.width}:${facecamHeight}[faceout]`,
    `[main]scale=${params.width}:${mainHeight}:force_original_aspect_ratio=increase,crop=${params.width}:${mainHeight}[mainout]`,
  ];

  if (params.subtitlePath) {
    filterParts.push(
      `[faceout][mainout]vstack=inputs=2[stacked]`,
      `[stacked]${buildSubtitleFilter(params.subtitlePath, params.fontsDir)}[vout]`
    );
  } else {
    filterParts.push(`[faceout][mainout]vstack=inputs=2[vout]`);
  }

  return filterParts.join(';');
}

function buildSubtitleFilter(subtitlePath: string, fontsDir?: string | null) {
  const parts = [`subtitles=${escapeFfmpegFilterValue(subtitlePath)}`];

  if (fontsDir) {
    parts.push(`fontsdir=${escapeFfmpegFilterValue(fontsDir)}`);
  }

  return parts.join(':');
}

function escapeFfmpegFilterValue(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

function getStoredFacecamCrop(detection: {
  frameWidth?: number;
  frameHeight?: number;
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}) {
  const frameWidth = detection.frameWidth || 1920;
  const frameHeight = detection.frameHeight || 1080;
  const cropWidth = Math.min(Math.round(detection.widthPx), frameWidth);
  const cropHeight = Math.min(Math.round(detection.heightPx), frameHeight);
  const x = Math.round(Math.max(0, Math.min(frameWidth - cropWidth, detection.xPx)));
  const y = Math.round(Math.max(0, Math.min(frameHeight - cropHeight, detection.yPx)));

  return {
    x,
    y,
    width: cropWidth,
    height: cropHeight,
  };
}

async function withTempRenderFiles<T>(
  sourceFilename: string,
  sourceFileBuffer: Buffer,
  callback: (paths: {
    inputPath: string;
    outputPath: string;
    subtitlePath: string;
    fontsDir: string;
  }) => Promise<T>
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disburse-render-'));
  const inputExtension = path.extname(sourceFilename) || '.bin';
  const inputPath = path.join(tempDir, `source${inputExtension}`);
  const outputPath = path.join(tempDir, 'clip.mp4');
  const subtitlePath = path.join(tempDir, 'captions.ass');
  const fontsDir = path.join(tempDir, 'fonts');

  try {
    await fs.writeFile(inputPath, sourceFileBuffer);
    return await callback({ inputPath, outputPath, subtitlePath, fontsDir });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function getClipCandidateForRender(clipCandidateId: number) {
  return await db.query.clipCandidates.findFirst({
    where: eq(clipCandidates.id, clipCandidateId),
    with: {
      contentPack: true,
      sourceAsset: {
        with: {
          project: true,
        },
      },
      renderedClips: true,
      facecamDetections: true,
      transcript: {
        with: {
          segments: true,
          words: true,
        },
      },
    },
  });
}

async function writeCaptionFile(params: {
  subtitlePath: string;
  clipStartTimeMs: number;
  clipDurationMs: number;
  transcriptSegments: {
    startTimeMs: number;
    endTimeMs: number;
    text: string;
  }[];
  transcriptWords?: {
    startTimeMs: number;
    endTimeMs: number;
    text: string;
  }[];
  fallbackText: string;
  fontFamily?: string | null;
}) {
  const captions = buildRenderedClipAssCaptions({
    clipStartTimeMs: params.clipStartTimeMs,
    clipDurationMs: params.clipDurationMs,
    transcriptSegments: params.transcriptSegments,
    transcriptWords: params.transcriptWords,
    fallbackText: params.fallbackText,
    fontFamily: params.fontFamily,
  });

  if (!captions) {
    return null;
  }

  await fs.writeFile(params.subtitlePath, captions, 'utf8');
  return params.subtitlePath;
}

export async function ensureRenderedClipPending(params: {
  clipCandidateId: number;
  userId: number;
  variant: RenderedClipVariant;
  layout?: RenderedClipLayout;
}) {
  const clipCandidate = await getClipCandidateForRender(params.clipCandidateId);
  const layout = params.layout ?? RenderedClipLayout.DEFAULT;

  if (!clipCandidate || clipCandidate.userId !== params.userId) {
    throw new Error('Clip candidate not found.');
  }

  if (clipCandidate.reviewStatus !== ClipCandidateReviewStatus.APPROVED) {
    throw new Error('Approve this clip candidate before rendering it.');
  }

  if (clipCandidate.contentPack.kind !== ContentPackKind.SHORT_FORM_CLIPS) {
    throw new Error('Only short-form clip candidates can be rendered.');
  }

  if (clipCandidate.sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE) {
    throw new Error('Rendered clips are only supported for uploaded videos right now.');
  }

  if (clipCandidate.sourceAsset.status !== SourceAssetStatus.READY) {
    throw new Error('This source asset is not ready for clip rendering yet.');
  }

  assertMediaAvailable(clipCandidate.sourceAsset, 'Source asset');

  if (
    clipCandidate.sourceAsset.mimeType &&
    !clipCandidate.sourceAsset.mimeType.startsWith('video/')
  ) {
    throw new Error('Only uploaded videos can be rendered into clips right now.');
  }

  const existingRenderedClip = clipCandidate.renderedClips.find(
    (renderedClip) =>
      renderedClip.variant === params.variant && renderedClip.layout === layout
  );

  if (layout !== RenderedClipLayout.DEFAULT && clipCandidate.facecamDetections.length === 0) {
    throw new Error('A ready facecam detection is required for split layouts.');
  }

  const storageKey = createRenderedClipStorageKey(
    clipCandidate.userId,
    clipCandidate.sourceAsset.projectId,
    clipCandidate.id,
    params.variant,
    layout
  );
  const projectIsSaved = clipCandidate.sourceAsset.project.isSaved;
  const expiresAt = projectIsSaved
    ? null
    : clipCandidate.sourceAsset.project.expiresAt ||
      clipCandidate.sourceAsset.expiresAt ||
      getTemporaryMediaExpiresAt();
  const retentionStatus = projectIsSaved
    ? MediaRetentionStatus.SAVED
    : MediaRetentionStatus.TEMPORARY;

  if (existingRenderedClip) {
    const [updatedRenderedClip] = await db
      .update(renderedClips)
      .set({
        status: RenderedClipStatus.PENDING,
        variant: params.variant,
        layout,
        title: clipCandidate.title,
        startTimeMs: clipCandidate.startTimeMs,
        endTimeMs: clipCandidate.endTimeMs,
        durationMs: clipCandidate.durationMs,
        storageKey,
        storageUrl: buildStorageUrl(storageKey),
        mimeType: RENDERED_CLIP_MIME_TYPE,
        retentionStatus,
        expiresAt,
        savedAt: projectIsSaved ? new Date() : null,
        deletedAt: null,
        storageDeletedAt: null,
        deletionReason: null,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(renderedClips.id, existingRenderedClip.id))
      .returning();

    return updatedRenderedClip;
  }

  const [renderedClip] = await db
    .insert(renderedClips)
    .values({
      userId: clipCandidate.userId,
      contentPackId: clipCandidate.contentPackId,
      sourceAssetId: clipCandidate.sourceAssetId,
      clipCandidateId: clipCandidate.id,
      variant: params.variant,
      layout,
      status: RenderedClipStatus.PENDING,
      title: clipCandidate.title,
      startTimeMs: clipCandidate.startTimeMs,
      endTimeMs: clipCandidate.endTimeMs,
      durationMs: clipCandidate.durationMs,
      storageKey,
      storageUrl: buildStorageUrl(storageKey),
      mimeType: RENDERED_CLIP_MIME_TYPE,
      retentionStatus,
      expiresAt,
      savedAt: projectIsSaved ? new Date() : null,
    })
    .returning();

  return renderedClip;
}

async function markRenderedClipRendering(renderedClipId: number) {
  await db
    .update(renderedClips)
    .set({
      status: RenderedClipStatus.RENDERING,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(renderedClips.id, renderedClipId));
}

export async function markRenderedClipFailed(
  clipCandidateId: number,
  userId: number,
  variant: RenderedClipVariant,
  reason: string,
  layout: RenderedClipLayout = RenderedClipLayout.DEFAULT
) {
  const failureReason = normalizeFailureReason(reason);
  const existingRenderedClip = await db.query.renderedClips.findFirst({
    where: and(
      eq(renderedClips.clipCandidateId, clipCandidateId),
      eq(renderedClips.userId, userId),
      eq(renderedClips.variant, variant),
      eq(renderedClips.layout, layout)
    ),
  });

  if (!existingRenderedClip) {
    return;
  }

  await db
    .update(renderedClips)
    .set({
      status: RenderedClipStatus.FAILED,
      failureReason,
      updatedAt: new Date(),
    })
    .where(eq(renderedClips.id, existingRenderedClip.id));

  await createRenderedClipFailedNotification(existingRenderedClip.id);
}

async function markRenderedClipReady(params: {
  renderedClipId: number;
  fileSizeBytes: number;
}) {
  const [renderedClip] = await db
    .update(renderedClips)
    .set({
      status: RenderedClipStatus.READY,
      mimeType: RENDERED_CLIP_MIME_TYPE,
      fileSizeBytes: params.fileSizeBytes,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(renderedClips.id, params.renderedClipId))
    .returning({
      clipCandidateId: renderedClips.clipCandidateId,
      userId: renderedClips.userId,
    });

  if (renderedClip) {
    await autoSaveApprovedClipMedia(renderedClip.clipCandidateId, renderedClip.userId);
    await createRenderedClipReadyNotification(params.renderedClipId);
  }
}

export async function assertRenderedClipReadyState(
  clipCandidateId: number,
  variant: RenderedClipVariant,
  layout: RenderedClipLayout = RenderedClipLayout.DEFAULT
) {
  const renderedClip = await db.query.renderedClips.findFirst({
    where: and(
      eq(renderedClips.clipCandidateId, clipCandidateId),
      eq(renderedClips.variant, variant),
      eq(renderedClips.layout, layout)
    ),
  });

  if (!renderedClip) {
    throw new Error('Rendered clip was not created after processing.');
  }

  if (
    renderedClip.status !== RenderedClipStatus.READY ||
    !renderedClip.storageKey ||
    !renderedClip.storageUrl
  ) {
    throw new Error('Rendered clip was not marked ready after processing.');
  }

  return renderedClip;
}

export async function renderApprovedClipCandidate(
  clipCandidateId: number,
  captionsEnabled = true,
  captionFontAssetId?: number
) {
  const clipCandidate = await getClipCandidateForRender(clipCandidateId);

  if (!clipCandidate) {
    throw new Error('Clip candidate not found.');
  }

  const renderedClip = await ensureRenderedClipPending({
    clipCandidateId,
    userId: clipCandidate.userId,
    variant: RenderedClipVariant.TRIMMED_ORIGINAL,
  });

  if (
    !clipCandidate.sourceAsset.storageKey ||
    !clipCandidate.sourceAsset.originalFilename
  ) {
    throw new Error('Source asset is missing storage metadata.');
  }

  assertMediaAvailable(clipCandidate.sourceAsset, 'Source asset');

  await markRenderedClipRendering(renderedClip.id);

  const sourceFileBuffer = await downloadStorageFile(
    clipCandidate.sourceAsset.storageKey
  );

  await withTempRenderFiles(
    clipCandidate.sourceAsset.originalFilename,
    sourceFileBuffer,
    async ({ inputPath, outputPath, subtitlePath, fontsDir }) => {
      const captionFont = captionsEnabled
        ? await prepareCaptionFont({
            captionFontAssetId,
            userId: clipCandidate.userId,
            fontsDir,
          })
        : null;
      const preparedSubtitlePath = captionsEnabled
        ? await writeCaptionFile({
            subtitlePath,
            clipStartTimeMs: clipCandidate.startTimeMs,
            clipDurationMs: clipCandidate.durationMs,
            transcriptSegments: clipCandidate.transcript.segments,
            transcriptWords: clipCandidate.transcript.words,
            fallbackText: clipCandidate.transcriptExcerpt,
            fontFamily: captionFont?.fontFamily,
          })
        : null;

      await runClipRender({
        inputPath,
        outputPath,
        startTimeMs: clipCandidate.startTimeMs,
        durationMs: clipCandidate.durationMs,
        subtitlePath: preparedSubtitlePath,
        fontsDir: captionFont?.fontsDir,
      });

      const outputBuffer = await fs.readFile(outputPath);
      const outputStats = await fs.stat(outputPath);

      if (!renderedClip.storageKey) {
        throw new Error('Rendered clip storage metadata is missing.');
      }

      await uploadStorageObject({
        storageKey: renderedClip.storageKey,
        mimeType: RENDERED_CLIP_MIME_TYPE,
        body: outputBuffer,
      });

      await markRenderedClipReady({
        renderedClipId: renderedClip.id,
        fileSizeBytes: outputStats.size,
      });
    }
  );

  return await assertRenderedClipReadyState(
    clipCandidateId,
    RenderedClipVariant.TRIMMED_ORIGINAL
  );
}

export async function formatRenderedClipShortFormCandidate(
  clipCandidateId: number,
  variant: RenderedClipVariant = RenderedClipVariant.VERTICAL_SHORT_FORM,
  layout: RenderedClipLayout = RenderedClipLayout.DEFAULT,
  captionsEnabled = true,
  captionFontAssetId?: number
) {
  const clipCandidate = await getClipCandidateForRender(clipCandidateId);

  if (!clipCandidate) {
    throw new Error('Clip candidate not found.');
  }

  const renderedClip = await ensureRenderedClipPending({
    clipCandidateId,
    userId: clipCandidate.userId,
    variant,
    layout,
  });

  await markRenderedClipRendering(renderedClip.id);
  const facecamDetection =
    layout === RenderedClipLayout.DEFAULT
      ? null
      : [...clipCandidate.facecamDetections].sort(
          (left, right) => left.rank - right.rank
        )[0] || null;

  const sourceClip = {
    filename: clipCandidate.sourceAsset.originalFilename,
    storageKey: clipCandidate.sourceAsset.storageKey,
    startTimeMs: clipCandidate.startTimeMs,
    durationMs: clipCandidate.durationMs,
  };

  if (!sourceClip.storageKey || !sourceClip.filename) {
    throw new Error('Source clip is missing storage metadata.');
  }

  assertMediaAvailable(clipCandidate.sourceAsset, 'Source asset');

  const sourceClipBuffer = await downloadStorageFile(sourceClip.storageKey);

  await withTempRenderFiles(
    sourceClip.filename,
    sourceClipBuffer,
    async ({ inputPath, outputPath, subtitlePath, fontsDir }) => {
      const captionFont = captionsEnabled
        ? await prepareCaptionFont({
            captionFontAssetId,
            userId: clipCandidate.userId,
            fontsDir,
          })
        : null;
      const preparedSubtitlePath = captionsEnabled
        ? await writeCaptionFile({
            subtitlePath,
            clipStartTimeMs: clipCandidate.startTimeMs,
            clipDurationMs: clipCandidate.durationMs,
            transcriptSegments: clipCandidate.transcript.segments,
            transcriptWords: clipCandidate.transcript.words,
            fallbackText: clipCandidate.transcriptExcerpt,
            fontFamily: captionFont?.fontFamily,
          })
        : null;

      await runVerticalShortFormRender({
        inputPath,
        outputPath,
        startTimeMs: sourceClip.startTimeMs ?? undefined,
        durationMs: sourceClip.durationMs ?? undefined,
        layout,
        subtitlePath: preparedSubtitlePath,
        fontsDir: captionFont?.fontsDir,
        facecamDetection,
        ...getShortFormRenderDimensions(variant),
      });

      const outputBuffer = await fs.readFile(outputPath);
      const outputStats = await fs.stat(outputPath);

      if (!renderedClip.storageKey) {
        throw new Error('Rendered clip storage metadata is missing.');
      }

      await uploadStorageObject({
        storageKey: renderedClip.storageKey,
        mimeType: RENDERED_CLIP_MIME_TYPE,
        body: outputBuffer,
      });

      await markRenderedClipReady({
        renderedClipId: renderedClip.id,
        fileSizeBytes: outputStats.size,
      });
    }
  );

  return await assertRenderedClipReadyState(
    clipCandidateId,
    variant,
    layout
  );
}

function getShortFormRenderDimensions(variant: RenderedClipVariant) {
  if (variant === RenderedClipVariant.SQUARE_SHORT_FORM) {
    return { width: 1080, height: 1080 };
  }

  if (variant === RenderedClipVariant.LANDSCAPE_SHORT_FORM) {
    return { width: 1920, height: 1080 };
  }

  return { width: 1080, height: 1920 };
}
