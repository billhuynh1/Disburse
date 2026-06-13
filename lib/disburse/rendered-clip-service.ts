import 'server-only';

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipRenderConfigs,
  clipCandidates,
  ContentPackKind,
  MediaRetentionStatus,
  RenderedClipLayout,
  renderedClips,
  RenderedClipStatus,
  RenderedClipVariant,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  type ClipEditConfig,
  type ClipRenderConfig,
  type ReusableAsset,
} from '@/lib/db/schema';
import {
  getOrCreateClipEditConfig,
  getRenderedClipVariantForEditConfig,
} from '@/lib/disburse/clip-edit-config-service';
import { StaleJobError, StaleJobReason } from '@/lib/disburse/stale-job';
import {
  buildStorageUrl,
  createPresignedDownload,
  createRenderedClipStorageKey,
  uploadStorageObject,
} from '@/lib/disburse/s3-storage';
import {
  assertMediaAvailable,
  getTemporaryMediaExpiresAt,
} from '@/lib/disburse/media-retention-service';
import {
  createRenderedClipFailedNotification,
  createRenderedClipReadyNotification,
} from '@/lib/disburse/notification-service';
import { buildRenderedClipAssCaptions } from '@/lib/disburse/rendered-clip-captions';
import { getReusableFontAssetForUser } from '@/lib/disburse/reusable-asset-service';
import { validateClipTiming } from '@/lib/disburse/clip-timing';
import { getFacecamSegmentForClip } from '@/lib/disburse/facecam-detection-service';
import { buildSourceCropFilter } from '@/lib/disburse/render-filter-utils';

const execFileAsync = promisify(execFile);
const RENDERED_CLIP_MIME_TYPE = 'video/mp4';
const FFMPEG_BINARY = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
const FC_SCAN_BINARY = process.env.FC_SCAN_PATH?.trim() || 'fc-scan';
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 10 * 60 * 1000);

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

async function getFontFamilyFromFile(fontPath: string) {
  try {
    const { stdout } = await execFileAsync(FC_SCAN_BINARY, [
      '--format',
      '%{family[0]}',
      fontPath,
    ]);
    const family = stdout.trim();

    return family || null;
  } catch {
    return null;
  }
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
  const fontFamily = await getFontFamilyFromFile(fontPath);

  return {
    fontFamily: fontFamily || asset.title,
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
    ], { timeout: RENDER_TIMEOUT_MS });
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
  cropSettings?: Record<string, unknown> | null;
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
  const filterArgs = isFacecamSplitLayout(layout)
    ? [
        '-filter_complex',
        buildFacecamSplitFilter({
          width,
          height,
          layout,
          subtitlePath: params.subtitlePath,
          fontsDir: params.fontsDir,
          facecamDetection: params.facecamDetection,
          cropSettings: params.cropSettings,
        }),
        '-map',
        '[vout]',
        '-map',
        '0:a:0?',
      ]
    : [
        '-vf',
        buildStandardShortFormFilter({
          width,
          height,
          layout,
          subtitlePath: params.subtitlePath,
          fontsDir: params.fontsDir,
          cropSettings: params.cropSettings,
        }),
      ];

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
    ], { timeout: RENDER_TIMEOUT_MS });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'ffmpeg failed unexpectedly.';
    throw new Error(`ffmpeg vertical render failed: ${message}`);
  }
}

function buildStandardShortFormFilter(params: {
  width: number;
  height: number;
  layout: RenderedClipLayout;
  subtitlePath?: string | null;
  fontsDir?: string | null;
  cropSettings?: Record<string, unknown> | null;
}) {
  const sourceCropFilter = buildSourceCropFilter(params.cropSettings);
  const resizeFilter =
    params.layout === RenderedClipLayout.PRESERVE_ASPECT
      ? [
          `scale=${params.width}:${params.height}:force_original_aspect_ratio=decrease`,
          `pad=${params.width}:${params.height}:(ow-iw)/2:(oh-ih)/2:black`,
        ]
      : [
          `scale=${params.width}:${params.height}:force_original_aspect_ratio=increase`,
          `crop=${params.width}:${params.height}`,
        ];

  return [
    sourceCropFilter,
    ...resizeFilter,
    params.subtitlePath
      ? buildSubtitleFilter(params.subtitlePath, params.fontsDir)
      : null,
  ]
    .filter(Boolean)
    .join(',');
}

function isFacecamSplitLayout(layout: RenderedClipLayout) {
  return (
    layout === RenderedClipLayout.FACECAM_TOP_50 ||
    layout === RenderedClipLayout.FACECAM_TOP_40 ||
    layout === RenderedClipLayout.FACECAM_TOP_30
  );
}

