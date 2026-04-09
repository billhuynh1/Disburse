import 'server-only';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import {
  contentPacks,
  ContentPackKind,
  ContentPackStatus,
  jobs,
  JobStatus,
  JobType,
  sourceAssets,
  SourceAssetType,
  transcripts,
  TranscriptStatus,
  type GenerateShortFormPackJobPayload,
  type FormatRenderedClipShortFormJobPayload,
  type RenderClipCandidateJobPayload,
  type IngestYoutubeSourceAssetJobPayload,
  type Job,
  type JobPayload,
  type TranscribeSourceAssetJobPayload,
} from '@/lib/db/schema';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DbTransaction;

const transcribeSourceAssetJobPayloadSchema = z.object({
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

const ingestYoutubeSourceAssetJobPayloadSchema = z.object({
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

const generateShortFormPackJobPayloadSchema = z.object({
  contentPackId: z.number().int().positive(),
  sourceAssetId: z.number().int().positive(),
  transcriptId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

const renderClipCandidateJobPayloadSchema = z.object({
  clipCandidateId: z.number().int().positive(),
  contentPackId: z.number().int().positive(),
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

const formatRenderedClipShortFormJobPayloadSchema = z.object({
  clipCandidateId: z.number().int().positive(),
  contentPackId: z.number().int().positive(),
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

export type ClaimedPipelineJob =
  | (Job & {
      type: JobType.TRANSCRIBE_SOURCE_ASSET;
      payload: TranscribeSourceAssetJobPayload;
    })
  | (Job & {
      type: JobType.INGEST_YOUTUBE_SOURCE_ASSET;
      payload: IngestYoutubeSourceAssetJobPayload;
    })
  | (Job & {
      type: JobType.GENERATE_SHORT_FORM_PACK;
      payload: GenerateShortFormPackJobPayload;
    })
  | (Job & {
      type: JobType.RENDER_CLIP_CANDIDATE;
      payload: RenderClipCandidateJobPayload;
    })
  | (Job & {
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM;
      payload: FormatRenderedClipShortFormJobPayload;
    });

function normalizeFailureReason(reason: string) {
  const normalized = reason.trim();
  return normalized.length > 0 ? normalized.slice(0, 5000) : 'Job failed.';
}

async function ensurePendingTranscript(
  executor: DbLike,
  payload: TranscribeSourceAssetJobPayload | IngestYoutubeSourceAssetJobPayload
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

async function findActiveSourceAssetJob(
  executor: DbLike,
  type: JobType.TRANSCRIBE_SOURCE_ASSET | JobType.INGEST_YOUTUBE_SOURCE_ASSET,
  sourceAssetId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, type),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'sourceAssetId' = ${String(sourceAssetId)}`
    ),
  });
}

async function findActiveShortFormJob(
  executor: DbLike,
  contentPackId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.GENERATE_SHORT_FORM_PACK),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'contentPackId' = ${String(contentPackId)}`
    ),
  });
}

async function findActiveRenderJob(executor: DbLike, clipCandidateId: number) {
  return await executor.query.jobs.findFirst({
    where: and(
      inArray(jobs.type, [
        JobType.RENDER_CLIP_CANDIDATE,
        JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      ]),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`
    ),
  });
}

async function findActiveRenderJobByType(
  executor: DbLike,
  type: JobType.RENDER_CLIP_CANDIDATE | JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
  clipCandidateId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, type),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`
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
    .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.userId, userId)))
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

  const existingJob = await findActiveSourceAssetJob(
    executor,
    JobType.TRANSCRIBE_SOURCE_ASSET,
    sourceAssetId
  );

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

export async function enqueueYoutubeIngestionJob(
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
    .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.userId, userId)))
    .limit(1);

  if (!sourceAsset) {
    throw new Error('Source asset not found.');
  }

  if (sourceAsset.assetType !== SourceAssetType.YOUTUBE_URL) {
    return null;
  }

  const payload: IngestYoutubeSourceAssetJobPayload = {
    sourceAssetId,
    userId,
  };

  await ensurePendingTranscript(executor, payload);

  const existingJob = await findActiveSourceAssetJob(
    executor,
    JobType.INGEST_YOUTUBE_SOURCE_ASSET,
    sourceAssetId
  );

  if (existingJob) {
    return existingJob;
  }

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.INGEST_YOUTUBE_SOURCE_ASSET,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

  return job;
}

export async function enqueueShortFormPackJob(
  contentPackId: number,
  sourceAssetId: number,
  transcriptId: number,
  userId: number,
  executor: DbLike = db
) {
  const [contentPack] = await executor
    .select({
      id: contentPacks.id,
      kind: contentPacks.kind,
      status: contentPacks.status,
    })
    .from(contentPacks)
    .where(and(eq(contentPacks.id, contentPackId), eq(contentPacks.userId, userId)))
    .limit(1);

  if (!contentPack) {
    throw new Error('Content pack not found.');
  }

  if (contentPack.kind !== ContentPackKind.SHORT_FORM_CLIPS) {
    throw new Error('Only short-form clip packs can be queued for generation.');
  }

  const existingJob = await findActiveShortFormJob(executor, contentPackId);

  await executor
    .update(contentPacks)
    .set({
      status:
        existingJob?.status === JobStatus.PROCESSING
          ? ContentPackStatus.GENERATING
          : ContentPackStatus.PENDING,
      transcriptId,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(contentPacks.id, contentPackId));

  if (existingJob) {
    return existingJob;
  }

  const payload: GenerateShortFormPackJobPayload = {
    contentPackId,
    sourceAssetId,
    transcriptId,
    userId,
  };

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.GENERATE_SHORT_FORM_PACK,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

  return job;
}

export async function enqueueRenderClipJob(
  clipCandidateId: number,
  contentPackId: number,
  sourceAssetId: number,
  userId: number,
  executor: DbLike = db
) {
  const existingJob = await findActiveRenderJobByType(
    executor,
    JobType.RENDER_CLIP_CANDIDATE,
    clipCandidateId
  );

  if (existingJob) {
    return existingJob;
  }

  const payload: RenderClipCandidateJobPayload = {
    clipCandidateId,
    contentPackId,
    sourceAssetId,
    userId,
  };

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.RENDER_CLIP_CANDIDATE,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

  return job;
}

export async function enqueueFormatRenderedClipShortFormJob(
  clipCandidateId: number,
  contentPackId: number,
  sourceAssetId: number,
  userId: number,
  executor: DbLike = db
) {
  const existingJob = await findActiveRenderJobByType(
    executor,
    JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
    clipCandidateId
  );

  if (existingJob) {
    return existingJob;
  }

  const payload: FormatRenderedClipShortFormJobPayload = {
    clipCandidateId,
    contentPackId,
    sourceAssetId,
    userId,
  };

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

  return job;
}

function parseJobPayload(type: JobType, payload: JobPayload) {
  switch (type) {
    case JobType.TRANSCRIBE_SOURCE_ASSET: {
      const parsed = transcribeSourceAssetJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error('Claimed transcription job payload is invalid.');
      }

      return parsed.data;
    }
    case JobType.INGEST_YOUTUBE_SOURCE_ASSET: {
      const parsed = ingestYoutubeSourceAssetJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error('Claimed YouTube ingestion job payload is invalid.');
      }

      return parsed.data;
    }
    case JobType.GENERATE_SHORT_FORM_PACK: {
      const parsed = generateShortFormPackJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error('Claimed short-form job payload is invalid.');
      }

      return parsed.data;
    }
    case JobType.RENDER_CLIP_CANDIDATE: {
      const parsed = renderClipCandidateJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error('Claimed render clip job payload is invalid.');
      }

      return parsed.data;
    }
    case JobType.FORMAT_RENDERED_CLIP_SHORT_FORM: {
      const parsed =
        formatRenderedClipShortFormJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error(
          'Claimed short-form format job payload is invalid.'
        );
      }

      return parsed.data;
    }
    default:
      throw new Error('Unsupported job type.');
  }
}

export async function claimNextJob() {
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

    if (!job) {
      return null;
    }

    const payload = parseJobPayload(job.type as JobType, job.payload as JobPayload);

    return {
      ...job,
      type: job.type as ClaimedPipelineJob['type'],
      payload,
    } as ClaimedPipelineJob;
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
