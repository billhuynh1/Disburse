import 'server-only';

import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetectionRuns,
  clipCandidates,
  clipEditConfigs,
  clipRenderConfigs,
  contentPacks,
  ContentPackKind,
  ContentPackStatus,
  FacecamDetectionStatus,
  jobs,
  JobStatus,
  JobType,
  MediaRetentionStatus,
  projects,
  renderedClips,
  RenderedClipStatus,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  transcripts,
  TranscriptStatus,
  transcriptWords,
  type DetectClipFacecamJobPayload,
  type FormatRenderedClipShortFormJobPayload,
  type GenerateShortFormPackJobPayload,
  type IngestYoutubeSourceAssetJobPayload,
  type RenderClipCandidateJobPayload,
  type TranscribeSourceAssetJobPayload,
} from '@/lib/db/schema';
import { createRenderableRenderConfigsForEditConfig } from '@/lib/disburse/brand-template-service';
import {
  ensureDefaultClipEditConfigs,
  getRenderedClipVariantForEditConfig,
} from '@/lib/disburse/clip-edit-config-service';
import {
  isTerminalFacecamStatus,
  replayCandidateFacecamTerminalProjection,
} from '@/lib/disburse/candidate-facecam-terminal-service';
import {
  buildCandidateFacecamIdempotencyKey,
  FACECAM_DETECTOR_VERSION,
} from '@/lib/disburse/facecam-detection-service';
import { createGenerationRunId } from '@/lib/disburse/generation-run-service';
import { buildJobIdempotencyKey } from '@/lib/disburse/job-identity';
import { parseJobPayloadForType } from '@/lib/disburse/job-payload-schema';
import { insertOrReuseReconciliationJob } from '@/lib/disburse/job-service';
import {
  createFacecamDetectionNotification,
  createRenderedClipFailedNotification,
  createRenderedClipReadyNotification,
  createShortFormPackFailedNotification,
  createShortFormPackReadyNotification,
  createTranscriptFailedNotification,
  createTranscriptReadyNotification,
} from '@/lib/disburse/notification-service';
import {
  decideGenerationReconciliation,
  decideFacecamReconciliation,
  decidePackFinalization,
  decideRenderReconciliation,
  decideSourceReconciliation,
  normalizeReconciliationPageSize,
  normalizeReconciliationCursor,
  type ReconciliationReason,
} from '@/lib/disburse/pipeline-reconciliation-policy';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PipelineReconciliationEvent = {
  projectId: number;
  sourceAssetId?: number;
  contentPackId?: number;
  clipCandidateId?: number;
  action: string;
  reason: ReconciliationReason;
  durableIdentity?: string;
};

const INCONSISTENT_TRANSCRIPT_REASON =
  'pipeline_reconciliation:transcript_completed_result_missing';
const INCONSISTENT_GENERATION_REASON =
  'pipeline_reconciliation:generation_completed_result_missing';
const REBUILD_CONSUMED_REASON =
  'pipeline_reconciliation:generation_missing_candidate_rebuild_consumed';
const INCONSISTENT_RENDER_REASON =
  'pipeline_reconciliation:render_completed_artifact_missing';

function sourceJobType(assetType: string) {
  if (assetType === SourceAssetType.UPLOADED_FILE) {
    return JobType.TRANSCRIBE_SOURCE_ASSET;
  }
  if (assetType === SourceAssetType.YOUTUBE_URL) {
    return JobType.INGEST_YOUTUBE_SOURCE_ASSET;
  }
  return null;
}

function isSourceMediaAvailable(source: typeof sourceAssets.$inferSelect) {
  if (
    source.deletedAt ||
    source.storageDeletedAt ||
    source.retentionStatus === MediaRetentionStatus.EXPIRED ||
    source.retentionStatus === MediaRetentionStatus.DELETED
  ) {
    return false;
  }
  if (source.assetType === SourceAssetType.PASTED_TRANSCRIPT) return true;
  if (source.assetType === SourceAssetType.UPLOADED_FILE) return Boolean(source.storageKey);
  return Boolean(source.storageUrl);
}

function isUploadedVideo(source: typeof sourceAssets.$inferSelect) {
  return source.assetType === SourceAssetType.UPLOADED_FILE &&
    (!source.mimeType || source.mimeType.startsWith('video/'));
}

function jobStatus(job: typeof jobs.$inferSelect | undefined) {
  return (job?.status ?? 'missing') as
    | 'missing'
    | 'pending'
    | 'processing'
    | 'completed'
    | 'failed'
    | 'cancelled';
}

