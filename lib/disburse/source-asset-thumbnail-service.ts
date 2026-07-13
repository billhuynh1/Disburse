import 'server-only';

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  sourceAssetThumbnailVariants,
  sourceAssets,
  SourceAssetType,
} from '@/lib/db/schema';
import {
  createPresignedDownload,
  createSourceAssetThumbnailStorageKey,
  uploadStorageObject,
} from '@/lib/disburse/s3-storage';
import {
  assertJobExecutionAuthorized,
  type JobExecutionAuthority,
  withAuthorizedJobTransaction,
} from '@/lib/disburse/job-execution-authorization';

const FFMPEG_BINARY = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
const FFPROBE_BINARY = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
const DEFAULT_THUMBNAIL_VARIANT = 'default';
const THUMBNAIL_MIME_TYPE = 'image/jpeg';

function runProcess(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
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
  ]);
}

async function readImageDimensions(imagePath: string) {
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
  ]);
  const [width, height] = stdout.trim().split('x').map(Number);

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('Thumbnail dimensions could not be read.');
  }

  return { width, height };
}

export async function extractSourceAssetThumbnail(
  sourceAssetId: number,
  userId: number,
  authority: JobExecutionAuthority
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

  try {
    await assertJobExecutionAuthorized(authority);
    const download = createPresignedDownload({
      storageKey: sourceAsset.storageKey,
      expiresInSeconds: 900,
    });

    await extractFrame({
      sourceUrl: download.downloadUrl,
      outputPath,
      seekSeconds: 5,
    }).catch(async () => {
      await extractFrame({
        sourceUrl: download.downloadUrl,
        outputPath,
        seekSeconds: 0.1,
      });
    });

    const [{ width, height }, body] = await Promise.all([
      readImageDimensions(outputPath),
      readFile(outputPath),
    ]);
    const storageKey = createSourceAssetThumbnailStorageKey({
      userId,
      projectId: sourceAsset.projectId,
      sourceAssetId: sourceAsset.id,
      mimeType: THUMBNAIL_MIME_TYPE,
    });

    await assertJobExecutionAuthorized(authority);
    await uploadStorageObject({
      storageKey,
      mimeType: THUMBNAIL_MIME_TYPE,
      body,
    });

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
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
