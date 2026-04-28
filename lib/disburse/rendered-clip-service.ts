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
  renderedClips,
  RenderedClipStatus,
  RenderedClipVariant,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
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

async function downloadSourceAssetFile(storageKey: string) {
  const download = createPresignedDownload({ storageKey });
  const response = await fetch(download.downloadUrl, {
    method: download.method,
  });

  if (!response.ok) {
    throw new Error(`Storage download failed with status ${response.status}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function runClipRender(params: {
  inputPath: string;
  outputPath: string;
  startTimeMs: number;
  durationMs: number;
}) {
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
}) {
  try {
    await execFileAsync(FFMPEG_BINARY, [
      '-y',
      '-i',
      params.inputPath,
      '-vf',
      'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
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

async function withTempRenderFiles<T>(
  sourceFilename: string,
  sourceFileBuffer: Buffer,
  callback: (paths: { inputPath: string; outputPath: string }) => Promise<T>
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disburse-render-'));
  const inputExtension = path.extname(sourceFilename) || '.bin';
  const inputPath = path.join(tempDir, `source${inputExtension}`);
  const outputPath = path.join(tempDir, 'clip.mp4');

  try {
    await fs.writeFile(inputPath, sourceFileBuffer);
    return await callback({ inputPath, outputPath });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function getClipCandidateForRender(clipCandidateId: number) {
  return await db.query.clipCandidates.findFirst({
    where: eq(clipCandidates.id, clipCandidateId),
    with: {
      contentPack: true,
      sourceAsset: true,
      renderedClips: true,
    },
  });
}

export async function ensureRenderedClipPending(params: {
  clipCandidateId: number;
  userId: number;
  variant: RenderedClipVariant;
}) {
  const clipCandidate = await getClipCandidateForRender(params.clipCandidateId);

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
    (renderedClip) => renderedClip.variant === params.variant
  );

  if (
    params.variant === RenderedClipVariant.VERTICAL_SHORT_FORM &&
    !clipCandidate.renderedClips.some(
      (renderedClip) =>
        renderedClip.variant === RenderedClipVariant.TRIMMED_ORIGINAL &&
        renderedClip.status === RenderedClipStatus.READY &&
        renderedClip.storageKey
    )
  ) {
    throw new Error(
      'Render the trimmed clip successfully before making a vertical version.'
    );
  }

  const storageKey = createRenderedClipStorageKey(
    clipCandidate.userId,
    clipCandidate.sourceAsset.projectId,
    clipCandidate.id,
    params.variant
  );
  const expiresAt =
    clipCandidate.sourceAsset.retentionStatus === MediaRetentionStatus.TEMPORARY &&
    clipCandidate.sourceAsset.expiresAt
      ? clipCandidate.sourceAsset.expiresAt
      : getTemporaryMediaExpiresAt();

  if (existingRenderedClip) {
    const [updatedRenderedClip] = await db
      .update(renderedClips)
      .set({
        status: RenderedClipStatus.PENDING,
        variant: params.variant,
        title: clipCandidate.title,
        startTimeMs: clipCandidate.startTimeMs,
        endTimeMs: clipCandidate.endTimeMs,
        durationMs: clipCandidate.durationMs,
        storageKey,
        storageUrl: buildStorageUrl(storageKey),
        mimeType: RENDERED_CLIP_MIME_TYPE,
        retentionStatus: MediaRetentionStatus.TEMPORARY,
        expiresAt,
        savedAt: null,
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
      status: RenderedClipStatus.PENDING,
      title: clipCandidate.title,
      startTimeMs: clipCandidate.startTimeMs,
      endTimeMs: clipCandidate.endTimeMs,
      durationMs: clipCandidate.durationMs,
      storageKey,
      storageUrl: buildStorageUrl(storageKey),
      mimeType: RENDERED_CLIP_MIME_TYPE,
      retentionStatus: MediaRetentionStatus.TEMPORARY,
      expiresAt,
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
  reason: string
) {
  const failureReason = normalizeFailureReason(reason);
  const existingRenderedClip = await db.query.renderedClips.findFirst({
    where: and(
      eq(renderedClips.clipCandidateId, clipCandidateId),
      eq(renderedClips.userId, userId),
      eq(renderedClips.variant, variant)
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
  }
}

export async function assertRenderedClipReadyState(
  clipCandidateId: number,
  variant: RenderedClipVariant
) {
  const renderedClip = await db.query.renderedClips.findFirst({
    where: and(
      eq(renderedClips.clipCandidateId, clipCandidateId),
      eq(renderedClips.variant, variant)
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

export async function renderApprovedClipCandidate(clipCandidateId: number) {
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

  const sourceFileBuffer = await downloadSourceAssetFile(
    clipCandidate.sourceAsset.storageKey
  );

  await withTempRenderFiles(
    clipCandidate.sourceAsset.originalFilename,
    sourceFileBuffer,
    async ({ inputPath, outputPath }) => {
      await runClipRender({
        inputPath,
        outputPath,
        startTimeMs: clipCandidate.startTimeMs,
        durationMs: clipCandidate.durationMs,
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
  clipCandidateId: number
) {
  const clipCandidate = await getClipCandidateForRender(clipCandidateId);

  if (!clipCandidate) {
    throw new Error('Clip candidate not found.');
  }

  const trimmedClip = clipCandidate.renderedClips.find(
    (renderedClip) =>
      renderedClip.variant === RenderedClipVariant.TRIMMED_ORIGINAL
  );

  if (
    !trimmedClip ||
    trimmedClip.status !== RenderedClipStatus.READY ||
    !trimmedClip.storageKey
  ) {
    throw new Error(
      'Render the trimmed clip successfully before making a vertical version.'
    );
  }

  assertMediaAvailable(trimmedClip, 'Rendered clip');

  const renderedClip = await ensureRenderedClipPending({
    clipCandidateId,
    userId: clipCandidate.userId,
    variant: RenderedClipVariant.VERTICAL_SHORT_FORM,
  });

  await markRenderedClipRendering(renderedClip.id);

  const trimmedClipBuffer = await downloadSourceAssetFile(trimmedClip.storageKey);

  await withTempRenderFiles(
    'trimmed-clip.mp4',
    trimmedClipBuffer,
    async ({ inputPath, outputPath }) => {
      await runVerticalShortFormRender({
        inputPath,
        outputPath,
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
    RenderedClipVariant.VERTICAL_SHORT_FORM
  );
}