async function lockProjectGraph(tx: DbTransaction, projectId: number) {
  const [project] = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update')
    .limit(1);
  if (!project) return null;

  const sources = await tx
    .select()
    .from(sourceAssets)
    .where(eq(sourceAssets.projectId, project.id))
    .orderBy(asc(sourceAssets.id))
    .for('update');
  const sourceIds = sources.map((source) => source.id);
  const packs = sourceIds.length === 0 ? [] : await tx
    .select()
    .from(contentPacks)
    .where(inArray(contentPacks.sourceAssetId, sourceIds))
    .orderBy(asc(contentPacks.id))
    .for('update');
  const packIds = packs.map((pack) => pack.id);
  const candidates = packIds.length === 0 ? [] : await tx
    .select()
    .from(clipCandidates)
    .where(inArray(clipCandidates.contentPackId, packIds))
    .orderBy(asc(clipCandidates.id))
    .for('update');
  const candidateIds = candidates.map((candidate) => candidate.id);
  const editConfigs = candidateIds.length === 0 ? [] : await tx
    .select()
    .from(clipEditConfigs)
    .where(inArray(clipEditConfigs.clipCandidateId, candidateIds))
    .orderBy(asc(clipEditConfigs.id))
    .for('update');
  const renderConfigs = candidateIds.length === 0 ? [] : await tx
    .select()
    .from(clipRenderConfigs)
    .where(inArray(clipRenderConfigs.clipCandidateId, candidateIds))
    .orderBy(asc(clipRenderConfigs.id))
    .for('update');
  const detectionRuns = candidateIds.length === 0 ? [] : await tx
    .select()
    .from(clipCandidateFacecamDetectionRuns)
    .where(inArray(clipCandidateFacecamDetectionRuns.clipCandidateId, candidateIds))
    .orderBy(asc(clipCandidateFacecamDetectionRuns.id))
    .for('update');
  const clips = candidateIds.length === 0 ? [] : await tx
    .select()
    .from(renderedClips)
    .where(inArray(renderedClips.clipCandidateId, candidateIds))
    .orderBy(asc(renderedClips.id))
    .for('update');
  const possiblyRelatedJobs = sourceIds.length === 0 ? [] : await tx
    .select()
    .from(jobs)
    .where(
      or(
        inArray(sql<string>`${jobs.payload}->>'sourceAssetId'`, sourceIds.map(String)),
        packIds.length > 0
          ? inArray(sql<string>`${jobs.payload}->>'contentPackId'`, packIds.map(String))
          : undefined,
        candidateIds.length > 0
          ? inArray(sql<string>`${jobs.payload}->>'clipCandidateId'`, candidateIds.map(String))
          : undefined
      )
    )
    .orderBy(asc(jobs.id))
    .for('update');
  const relatedJobs = possiblyRelatedJobs.filter((job) => {
    const payload = parseJobPayloadForType(job.type, job.payload);
    if (!payload) return false;
    return ('sourceAssetId' in payload && typeof payload.sourceAssetId === 'number' && sourceIds.includes(payload.sourceAssetId)) ||
      ('contentPackId' in payload && typeof payload.contentPackId === 'number' && packIds.includes(payload.contentPackId)) ||
      ('clipCandidateId' in payload && typeof payload.clipCandidateId === 'number' && candidateIds.includes(payload.clipCandidateId));
  });
  const malformedJobs = possiblyRelatedJobs.filter((job) =>
    parseJobPayloadForType(job.type, job.payload) === null
  );

  return {
    project,
    sources,
    packs,
    candidates,
    editConfigs,
    renderConfigs,
    detectionRuns,
    clips,
    jobs: relatedJobs,
    malformedJobs,
  };
}

function event(
  projectId: number,
  action: string,
  reason: ReconciliationReason,
  context: Omit<PipelineReconciliationEvent, 'projectId' | 'action' | 'reason'> = {}
): PipelineReconciliationEvent {
  return { projectId, action, reason, ...context };
}