function buildFacecamSplitFilter(params: {
  width: number;
  height: number;
  layout: RenderedClipLayout;
  subtitlePath?: string | null;
  fontsDir?: string | null;
  cropSettings?: Record<string, unknown> | null;
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
  const sourceCropFilter = buildSourceCropFilter(params.cropSettings);

  const filterParts = [
    `split=2[main][face]`,
    `[face]crop=${facecamCrop.width}:${facecamCrop.height}:${facecamCrop.x}:${facecamCrop.y},scale=${params.width}:${facecamHeight}[faceout]`,
    `[main]${sourceCropFilter ? `${sourceCropFilter},` : ''}scale=${params.width}:${mainHeight}:force_original_aspect_ratio=increase,crop=${params.width}:${mainHeight}[mainout]`,
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
      renderConfigs: true,
      facecamDetections: true,
      editConfig: true,
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
  aspectRatio?: '9_16' | '1_1' | '16_9';
  renderWidth?: number;
  renderHeight?: number;
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
  captionPosition?: 'top' | 'middle' | 'bottom' | 'manual';
  captionPlacements?: Partial<
    Record<'9_16' | '1_1' | '16_9', { x: number; y: number }>
  > | null;
}) {
  const captions = buildRenderedClipAssCaptions({
    clipStartTimeMs: params.clipStartTimeMs,
    clipDurationMs: params.clipDurationMs,
    transcriptSegments: params.transcriptSegments,
    transcriptWords: params.transcriptWords,
    fallbackText: params.fallbackText,
    fontFamily: params.fontFamily,
    captionPosition: params.captionPosition,
    aspectRatio: params.aspectRatio,
    renderWidth: params.renderWidth,
    renderHeight: params.renderHeight,
    captionPlacements: params.captionPlacements,
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
  editConfig?: ClipEditConfig | null;
  renderConfig?: ClipRenderConfig | null;
}) {
  const clipCandidate = await getClipCandidateForRender(params.clipCandidateId);
  const layout = params.layout ?? RenderedClipLayout.DEFAULT;
  const editConfig = params.editConfig ?? null;
  const renderConfig = params.renderConfig ?? null;

  if (!clipCandidate || clipCandidate.userId !== params.userId) {
    throw new Error('Clip candidate not found.');
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
  const timing = validateClipTiming(
    {
      startTimeMs: clipCandidate.startTimeMs,
      endTimeMs: clipCandidate.endTimeMs,
      durationMs: clipCandidate.durationMs,
    },
    'Render clip candidate timing'
  );
  const generationRunId =
    renderConfig?.generationRunId ??
    editConfig?.generationRunId ??
    clipCandidate.generationRunId;
  const configHash = renderConfig?.configHash ?? editConfig?.configHash ?? null;

  const existingRenderedClip = clipCandidate.renderedClips.find(
    (renderedClip) =>
      renderedClip.generationRunId === generationRunId &&
      renderedClip.variant === params.variant &&
      renderedClip.layout === layout &&
      (!configHash || renderedClip.editConfigHash === configHash)
  );

  if (isFacecamSplitLayout(layout)) {
    const facecamSegment = await getFacecamSegmentForClip({
      videoId: clipCandidate.sourceAssetId,
      userId: clipCandidate.userId,
      clipCandidateId: clipCandidate.id,
      startTimeMs: timing.startTimeMs,
      endTimeMs: timing.endTimeMs,
    });

    if (!facecamSegment) {
      throw new Error('A ready facecam detection is required for split layouts.');
    }
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
    if (
      [RenderedClipStatus.PENDING, RenderedClipStatus.RENDERING, RenderedClipStatus.READY].includes(
        existingRenderedClip.status as RenderedClipStatus
      )
    ) {
      console.info('rendered_clip.reuse_current', {
        clipCandidateId: clipCandidate.id,
        editConfigId: editConfig?.id ?? null,
        renderConfigId: renderConfig?.id ?? null,
        configVersion: editConfig?.configVersion ?? null,
        configHash,
        renderedClipId: existingRenderedClip.id,
        renderStatus: existingRenderedClip.status,
      });
      return existingRenderedClip;
    }

    const [updatedRenderedClip] = await db
      .update(renderedClips)
      .set({
        status: RenderedClipStatus.PENDING,
        variant: params.variant,
        layout,
        generationRunId,
        editConfigId: editConfig?.id ?? null,
        clipRenderConfigId: renderConfig?.id ?? null,
        editConfigVersion: editConfig?.configVersion ?? null,
        editConfigHash: configHash,
        title: clipCandidate.title,
        startTimeMs: timing.startTimeMs,
        endTimeMs: timing.endTimeMs,
        durationMs: timing.durationMs,
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
      generationRunId,
      variant: params.variant,
      layout,
      editConfigId: editConfig?.id ?? null,
      clipRenderConfigId: renderConfig?.id ?? null,
      editConfigVersion: editConfig?.configVersion ?? null,
      editConfigHash: configHash,
      status: RenderedClipStatus.PENDING,
      title: clipCandidate.title,
      startTimeMs: timing.startTimeMs,
      endTimeMs: timing.endTimeMs,
      durationMs: timing.durationMs,
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

async function acquireRenderedClipForRendering(params: {
  renderedClipId: number;
  jobId?: number;
  sourceAssetId?: number;
  clipCandidateId?: number;
  generationRunId?: string;
}) {
  const [renderedClip] = await db
    .update(renderedClips)
    .set({
      status: RenderedClipStatus.RENDERING,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(renderedClips.id, params.renderedClipId),
        eq(renderedClips.status, RenderedClipStatus.PENDING)
      )
    )
    .returning();

  if (renderedClip) {
    console.info('render_started', {
      jobId: params.jobId ?? null,
      sourceAssetId: params.sourceAssetId ?? renderedClip.sourceAssetId,
      clipCandidateId: params.clipCandidateId ?? renderedClip.clipCandidateId,
      renderedClipId: renderedClip.id,
      generationRunId: params.generationRunId ?? renderedClip.generationRunId,
      status: renderedClip.status,
    });
    return { acquired: true as const, renderedClip };
  }

  const currentRenderedClip = await db.query.renderedClips.findFirst({
    where: eq(renderedClips.id, params.renderedClipId),
  });

  if (!currentRenderedClip) {
    throw new Error('Rendered clip was not found.');
  }

  console.info('render_started.reuse_active', {
    jobId: params.jobId ?? null,
    sourceAssetId: params.sourceAssetId ?? currentRenderedClip.sourceAssetId,
    clipCandidateId: params.clipCandidateId ?? currentRenderedClip.clipCandidateId,
    renderedClipId: currentRenderedClip.id,
    generationRunId:
      params.generationRunId ?? currentRenderedClip.generationRunId,
    status: currentRenderedClip.status,
  });

  if (currentRenderedClip.status === RenderedClipStatus.FAILED) {
    throw new Error(
      currentRenderedClip.failureReason || 'Rendered clip is already failed.'
    );
  }

  return { acquired: false as const, renderedClip: currentRenderedClip };
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

  console.info('render_failed', {
    renderedClipId: existingRenderedClip.id,
    clipCandidateId,
    sourceAssetId: existingRenderedClip.sourceAssetId,
    generationRunId: existingRenderedClip.generationRunId,
    variant,
    layout,
    status: RenderedClipStatus.FAILED,
    failureReason,
  });

  await createRenderedClipFailedNotification(existingRenderedClip.id);
}

async function markRenderedClipReady(params: {
  renderedClipId: number;
  fileSizeBytes: number;
  jobId?: number;
  durationMs?: number;
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
    console.info('render_completed', {
      jobId: params.jobId ?? null,
      renderedClipId: params.renderedClipId,
      clipCandidateId: renderedClip.clipCandidateId,
      userId: renderedClip.userId,
      fileSizeBytes: params.fileSizeBytes,
      durationMs: params.durationMs ?? null,
    });
    await createRenderedClipReadyNotification(params.renderedClipId);
  }
}

export async function assertRenderedClipReadyState(
  clipCandidateId: number,
  variant: RenderedClipVariant,
  layout: RenderedClipLayout = RenderedClipLayout.DEFAULT,
  editConfigHash?: string | null
) {
  const renderedClip = await db.query.renderedClips.findFirst({
    where: and(
      eq(renderedClips.clipCandidateId, clipCandidateId),
      eq(renderedClips.variant, variant),
      eq(renderedClips.layout, layout),
      ...(editConfigHash
        ? [eq(renderedClips.editConfigHash, editConfigHash)]
        : [])
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
  captionFontAssetId?: number,
  context?: { jobId?: number }
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

  const acquireResult = await acquireRenderedClipForRendering({
    renderedClipId: renderedClip.id,
    jobId: context?.jobId,
    sourceAssetId: clipCandidate.sourceAssetId,
    clipCandidateId: clipCandidate.id,
    generationRunId: clipCandidate.generationRunId,
  });

  if (!acquireResult.acquired) {
    return acquireResult.renderedClip;
  }

  const renderStartedAt = Date.now();

  const sourceFileBuffer = await downloadStorageFile(
    clipCandidate.sourceAsset.storageKey
  );

  await withTempRenderFiles(
    clipCandidate.sourceAsset.originalFilename,
    sourceFileBuffer,
    async ({ inputPath, outputPath, subtitlePath, fontsDir }) => {
      const timing = validateClipTiming(
        {
          startTimeMs: clipCandidate.startTimeMs,
          endTimeMs: clipCandidate.endTimeMs,
          durationMs: clipCandidate.durationMs,
        },
        'Render clip candidate timing'
      );
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
            clipStartTimeMs: timing.startTimeMs,
            clipDurationMs: timing.durationMs,
            transcriptSegments: clipCandidate.transcript.segments,
            transcriptWords: clipCandidate.transcript.words,
            fallbackText: clipCandidate.transcriptExcerpt,
            fontFamily: captionFont?.fontFamily,
          })
        : null;

      await runClipRender({
        inputPath,
        outputPath,
        startTimeMs: timing.startTimeMs,
        durationMs: timing.durationMs,
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
        jobId: context?.jobId,
        durationMs: Date.now() - renderStartedAt,
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
  captionFontAssetId?: number,
  expectedEditConfigHash?: string,
  renderConfigId?: number,
  context?: { jobId?: number }
) {
  const clipCandidate = await getClipCandidateForRender(clipCandidateId);

  if (!clipCandidate) {
    throw new Error('Clip candidate not found.');
  }

  const editConfig = await getOrCreateClipEditConfig(
    clipCandidateId,
    clipCandidate.userId
  );
  const renderConfig = renderConfigId
    ? await db.query.clipRenderConfigs.findFirst({
        where: and(
          eq(clipRenderConfigs.id, renderConfigId),
          eq(clipRenderConfigs.clipCandidateId, clipCandidateId),
          eq(clipRenderConfigs.userId, clipCandidate.userId)
        ),
      })
    : null;

  if (renderConfigId && !renderConfig) {
    throw new Error('Render config not found.');
  }

  const activeConfig = renderConfig ?? editConfig;

  if (expectedEditConfigHash && activeConfig.configHash !== expectedEditConfigHash) {
    const currentRenderedClip = clipCandidate.renderedClips.find(
      (clip) =>
        clip.generationRunId === activeConfig.generationRunId &&
        clip.variant === getRenderedClipVariantForEditConfig(activeConfig) &&
        clip.layout === activeConfig.layout &&
        clip.editConfigHash === activeConfig.configHash
    );
    console.info('rendered_clip.skip_stale_job', {
      clipCandidateId,
      editConfigId: renderConfig ? null : editConfig.id,
      renderConfigId: renderConfig?.id ?? null,
      expectedConfigHash: expectedEditConfigHash,
      currentConfigHash: activeConfig.configHash,
      configVersion: renderConfig ? null : editConfig.configVersion,
      currentRenderedClipId: currentRenderedClip?.id ?? null,
      currentRenderStatus: currentRenderedClip?.status ?? null,
    });

    if (currentRenderedClip) {
      return currentRenderedClip;
    }

    throw new StaleJobError(
      StaleJobReason.ARTIFACT_REPLACED,
      'Render job edit config is stale.'
    );
  }
  const renderVariant = getRenderedClipVariantForEditConfig(activeConfig);
  const renderLayout = activeConfig.layout as RenderedClipLayout;
  const renderCaptionsEnabled = activeConfig.captionsEnabled;
  const renderCaptionFontAssetId = activeConfig.captionFontAssetId ?? undefined;
  const renderDimensions = getShortFormRenderDimensions(renderVariant);
  const captionPlacements = getCaptionPlacements(activeConfig.cropSettings);

  const renderedClip = await ensureRenderedClipPending({
    clipCandidateId,
    userId: clipCandidate.userId,
    variant: renderVariant,
    layout: renderLayout,
    editConfig: renderConfig ? null : editConfig,
    renderConfig,
  });

  if (renderedClip.status === RenderedClipStatus.READY) {
    return renderedClip;
  }

  const acquireResult = await acquireRenderedClipForRendering({
    renderedClipId: renderedClip.id,
    jobId: context?.jobId,
    sourceAssetId: clipCandidate.sourceAssetId,
    clipCandidateId: clipCandidate.id,
    generationRunId: activeConfig.generationRunId,
  });

  if (!acquireResult.acquired) {
    return acquireResult.renderedClip;
  }

  const renderStartedAt = Date.now();
  const sourceClip = {
    filename: clipCandidate.sourceAsset.originalFilename,
    storageKey: clipCandidate.sourceAsset.storageKey,
    ...validateClipTiming(
      {
        startTimeMs: clipCandidate.startTimeMs,
        endTimeMs: clipCandidate.endTimeMs,
        durationMs: clipCandidate.durationMs,
      },
      'Short-form render clip candidate timing'
    ),
  };

  if (!sourceClip.storageKey || !sourceClip.filename) {
    throw new Error('Source clip is missing storage metadata.');
  }

  assertMediaAvailable(clipCandidate.sourceAsset, 'Source asset');

  const facecamDetection = isFacecamSplitLayout(renderLayout)
    ? await getFacecamSegmentForClip({
        videoId: clipCandidate.sourceAssetId,
        userId: clipCandidate.userId,
        clipCandidateId: clipCandidate.id,
        startTimeMs: sourceClip.startTimeMs,
        endTimeMs: sourceClip.endTimeMs,
      })
    : null;

  const sourceClipBuffer = await downloadStorageFile(sourceClip.storageKey);

  await withTempRenderFiles(
    sourceClip.filename,
    sourceClipBuffer,
    async ({ inputPath, outputPath, subtitlePath, fontsDir }) => {
      const captionFont = renderCaptionsEnabled
        ? await prepareCaptionFont({
            captionFontAssetId: renderCaptionFontAssetId,
            userId: clipCandidate.userId,
            fontsDir,
          })
        : null;
      const preparedSubtitlePath = renderCaptionsEnabled
        ? await writeCaptionFile({
            subtitlePath,
            clipStartTimeMs: sourceClip.startTimeMs,
            clipDurationMs: sourceClip.durationMs,
            aspectRatio: activeConfig.aspectRatio as '9_16' | '1_1' | '16_9',
            renderWidth: renderDimensions.width,
            renderHeight: renderDimensions.height,
            transcriptSegments: clipCandidate.transcript.segments,
            transcriptWords: clipCandidate.transcript.words,
            fallbackText: clipCandidate.transcriptExcerpt,
            fontFamily: captionFont?.fontFamily,
            captionPosition: activeConfig.captionPosition as
              | 'top'
              | 'middle'
              | 'bottom'
              | 'manual',
            captionPlacements,
          })
        : null;

      await runVerticalShortFormRender({
        inputPath,
        outputPath,
        startTimeMs: sourceClip.startTimeMs,
        durationMs: sourceClip.durationMs,
        layout: renderLayout,
        subtitlePath: preparedSubtitlePath,
        fontsDir: captionFont?.fontsDir,
        facecamDetection,
        cropSettings: activeConfig.cropSettings,
        ...renderDimensions,
      });
      console.info('rendered_clip.ffmpeg_complete', {
        clipCandidateId,
        editConfigId: renderConfig ? null : editConfig.id,
        renderConfigId: renderConfig?.id ?? null,
        configVersion: renderConfig ? null : editConfig.configVersion,
        configHash: activeConfig.configHash,
        renderedClipId: renderedClip.id,
        durationMs: Date.now() - renderStartedAt,
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
        jobId: context?.jobId,
        durationMs: Date.now() - renderStartedAt,
      });
    }
  );

  return await assertRenderedClipReadyState(
    clipCandidateId,
    renderVariant,
    renderLayout,
    activeConfig.configHash
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

function getCaptionPlacements(
  cropSettings?: Record<string, unknown> | null
):
  | Partial<Record<'9_16' | '1_1' | '16_9', { x: number; y: number }>>
  | null {
  const placements = cropSettings?.captionPlacements;

  if (!placements || typeof placements !== 'object' || Array.isArray(placements)) {
    return null;
  }

  const normalized: Partial<
    Record<'9_16' | '1_1' | '16_9', { x: number; y: number }>
  > = {};

  for (const aspectRatio of ['9_16', '1_1', '16_9'] as const) {
    const placement = (placements as Record<string, unknown>)[aspectRatio];

    if (!placement || typeof placement !== 'object' || Array.isArray(placement)) {
      continue;
    }

    const x = (placement as { x?: unknown }).x;
    const y = (placement as { y?: unknown }).y;

    if (typeof x !== 'number' || typeof y !== 'number') {
      continue;
    }

    normalized[aspectRatio] = {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}
