import 'server-only';

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  projects,
  sourceAssetThumbnailVariants,
  sourceAssets,
  SourceAssetType,
} from '@/lib/db/schema';
import {
  createPresignedDownload,
  createSourceAssetThumbnailStorageKey,
  deleteStorageObject,
  uploadStorageObject,
} from '@/lib/disburse/s3-storage';
import {
  assertJobExecutionAuthorized,
  type JobExecutionAuthority,
  withAuthorizedJobTransaction,
} from '@/lib/disburse/job-execution-authorization';
import { getJobOperationSignal } from '@/lib/disburse/pipeline-operation-deadline';

const FFMPEG_BINARY = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
const FFPROBE_BINARY = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
const DEFAULT_THUMBNAIL_VARIANT = 'default';
const THUMBNAIL_MIME_TYPE = 'image/jpeg';

export type SourceAssetThumbnailExternalOperations = {
  createDownload: typeof createPresignedDownload;
  extractFrame: typeof extractFrame;
  readImageDimensions: typeof readImageDimensions;
  readFile: typeof readFile;
  uploadStorageObject: typeof uploadStorageObject;
  deleteStorageObject: typeof deleteStorageObject;
};

async function shouldCompensateThumbnailUpload(
  sourceAssetId: number,
  userId: number
) {
  const sourceAsset = await db.query.sourceAssets.findFirst({
    columns: {
      projectId: true,
      deletionRequestedAt: true,
    },
    where: and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.userId, userId)),
  });
  if (!sourceAsset || sourceAsset.deletionRequestedAt) return true;
  const project = await db.query.projects.findFirst({
    columns: { deletionRequestedAt: true },
    where: (projects, { eq }) => eq(projects.id, sourceAsset.projectId),
  });
  return !project || Boolean(project.deletionRequestedAt);
}

export function runProcess(command: string, args: string[], signal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || `${command} exited with status ${code}.`));
    });
  });
}

async function extractFrame(params: {
  sourceUrl: string;
  outputPath: string;
  seekSeconds: number;
  signal?: AbortSignal;
}) {
  await runProcess(FFMPEG_BINARY, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(params.seekSeconds),
    '-i',
    params.sourceUrl,
    '-frames:v',
    '1',
    '-vf',
    "scale='if(gt(ih,480),-2,iw)':'if(gt(ih,480),480,ih)'",
    '-q:v',
    '4',
    '-y',
    params.outputPath,
  ], params.signal);
}

async function readImageDimensions(imagePath: string, signal?: AbortSignal) {
  const { stdout } = await runProcess(FFPROBE_BINARY, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=s=x:p=0',
    imagePath,
  ], signal);
  const [width, height] = stdout.trim().split('x').map(Number);

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('Thumbnail dimensions could not be read.');
  }

  return { width, height };
}

export async function extractSourceAssetThumbnail(
  sourceAssetId: number,
  userId: number,
  authority: JobExecutionAuthority,
  external: SourceAssetThumbnailExternalOperations = {
    createDownload: createPresignedDownload,
    extractFrame,
    readImageDimensions,
    readFile,
    uploadStorageObject,
    deleteStorageObject,
  }
) {
  const existingVariant = await db.query.sourceAssetThumbnailVariants.findFirst({
    where: and(
      eq(sourceAssetThumbnailVariants.sourceAssetId, sourceAssetId),
      eq(sourceAssetThumbnailVariants.variant, DEFAULT_THUMBNAIL_VARIANT)
    ),
  });

  if (existingVariant) {
    return existingVariant;
  }

  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.userId, userId)),
  });

  if (
    !sourceAsset ||
    sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE ||
    !sourceAsset.storageKey ||
    !sourceAsset.mimeType?.startsWith('video/')
  ) {
    return null;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'disburse-thumbnail-'));
  const outputPath = path.join(tempDir, 'thumbnail.jpg');
  let uploadedStorageKey: string | null = null;
  const operationSignal = getJobOperationSignal(authority);

  try {
    await assertJobExecutionAuthorized(authority);
    const download = external.createDownload({
      storageKey: sourceAsset.storageKey,
      expiresInSeconds: 900,
    });

    await external.extractFrame({
      sourceUrl: download.downloadUrl,
      outputPath,
      seekSeconds: 5,
      signal: operationSignal,
    }).catch(async () => {
      await external.extractFrame({
        sourceUrl: download.downloadUrl,
        outputPath,
        seekSeconds: 0.1,
        signal: operationSignal,
      });
    });

    const [{ width, height }, body] = await Promise.all([
      external.readImageDimensions(outputPath, operationSignal),
      external.readFile(outputPath),
    ]);
    const storageKey = createSourceAssetThumbnailStorageKey({
      userId,
      projectId: sourceAsset.projectId,
      sourceAssetId: sourceAsset.id,
      mimeType: THUMBNAIL_MIME_TYPE,
    });

    await assertJobExecutionAuthorized(authority);
    await external.uploadStorageObject({
      storageKey,
      mimeType: THUMBNAIL_MIME_TYPE,
      body,
      signal: operationSignal,
    });
    uploadedStorageKey = storageKey;
    await assertJobExecutionAuthorized(authority);

    return await withAuthorizedJobTransaction(authority, async (tx) => {
      const now = new Date();
      const [variant] = await tx
        .insert(sourceAssetThumbnailVariants)
        .values({
          sourceAssetId: sourceAsset.id,
          variant: DEFAULT_THUMBNAIL_VARIANT,
          storageKey,
          mimeType: THUMBNAIL_MIME_TYPE,
          width,
          height,
        })
        .onConflictDoNothing({
          target: [
            sourceAssetThumbnailVariants.sourceAssetId,
            sourceAssetThumbnailVariants.variant,
          ],
        })
        .returning();

      const persistedVariant =
        variant ||
        (await tx.query.sourceAssetThumbnailVariants.findFirst({
          where: and(
            eq(sourceAssetThumbnailVariants.sourceAssetId, sourceAsset.id),
            eq(sourceAssetThumbnailVariants.variant, DEFAULT_THUMBNAIL_VARIANT)
          ),
        }));

      if (persistedVariant) {
        await tx
          .update(sourceAssets)
          .set({
            thumbnailStorageKey: persistedVariant.storageKey,
            thumbnailMimeType: persistedVariant.mimeType,
            thumbnailWidth: persistedVariant.width,
            thumbnailHeight: persistedVariant.height,
            updatedAt: now,
          })
          .where(and(eq(sourceAssets.id, sourceAsset.id), eq(sourceAssets.userId, userId)));
      }

      return persistedVariant || null;
    });
  } catch (error) {
    if (uploadedStorageKey) {
      try {
        if (await shouldCompensateThumbnailUpload(sourceAssetId, userId)) {
          try {
            await external.deleteStorageObject(uploadedStorageKey);
          } catch (compensationError) {
            console.error('source_thumbnail.compensation_failed', {
              sourceAssetId,
              storageKey: uploadedStorageKey,
              error: compensationError,
            });
          }
        }
      } catch (classificationError) {
        console.error('source_thumbnail.compensation_classification_failed', {
          sourceAssetId,
          storageKey: uploadedStorageKey,
          error: classificationError,
        });
      }
    }
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