async function reconcileSource(
  tx: DbTransaction,
  graph: NonNullable<Awaited<ReturnType<typeof lockProjectGraph>>>,
  source: typeof sourceAssets.$inferSelect,
  events: PipelineReconciliationEvent[]
) {
  const transcript = await tx.query.transcripts.findFirst({
    where: eq(transcripts.sourceAssetId, source.id),
  });
  const persistedWord = transcript ? await tx.query.transcriptWords.findFirst({
    where: and(
      eq(transcriptWords.transcriptId, transcript.id),
      sql<boolean>`length(trim(${transcriptWords.text})) > 0`
    ),
  }) : undefined;
  const hasPersistedTranscript = transcript?.status === TranscriptStatus.READY && (
    Boolean(transcript.content?.trim()) ||
    (source.assetType !== SourceAssetType.PASTED_TRANSCRIPT && Boolean(persistedWord))
  );
  const type = sourceJobType(source.assetType);
  const payload = type === JobType.TRANSCRIBE_SOURCE_ASSET
    ? ({ sourceAssetId: source.id, userId: source.userId } satisfies TranscribeSourceAssetJobPayload)
    : type === JobType.INGEST_YOUTUBE_SOURCE_ASSET
      ? ({ sourceAssetId: source.id, userId: source.userId } satisfies IngestYoutubeSourceAssetJobPayload)
      : null;
  const identity = type && payload ? buildJobIdempotencyKey(type, payload) : null;
  const durableJob = identity
    ? graph.jobs.find((candidate) => candidate.idempotencyKey === identity)
    : undefined;
  const decision = decideSourceReconciliation({
    projectDeleting: Boolean(graph.project.deletionRequestedAt),
    sourceDeleting: Boolean(source.deletionRequestedAt),
    sourceDeleted: Boolean(source.deletedAt || source.storageDeletedAt),
    sourceExpired: source.retentionStatus === MediaRetentionStatus.EXPIRED,
    mediaAvailable: isSourceMediaAvailable(source),
    processable: Boolean(type) || transcript?.status === TranscriptStatus.READY,
    transcriptStatus: (transcript?.status ?? 'missing') as 'missing' | 'pending' | 'processing' | 'ready' | 'failed',
    sourceProjectionReady:
      source.status === SourceAssetStatus.READY &&
      graph.packs
        .filter((pack) => pack.sourceAssetId === source.id)
        .every((pack) => pack.transcriptId === transcript?.id),
    jobStatus: jobStatus(durableJob),
    hasPersistedTranscript,
  });
  events.push(event(graph.project.id, decision.action, decision.reason, {
    sourceAssetId: source.id,
    durableIdentity: identity ?? undefined,
  }));

  if (decision.action === 'enqueue' && type && payload && identity) {
    if (!transcript) {
      await tx.insert(transcripts).values({
        userId: source.userId,
        sourceAssetId: source.id,
        status: TranscriptStatus.PENDING,
      }).onConflictDoNothing({ target: transcripts.sourceAssetId });
    }
    const created = await insertOrReuseReconciliationJob({
      type,
      status: JobStatus.PENDING,
      idempotencyKey: identity,
      payload,
    }, tx);
    graph.jobs.push(created);
  } else if (decision.action === 'replay_projection' && transcript) {
    if (source.status !== SourceAssetStatus.READY || source.failureReason) {
      await tx.update(sourceAssets).set({
        status: SourceAssetStatus.READY,
        failureReason: null,
        updatedAt: new Date(),
      }).where(eq(sourceAssets.id, source.id));
    }
    await tx.update(contentPacks).set({
      transcriptId: transcript.id,
      updatedAt: new Date(),
    }).where(and(
      eq(contentPacks.sourceAssetId, source.id),
      sql<boolean>`${contentPacks.transcriptId} is distinct from ${transcript.id}`
    ));
    await createTranscriptReadyNotification(source.id, tx);
  } else if (decision.action === 'terminalize') {
    const now = new Date();
    const failureReason = decision.reason === 'transcript_ready_content_missing'
      ? 'pipeline_reconciliation:transcript_ready_content_missing'
      : INCONSISTENT_TRANSCRIPT_REASON;
    await tx.update(sourceAssets).set({
      status: SourceAssetStatus.FAILED,
      failureReason,
      updatedAt: now,
    }).where(and(
      eq(sourceAssets.id, source.id),
      or(
        sql<boolean>`${sourceAssets.status} is distinct from ${SourceAssetStatus.FAILED}`,
        sql<boolean>`${sourceAssets.failureReason} is distinct from ${failureReason}`
      )
    ));
    await tx.insert(transcripts).values({
      userId: source.userId,
      sourceAssetId: source.id,
      status: TranscriptStatus.FAILED,
      failureReason,
    }).onConflictDoUpdate({
      target: transcripts.sourceAssetId,
      set: {
        status: TranscriptStatus.FAILED,
        failureReason,
        updatedAt: now,
      },
    });
    await createTranscriptFailedNotification(source.id, tx);
  }
  if (transcript?.status === TranscriptStatus.READY && hasPersistedTranscript) {
    await createTranscriptReadyNotification(source.id, tx);
  }
}

async function enqueueCurrentGeneration(
  tx: DbTransaction,
  pack: typeof contentPacks.$inferSelect,
  generationRunId: string,
  reconciliationRebuild?: GenerateShortFormPackJobPayload['reconciliationRebuild']
) {
  const payload: GenerateShortFormPackJobPayload = {
    contentPackId: pack.id,
    sourceAssetId: pack.sourceAssetId,
    transcriptId: pack.transcriptId ?? undefined,
    userId: pack.userId,
    generationRunId,
    ...(reconciliationRebuild ? { reconciliationRebuild } : {}),
  };
  return await insertOrReuseReconciliationJob({
    type: JobType.GENERATE_SHORT_FORM_PACK,
    status: JobStatus.PENDING,
    idempotencyKey: buildJobIdempotencyKey(JobType.GENERATE_SHORT_FORM_PACK, payload),
    payload,
  }, tx);
}

async function ensureCandidateFacecamJob(
  tx: DbTransaction,
  candidate: typeof clipCandidates.$inferSelect
) {
  const [insertedRun] = await tx.insert(clipCandidateFacecamDetectionRuns).values({
    userId: candidate.userId,
    sourceAssetId: candidate.sourceAssetId,
    contentPackId: candidate.contentPackId,
    clipCandidateId: candidate.id,
    generationRunId: candidate.generationRunId,
    detectorVersion: FACECAM_DETECTOR_VERSION,
    startTimeMs: candidate.startTimeMs,
    endTimeMs: candidate.endTimeMs,
    status: FacecamDetectionStatus.PENDING,
  }).onConflictDoNothing().returning();
  const run = insertedRun ?? await tx.query.clipCandidateFacecamDetectionRuns.findFirst({
    where: and(
      eq(clipCandidateFacecamDetectionRuns.sourceAssetId, candidate.sourceAssetId),
      eq(clipCandidateFacecamDetectionRuns.clipCandidateId, candidate.id),
      eq(clipCandidateFacecamDetectionRuns.generationRunId, candidate.generationRunId),
      eq(clipCandidateFacecamDetectionRuns.startTimeMs, candidate.startTimeMs),
      eq(clipCandidateFacecamDetectionRuns.endTimeMs, candidate.endTimeMs),
      eq(clipCandidateFacecamDetectionRuns.detectorVersion, FACECAM_DETECTOR_VERSION)
    ),
  });
  if (!run) throw new Error('Facecam reconciliation run identity could not be resolved.');
  const identity = buildCandidateFacecamIdempotencyKey({
    sourceAssetId: candidate.sourceAssetId,
    clipCandidateId: candidate.id,
    startTimeMs: candidate.startTimeMs,
    endTimeMs: candidate.endTimeMs,
    detectorVersion: FACECAM_DETECTOR_VERSION,
  });
  const payload: DetectClipFacecamJobPayload = {
    sourceAssetId: candidate.sourceAssetId,
    userId: candidate.userId,
    contentPackId: candidate.contentPackId,
    clipCandidateId: candidate.id,
    generationRunId: candidate.generationRunId,
    startTimeMs: candidate.startTimeMs,
    endTimeMs: candidate.endTimeMs,
    detectorVersion: FACECAM_DETECTOR_VERSION,
    detectionRunId: run.id,
  };
  const job = await insertOrReuseReconciliationJob({
    type: JobType.DETECT_CLIP_FACECAM,
    status: JobStatus.PENDING,
    idempotencyKey: identity,
    payload,
  }, tx);
  if (run.jobId !== job.id) {
    await tx.update(clipCandidateFacecamDetectionRuns).set({
      jobId: job.id,
      updatedAt: new Date(),
    }).where(eq(clipCandidateFacecamDetectionRuns.id, run.id));
  }
  if (candidate.facecamDetectionStatus === FacecamDetectionStatus.NOT_STARTED) {
    await tx.update(clipCandidates).set({
      facecamDetectionStatus: FacecamDetectionStatus.PENDING,
      updatedAt: new Date(),
    }).where(eq(clipCandidates.id, candidate.id));
  }
  return { run, job, identity };
}

