import 'server-only';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import {
  jobs,
  JobStatus,
  JobType,
  sourceAssets,
  SourceAssetType,
  transcripts,
  TranscriptStatus,
  type Job,
  type TranscribeSourceAssetJobPayload,
} from '@/lib/db/schema';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DbTransaction;

const transcribeSourceAssetJobPayloadSchema = z.object({
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

export type ClaimedTranscriptionJob = Job & {
  payload: TranscribeSourceAssetJobPayload;
};

function normalizeFailureReason(reason: string) {
  const normalized = reason.trim();
  return normalized.length > 0 ? normalized.slice(0, 5000) : 'Job failed.';
}

async function ensurePendingTranscript(
  executor: DbLike,
  payload: TranscribeSourceAssetJobPayload
) {
  const [existingTranscript] = await executor
    .select({
      id: transcripts.id,
      status: transcripts.status,
    })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.sourceAssetId, payload.sourceAssetId),
        eq(transcripts.userId, payload.userId)
      )
    )
    .limit(1);

  if (existingTranscript?.status === TranscriptStatus.READY) {
    return existingTranscript;
  }

  if (existingTranscript) {
    const [updatedTranscript] = await executor
      .update(transcripts)
      .set({
        status: TranscriptStatus.PENDING,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(transcripts.id, existingTranscript.id))
      .returning({
        id: transcripts.id,
        status: transcripts.status,
      });

    return updatedTranscript;
  }

  const [transcript] = await executor
    .insert(transcripts)
    .values({
      userId: payload.userId,
      sourceAssetId: payload.sourceAssetId,
      status: TranscriptStatus.PENDING,
    })
    .returning({
      id: transcripts.id,
      status: transcripts.status,
    });

  return transcript;
}

async function findActiveTranscriptionJob(
  executor: DbLike,
  sourceAssetId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.TRANSCRIBE_SOURCE_ASSET),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'sourceAssetId' = ${String(sourceAssetId)}`
    ),
  });
}

export async function enqueueTranscriptionJob(
  sourceAssetId: number,
  userId: number,
  executor: DbLike = db
) {
  const [sourceAsset] = await executor
    .select({
      id: sourceAssets.id,
      assetType: sourceAssets.assetType,
    })
    .from(sourceAssets)
    .where(
      and(
        eq(sourceAssets.id, sourceAssetId),
        eq(sourceAssets.userId, userId)
      )
    )
    .limit(1);

  if (!sourceAsset) {
    throw new Error('Source asset not found.');
  }

  if (sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE) {
    return null;
  }

  const payload: TranscribeSourceAssetJobPayload = {
    sourceAssetId,
    userId,
  };

  await ensurePendingTranscript(executor, payload);

  const existingJob = await findActiveTranscriptionJob(executor, sourceAssetId);

  if (existingJob) {
    return existingJob;
  }

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.TRANSCRIBE_SOURCE_ASSET,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

  return job;
}

export async function claimNextTranscriptionJob() {
  return await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: number }>(sql`
      select "id"
      from "jobs"
      where "status" = ${JobStatus.PENDING}
        and "available_at" <= now()
      order by "available_at" asc, "created_at" asc
      limit 1
      for update skip locked
    `);
    const nextJobId = rows[0]?.id;

    if (!nextJobId) {
      return null;
    }

    const [job] = await tx
      .update(jobs)
      .set({
        status: JobStatus.PROCESSING,
        attemptCount: sql`${jobs.attemptCount} + 1`,
        startedAt: new Date(),
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, nextJobId))
      .returning();

    if (!job || job.type !== JobType.TRANSCRIBE_SOURCE_ASSET) {
      return null;
    }

    const parsedPayload = transcribeSourceAssetJobPayloadSchema.safeParse(
      job.payload
    );

    if (!parsedPayload.success) {
      throw new Error('Claimed transcription job payload is invalid.');
    }

    return {
      ...job,
      payload: parsedPayload.data,
    } satisfies ClaimedTranscriptionJob;
  });
}

export async function markJobCompleted(jobId: number) {
  await db
    .update(jobs)
    .set({
      status: JobStatus.COMPLETED,
      completedAt: new Date(),
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}

export async function markJobFailed(jobId: number, reason: string) {
  await db
    .update(jobs)
    .set({
      status: JobStatus.FAILED,
      completedAt: new Date(),
      failureReason: normalizeFailureReason(reason),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}