async function reconcileRenderConfig(
  tx: DbTransaction,
  graph: NonNullable<Awaited<ReturnType<typeof lockProjectGraph>>>,
  pack: typeof contentPacks.$inferSelect,
  candidate: typeof clipCandidates.$inferSelect,
  config: typeof clipEditConfigs.$inferSelect | typeof clipRenderConfigs.$inferSelect,
  events: PipelineReconciliationEvent[]
) {
  const variant = getRenderedClipVariantForEditConfig(config);
  const renderConfigId = 'configVersion' in config ? undefined : config.id;
  const editConfigId = 'configVersion' in config ? config.id : undefined;
  const payload: FormatRenderedClipShortFormJobPayload = {
    clipCandidateId: candidate.id,
    contentPackId: pack.id,
    sourceAssetId: pack.sourceAssetId,
    userId: pack.userId,
    generationRunId: pack.generationRunId,
    renderConfigId,
    editConfigId,
    variant,
    layout: config.layout as FormatRenderedClipShortFormJobPayload['layout'],
    captionsEnabled: config.captionsEnabled,
    captionFontAssetId: config.captionFontAssetId ?? undefined,
    editConfigHash: config.configHash,
  };
  const identity = buildJobIdempotencyKey(JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, payload);
  const artifact = graph.clips.find((clip) =>
    clip.clipCandidateId === candidate.id &&
    clip.generationRunId === pack.generationRunId &&
    clip.variant === variant &&
    clip.layout === config.layout &&
    clip.editConfigHash === config.configHash &&
    (renderConfigId
      ? clip.clipRenderConfigId === renderConfigId
      : clip.editConfigId === editConfigId)
  );
  const durableJob = graph.jobs.find((job) => {
    if (job.type !== JobType.FORMAT_RENDERED_CLIP_SHORT_FORM) return false;
    const candidatePayload = parseJobPayloadForType(job.type, job.payload);
    if (!candidatePayload || !('clipCandidateId' in candidatePayload)) return false;
    const validated = candidatePayload as FormatRenderedClipShortFormJobPayload;
    return validated.clipCandidateId === payload.clipCandidateId &&
      validated.contentPackId === payload.contentPackId &&
      validated.sourceAssetId === payload.sourceAssetId &&
      validated.userId === payload.userId &&
      validated.generationRunId === payload.generationRunId &&
      validated.renderConfigId === payload.renderConfigId &&
      validated.editConfigId === payload.editConfigId &&
      (validated.variant ?? 'vertical_short_form') === (payload.variant ?? 'vertical_short_form') &&
      (validated.layout ?? 'default') === (payload.layout ?? 'default') &&
      validated.editConfigHash === payload.editConfigHash;
  });
  const decision = decideRenderReconciliation({
    projectDeleting: Boolean(graph.project.deletionRequestedAt),
    sourceDeleting: Boolean(graph.sources.find((source) => source.id === pack.sourceAssetId)?.deletionRequestedAt),
    sourceDeleted: Boolean(graph.sources.find((source) => source.id === pack.sourceAssetId)?.deletedAt),
    sourceExpired: graph.sources.find((source) => source.id === pack.sourceAssetId)?.retentionStatus === MediaRetentionStatus.EXPIRED,
    mediaAvailable: Boolean(graph.sources.find((source) => source.id === pack.sourceAssetId && isSourceMediaAvailable(source))),
    currentGeneration: candidate.generationRunId === pack.generationRunId && config.generationRunId === pack.generationRunId,
    artifactStatus: (artifact?.status ?? 'missing') as 'missing' | 'pending' | 'rendering' | 'ready' | 'failed',
    jobStatus: jobStatus(durableJob),
    packProjectionComplete: [ContentPackStatus.READY, ContentPackStatus.PARTIALLY_READY, ContentPackStatus.FAILED].includes(pack.status as ContentPackStatus),
  });
  events.push(event(graph.project.id, decision.action, decision.reason, {
    sourceAssetId: pack.sourceAssetId,
    contentPackId: pack.id,
    clipCandidateId: candidate.id,
    durableIdentity: identity,
  }));

  if (decision.action === 'enqueue') {
    const created = await insertOrReuseReconciliationJob({
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      status: JobStatus.PENDING,
      idempotencyKey: identity,
      payload,
    }, tx);
    graph.jobs.push(created);
  } else if (decision.action === 'terminalize' && !artifact) {
    const [failedArtifact] = await tx.insert(renderedClips).values({
      userId: candidate.userId,
      contentPackId: pack.id,
      sourceAssetId: candidate.sourceAssetId,
      clipCandidateId: candidate.id,
      generationRunId: pack.generationRunId,
      variant,
      layout: config.layout,
      editConfigId: 'configVersion' in config ? config.id : null,
      clipRenderConfigId: renderConfigId ?? null,
      editConfigVersion: 'configVersion' in config ? config.configVersion : null,
      editConfigHash: config.configHash,
      status: RenderedClipStatus.FAILED,
      title: candidate.title,
      startTimeMs: candidate.startTimeMs,
      endTimeMs: candidate.endTimeMs,
      durationMs: candidate.durationMs,
      failureReason: INCONSISTENT_RENDER_REASON,
    }).onConflictDoNothing().returning();
    if (failedArtifact) {
      graph.clips.push(failedArtifact);
      await createRenderedClipFailedNotification(failedArtifact.id, tx);
    }
  }
  if (artifact?.status === RenderedClipStatus.READY) {
    await createRenderedClipReadyNotification(artifact.id, tx);
  } else if (artifact?.status === RenderedClipStatus.FAILED) {
    await createRenderedClipFailedNotification(artifact.id, tx);
  }
}

async function reconcilePack(
  tx: DbTransaction,
  graph: NonNullable<Awaited<ReturnType<typeof lockProjectGraph>>>,
  pack: typeof contentPacks.$inferSelect,
  events: PipelineReconciliationEvent[]
) {
  if (pack.kind !== ContentPackKind.SHORT_FORM_CLIPS) return;
  const source = graph.sources.find((candidate) => candidate.id === pack.sourceAssetId);
  if (!source) return;
  const transcript = await tx.query.transcripts.findFirst({
    where: eq(transcripts.sourceAssetId, source.id),
  });
  const currentCandidates = graph.candidates.filter((candidate) =>
    candidate.contentPackId === pack.id && candidate.generationRunId === pack.generationRunId
  );
  const generationJobs = graph.jobs.flatMap((job) => {
    if (job.type !== JobType.GENERATE_SHORT_FORM_PACK) return [];
    const payload = parseJobPayloadForType(job.type, job.payload);
    return payload && 'contentPackId' in payload &&
      (payload as GenerateShortFormPackJobPayload).contentPackId === pack.id &&
      (payload as GenerateShortFormPackJobPayload).sourceAssetId === pack.sourceAssetId &&
      (payload as GenerateShortFormPackJobPayload).userId === pack.userId
      ? [{ job, payload: payload as GenerateShortFormPackJobPayload }]
      : [];
  });
  const identityPayload: GenerateShortFormPackJobPayload = {
    contentPackId: pack.id,
    sourceAssetId: pack.sourceAssetId,
    transcriptId: pack.transcriptId ?? undefined,
    userId: pack.userId,
    generationRunId: pack.generationRunId,
  };
  const identity = buildJobIdempotencyKey(JobType.GENERATE_SHORT_FORM_PACK, identityPayload);
  const durableJob = generationJobs.find(({ job, payload }) =>
    job.idempotencyKey === identity &&
    payload.generationRunId === pack.generationRunId
  )?.job;
  const missingCandidateEvidence = graph.jobs.some((job) => {
    if (
      ![
        JobType.RENDER_CLIP_CANDIDATE,
        JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        JobType.DETECT_CLIP_FACECAM,
      ].includes(job.type as JobType) ||
      job.status !== JobStatus.CANCELLED ||
      job.cancellationReason !== 'clip_candidate_missing'
    ) return false;
    const payload = parseJobPayloadForType(job.type, job.payload);
    if (!payload || !('clipCandidateId' in payload)) return false;
    const validated = payload as RenderClipCandidateJobPayload | FormatRenderedClipShortFormJobPayload | DetectClipFacecamJobPayload;
    return validated.userId === pack.userId &&
      validated.sourceAssetId === pack.sourceAssetId &&
      validated.contentPackId === pack.id &&
      validated.generationRunId === pack.generationRunId &&
      typeof validated.clipCandidateId === 'number' && validated.clipCandidateId > 0;
  });
  const rebuildConsumed = generationJobs.some(({ payload }) =>
    payload.reconciliationRebuild?.reason === 'clip_candidate_missing' &&
    payload.reconciliationRebuild.originalGenerationRunId.length > 0
  );
  const decision = decideGenerationReconciliation({
    projectDeleting: Boolean(graph.project.deletionRequestedAt),
    sourceDeleting: Boolean(source.deletionRequestedAt),
    sourceDeleted: Boolean(source.deletedAt || source.storageDeletedAt),
    sourceExpired: source.retentionStatus === MediaRetentionStatus.EXPIRED,
    mediaAvailable: isSourceMediaAvailable(source),
    currentGeneration: true,
    packStatus: pack.status as 'pending' | 'generating' | 'ready' | 'partially_ready' | 'failed',
    transcriptReady: transcript?.status === TranscriptStatus.READY,
    jobStatus: jobStatus(durableJob),
    hasCurrentOutput: currentCandidates.length > 0,
    hasMissingCandidateCancellation:
      missingCandidateEvidence &&
      durableJob?.status === JobStatus.COMPLETED &&
      !durableJob.cancellationRequestedAt,
    rebuildConsumed,
  });
  events.push(event(graph.project.id, decision.action, decision.reason, {
    sourceAssetId: source.id,
    contentPackId: pack.id,
    durableIdentity: identity,
  }));

  if (decision.action === 'enqueue') {
    const created = await enqueueCurrentGeneration(tx, pack, pack.generationRunId);
    graph.jobs.push(created);
    if (pack.status !== ContentPackStatus.GENERATING || pack.failureReason) {
      await tx.update(contentPacks).set({
        status: ContentPackStatus.GENERATING,
        failureReason: null,
        updatedAt: new Date(),
      }).where(eq(contentPacks.id, pack.id));
      pack.status = ContentPackStatus.GENERATING;
      pack.failureReason = null;
    }
  } else if (decision.action === 'rebuild') {
    const originalGenerationRunId = pack.generationRunId;
    const generationRunId = createGenerationRunId();
    await tx.update(contentPacks).set({
      generationRunId,
      status: ContentPackStatus.GENERATING,
      failureReason: null,
      updatedAt: new Date(),
    }).where(eq(contentPacks.id, pack.id));
    pack.generationRunId = generationRunId;
    pack.status = ContentPackStatus.GENERATING;
    pack.failureReason = null;
    const created = await enqueueCurrentGeneration(tx, pack, generationRunId, {
      originalGenerationRunId,
      reason: 'clip_candidate_missing',
    });
    graph.jobs.push(created);
  } else if (decision.action === 'terminalize') {
    const failureReason = decision.reason === 'generation_missing_candidate_rebuild_consumed'
      ? REBUILD_CONSUMED_REASON
      : INCONSISTENT_GENERATION_REASON;
    if (pack.status !== ContentPackStatus.FAILED || pack.failureReason !== failureReason) {
      await tx.update(contentPacks).set({
        status: ContentPackStatus.FAILED,
        failureReason,
        updatedAt: new Date(),
      }).where(eq(contentPacks.id, pack.id));
      pack.status = ContentPackStatus.FAILED;
      pack.failureReason = failureReason;
      await createShortFormPackFailedNotification(pack.id, tx);
    }
    return;
  }

  if (currentCandidates.length === 0 || decision.action === 'rebuild') {
    if (pack.status === ContentPackStatus.FAILED) {
      await createShortFormPackFailedNotification(pack.id, tx);
    }
    return;
  }
  await ensureDefaultClipEditConfigs(currentCandidates, undefined, tx);

  for (const candidate of currentCandidates) {
    if (isUploadedVideo(source)) {
      const facecamIdentity = buildCandidateFacecamIdempotencyKey({
        sourceAssetId: candidate.sourceAssetId,
        clipCandidateId: candidate.id,
        startTimeMs: candidate.startTimeMs,
        endTimeMs: candidate.endTimeMs,
        detectorVersion: FACECAM_DETECTOR_VERSION,
      });
      const facecamJob = graph.jobs.find((job) => {
        if (job.type !== JobType.DETECT_CLIP_FACECAM) return false;
        const payload = parseJobPayloadForType(job.type, job.payload);
        if (!payload || !('clipCandidateId' in payload)) return false;
        const validated = payload as DetectClipFacecamJobPayload;
        return validated.clipCandidateId === candidate.id &&
          validated.contentPackId === pack.id &&
          validated.sourceAssetId === source.id &&
          validated.userId === candidate.userId &&
          validated.generationRunId === pack.generationRunId &&
          validated.detectorVersion === FACECAM_DETECTOR_VERSION &&
          validated.startTimeMs === candidate.startTimeMs &&
          validated.endTimeMs === candidate.endTimeMs;
      });
      const facecamPayload = facecamJob
        ? parseJobPayloadForType(facecamJob.type, facecamJob.payload) as DetectClipFacecamJobPayload | null
        : null;
      const run = graph.detectionRuns.find((item) =>
        item.id === (facecamPayload && 'detectionRunId' in facecamPayload
          ? facecamPayload.detectionRunId
          : -1) &&
        item.userId === candidate.userId &&
        item.sourceAssetId === source.id &&
        item.contentPackId === pack.id &&
        item.clipCandidateId === candidate.id &&
        item.generationRunId === pack.generationRunId &&
        item.detectorVersion === FACECAM_DETECTOR_VERSION &&
        item.startTimeMs === candidate.startTimeMs &&
        item.endTimeMs === candidate.endTimeMs
      ) ?? (!facecamJob ? graph.detectionRuns.find((item) =>
        item.userId === candidate.userId &&
        item.sourceAssetId === source.id &&
        item.contentPackId === pack.id &&
        item.clipCandidateId === candidate.id &&
        item.generationRunId === pack.generationRunId &&
        item.detectorVersion === FACECAM_DETECTOR_VERSION &&
        item.startTimeMs === candidate.startTimeMs &&
        item.endTimeMs === candidate.endTimeMs
      ) : undefined);
      const facecamDecision = decideFacecamReconciliation({
        projectDeleting: Boolean(graph.project.deletionRequestedAt),
        sourceDeleting: Boolean(source.deletionRequestedAt),
        sourceDeleted: Boolean(source.deletedAt || source.storageDeletedAt),
        sourceExpired: source.retentionStatus === MediaRetentionStatus.EXPIRED,
        mediaAvailable: isSourceMediaAvailable(source),
        currentGeneration: candidate.generationRunId === pack.generationRunId,
        required: true,
        candidateStatus: candidate.facecamDetectionStatus as 'not_started' | 'pending' | 'detecting' | 'ready' | 'not_found' | 'failed',
        jobStatus: jobStatus(facecamJob),
        terminalRun: Boolean(run && isTerminalFacecamStatus(run.status)),
        terminalProjectionComplete: Boolean(run &&
          isTerminalFacecamStatus(candidate.facecamDetectionStatus)),
      });
      if (facecamDecision.action === 'replay_projection' ||
        (facecamDecision.action === 'noop' && facecamDecision.reason === 'facecam_terminal')) {
        if (!run) throw new Error('Facecam policy selected a terminal run without durable identity.');
        const currentEditConfig = await tx.query.clipEditConfigs.findFirst({
          where: and(
            eq(clipEditConfigs.clipCandidateId, candidate.id),
            eq(clipEditConfigs.generationRunId, pack.generationRunId)
          ),
        });
        const currentRenderConfigs = await tx.query.clipRenderConfigs.findMany({
          where: and(
            eq(clipRenderConfigs.clipCandidateId, candidate.id),
            eq(clipRenderConfigs.generationRunId, pack.generationRunId)
          ),
        });
        const effectiveConfigs = currentRenderConfigs.length > 0
          ? currentRenderConfigs
          : currentEditConfig ? [currentEditConfig] : [];
        const projectionComplete =
          isTerminalFacecamStatus(candidate.facecamDetectionStatus) &&
          effectiveConfigs.length > 0 &&
          effectiveConfigs.every((config) => {
            const payload: FormatRenderedClipShortFormJobPayload = {
              clipCandidateId: candidate.id,
              contentPackId: pack.id,
              sourceAssetId: source.id,
              userId: pack.userId,
              generationRunId: pack.generationRunId,
              renderConfigId: 'configVersion' in config ? undefined : config.id,
              editConfigId: 'configVersion' in config ? config.id : undefined,
              variant: getRenderedClipVariantForEditConfig(config),
              layout: config.layout as FormatRenderedClipShortFormJobPayload['layout'],
              captionsEnabled: config.captionsEnabled,
              captionFontAssetId: config.captionFontAssetId ?? undefined,
              editConfigHash: config.configHash,
            };
            const renderIdentity = buildJobIdempotencyKey(
              JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
              payload
            );
            return graph.jobs.some((job) => job.idempotencyKey === renderIdentity) ||
              graph.clips.some((clip) =>
                clip.clipCandidateId === candidate.id &&
                clip.generationRunId === pack.generationRunId &&
                clip.variant === payload.variant &&
                clip.layout === payload.layout &&
                clip.editConfigHash === config.configHash &&
                (payload.renderConfigId
                  ? clip.clipRenderConfigId === payload.renderConfigId
                  : clip.editConfigId === payload.editConfigId)
              );
          });
        if (!projectionComplete) {
          await replayCandidateFacecamTerminalProjection({
            candidate,
            detectionRunId: run.id,
            status: run.status as FacecamDetectionStatus,
            failureReason: run.failureReason,
            debugReason: run.debugReason,
            executor: tx,
          });
        }
        await createFacecamDetectionNotification(candidate.id, run.id, tx);
        events.push(event(
          graph.project.id,
          projectionComplete ? 'noop' : 'replay_projection',
          projectionComplete ? 'facecam_terminal' : 'facecam_terminal_projection_replay',
          {
          sourceAssetId: source.id,
          contentPackId: pack.id,
          clipCandidateId: candidate.id,
          durableIdentity: facecamIdentity,
          }
        ));
      } else if (facecamDecision.action === 'terminalize') {
        const terminalStatus = FacecamDetectionStatus.FAILED;
        if (run) {
          await tx.update(clipCandidateFacecamDetectionRuns).set({
            status: terminalStatus,
            failureReason: 'pipeline_reconciliation:facecam_terminal_result_missing',
            completedAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(clipCandidateFacecamDetectionRuns.id, run.id));
        }
        if (!run) {
          events.push(event(graph.project.id, 'terminalize', 'facecam_terminal_result_missing', {
            sourceAssetId: source.id,
            contentPackId: pack.id,
            clipCandidateId: candidate.id,
            durableIdentity: facecamIdentity,
          }));
          continue;
        }
        await replayCandidateFacecamTerminalProjection({
          candidate,
          detectionRunId: run.id,
          status: terminalStatus,
          failureReason: 'pipeline_reconciliation:facecam_terminal_result_missing',
          executor: tx,
        });
        events.push(event(graph.project.id, 'terminalize', 'facecam_terminal_result_missing', {
          sourceAssetId: source.id,
          contentPackId: pack.id,
          clipCandidateId: candidate.id,
          durableIdentity: facecamIdentity,
        }));
      } else if (facecamDecision.action === 'enqueue') {
        const queued = await ensureCandidateFacecamJob(tx, candidate);
        graph.jobs.push(queued.job);
        events.push(event(graph.project.id, 'enqueue', 'facecam_job_missing', {
          sourceAssetId: source.id,
          contentPackId: pack.id,
          clipCandidateId: candidate.id,
          durableIdentity: queued.identity,
        }));
      } else {
        events.push(event(graph.project.id, facecamDecision.action, facecamDecision.reason, {
          sourceAssetId: source.id,
          contentPackId: pack.id,
          clipCandidateId: candidate.id,
          durableIdentity: facecamIdentity,
        }));
      }
    }

    const editConfig = await tx.query.clipEditConfigs.findFirst({
      where: eq(clipEditConfigs.clipCandidateId, candidate.id),
    });
    if (!editConfig) continue;
    if (isUploadedVideo(source) && !isTerminalFacecamStatus(candidate.facecamDetectionStatus)) {
      continue;
    }
    const createdRenderConfigs = await createRenderableRenderConfigsForEditConfig(editConfig, tx);
    const allRenderConfigs = await tx.query.clipRenderConfigs.findMany({
      where: and(
        eq(clipRenderConfigs.clipCandidateId, candidate.id),
        eq(clipRenderConfigs.generationRunId, pack.generationRunId)
      ),
      orderBy: (table, { asc }) => [asc(table.id)],
    });
    const effectiveConfigs = allRenderConfigs.length > 0
      ? allRenderConfigs
      : createdRenderConfigs.length > 0 ? createdRenderConfigs : [editConfig];
    for (const config of effectiveConfigs) {
      await reconcileRenderConfig(tx, graph, pack, candidate, config, events);
    }
  }

  const latestEditConfigs = await tx.query.clipEditConfigs.findMany({
    where: inArray(clipEditConfigs.clipCandidateId, currentCandidates.map((candidate) => candidate.id)),
  });
  const latestRenderConfigs = await tx.query.clipRenderConfigs.findMany({
    where: and(
      inArray(clipRenderConfigs.clipCandidateId, currentCandidates.map((candidate) => candidate.id)),
      eq(clipRenderConfigs.generationRunId, pack.generationRunId)
    ),
  });
  const latestArtifacts = await tx.query.renderedClips.findMany({
    where: and(
      eq(renderedClips.contentPackId, pack.id),
      eq(renderedClips.generationRunId, pack.generationRunId)
    ),
  });
  const requiredConfigs = currentCandidates.flatMap((candidate) => {
    const render = latestRenderConfigs.filter((config) => config.clipCandidateId === candidate.id);
    return render.length > 0
      ? render
      : latestEditConfigs.filter((config) => config.clipCandidateId === candidate.id);
  });
  let ready = 0;
  let terminalFailed = 0;
  let activeRepairable = 0;
  for (const config of requiredConfigs) {
    const variant = getRenderedClipVariantForEditConfig(config);
    const artifact = latestArtifacts.find((clip) =>
      clip.clipCandidateId === config.clipCandidateId &&
      clip.variant === variant &&
      clip.layout === config.layout &&
      clip.editConfigHash === config.configHash &&
      ('configVersion' in config
        ? clip.editConfigId === config.id
        : clip.clipRenderConfigId === config.id)
    );
    if (artifact?.status === RenderedClipStatus.READY) ready += 1;
    else if (artifact?.status === RenderedClipStatus.FAILED) terminalFailed += 1;
    else activeRepairable += 1;
  }
  const finalization = decidePackFinalization({
    ready,
    terminalFailed,
    activeRepairable,
    required: requiredConfigs.length,
    currentStatus: pack.status as 'pending' | 'generating' | 'ready' | 'partially_ready' | 'failed',
  });
  events.push(event(graph.project.id, finalization.action, finalization.reason, {
    sourceAssetId: source.id,
    contentPackId: pack.id,
    durableIdentity: `generation:${pack.generationRunId}`,
  }));
  if (finalization.action !== 'noop') {
    const status = finalization.action.replace('set_', '') as ContentPackStatus;
    const failureReason = status === ContentPackStatus.FAILED
      ? 'pipeline_reconciliation:pack_outputs_failed'
      : null;
    await tx.update(contentPacks).set({ status, failureReason, updatedAt: new Date() })
      .where(eq(contentPacks.id, pack.id));
    pack.status = status;
    pack.failureReason = failureReason;
  }
  if (pack.status === ContentPackStatus.READY || pack.status === ContentPackStatus.PARTIALLY_READY) {
    await createShortFormPackReadyNotification(pack.id, tx);
  } else if (pack.status === ContentPackStatus.FAILED) {
    await createShortFormPackFailedNotification(pack.id, tx);
  }
}

export async function reconcileProjectPipeline(projectId: number) {
  return await db.transaction(async (tx) => {
    const graph = await lockProjectGraph(tx, projectId);
    if (!graph) return [];
    const events: PipelineReconciliationEvent[] = [];
    for (const malformedJob of graph.malformedJobs) {
      events.push(event(projectId, 'refuse', 'job_payload_malformed', {
        durableIdentity: `job:${malformedJob.id}`,
      }));
    }

    if (graph.project.deletionRequestedAt) {
      events.push(event(projectId, 'refuse', 'project_deleting'));
      return events;
    }
    for (const source of graph.sources) {
      await reconcileSource(tx, graph, source, events);
    }
    for (const pack of graph.packs) {
      await reconcilePack(tx, graph, pack, events);
    }
    return events;
  });
}

export async function reconcilePipelinePage(params: {
  afterProjectId?: number;
  pageSize?: number;
} = {}) {
  const pageSize = normalizeReconciliationPageSize(params.pageSize);
  const afterProjectId = normalizeReconciliationCursor(params.afterProjectId);
  const rows = await db.select({ id: projects.id })
    .from(projects)
    .where(afterProjectId === undefined ? undefined : gt(projects.id, afterProjectId))
    .orderBy(asc(projects.id))
    .limit(pageSize + 1);
  const selected = rows.slice(0, pageSize);
  const events: PipelineReconciliationEvent[] = [];
  for (const project of selected) {
    events.push(...await reconcileProjectPipeline(project.id));
  }
  return {
    projectIds: selected.map((project) => project.id),
    events,
    nextAfterProjectId: rows.length > pageSize ? selected.at(-1)?.id ?? null : null,
  };
}
