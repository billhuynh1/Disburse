'use server';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validatedActionWithUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetections,
  clipCandidates,
  contentPacks,
  ClipCandidateReviewStatus,
  ContentPackKind,
  ContentPackStatus,
  generatedAssets,
  jobs,
  JobStatus,
  JobType,
  projects,
  RenderedClipVariant,
  renderedClips,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  transcripts,
  transcriptSegments,
  TranscriptStatus,
  users,
  voiceProfiles
} from '@/lib/db/schema';
import { deleteStorageObject } from '@/lib/disburse/s3-storage';
import {
  autoSaveApprovedClipMedia,
  assertMediaAvailable,
  saveApprovedClipMedia,
  saveProjectSourceMedia,
} from '@/lib/disburse/media-retention-service';
import {
  enqueueDetectClipFacecamJob,
  enqueueFormatRenderedClipShortFormJob,
  enqueueRenderClipJob,
  enqueueShortFormPackJob,
  enqueueYoutubeIngestionJob,
} from '@/lib/disburse/job-service';
import { ensureFacecamDetectionPending } from '@/lib/disburse/facecam-detection-service';
import { ensureRenderedClipPending } from '@/lib/disburse/rendered-clip-service';
import { ensureShortFormContentPack } from '@/lib/disburse/short-form-service';

const optionalTextField = (maxLength: number) =>
  z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return value;
      }

      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
    z.string().max(maxLength).optional()
  );

const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(150),
  description: optionalTextField(5000)
});

export const createProject = validatedActionWithUser(
  createProjectSchema,
  async (data, _, user) => {
    const [project] = await db
      .insert(projects)
      .values({
        userId: user.id,
        name: data.name,
        description: data.description
      })
      .returning();

    return {
      success: 'Project created successfully.',
      project
    };
  }
);

const sourceAssetTypeSchema = z.enum([
  SourceAssetType.UPLOADED_FILE,
  SourceAssetType.YOUTUBE_URL,
  SourceAssetType.PASTED_TRANSCRIPT
]);

const createSourceAssetSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  title: z.string().trim().min(1, 'Title is required').max(150),
  assetType: sourceAssetTypeSchema,
  originalFilename: optionalTextField(255),
  mimeType: optionalTextField(100),
  storageUrl: optionalTextField(5000),
  sourceUrl: optionalTextField(5000),
  transcriptContent: optionalTextField(20000),
  transcriptLanguage: optionalTextField(20)
});

export const createSourceAsset = validatedActionWithUser(
  createSourceAssetSchema,
  async (data, _, user) => {
    if (data.assetType === SourceAssetType.UPLOADED_FILE) {
      return {
        error: 'Use the direct upload flow for uploaded files.'
      };
    }

    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, data.projectId), eq(projects.userId, user.id))
      )
      .limit(1);

    if (!project) {
      return { error: 'Project not found.' };
    }

    const derivedStorageUrl =
      data.assetType === SourceAssetType.YOUTUBE_URL
        ? data.sourceUrl
        : `placeholder://pasted-transcript/${project.id}/${Date.now()}`;

    if (!derivedStorageUrl) {
      return {
        error:
          data.assetType === SourceAssetType.YOUTUBE_URL
            ? 'A YouTube URL is required.'
            : 'Source asset metadata is incomplete.'
      };
    }

    if (
      data.assetType === SourceAssetType.PASTED_TRANSCRIPT &&
      !data.transcriptContent
    ) {
      return { error: 'Transcript text is required for pasted transcript placeholders.' };
    }

    const sourceAssetStatus =
      data.assetType === SourceAssetType.PASTED_TRANSCRIPT
        ? SourceAssetStatus.READY
        : SourceAssetStatus.UPLOADED;

    const [sourceAsset] = await db
      .insert(sourceAssets)
      .values({
        userId: user.id,
        projectId: data.projectId,
        title: data.title,
        assetType: data.assetType,
        originalFilename: data.originalFilename,
        mimeType:
          data.mimeType ||
          (data.assetType === SourceAssetType.PASTED_TRANSCRIPT
            ? 'text/plain'
            : null),
        storageUrl: derivedStorageUrl,
        status: sourceAssetStatus
      })
      .returning();

    let transcript = null;

    if (
      data.assetType === SourceAssetType.PASTED_TRANSCRIPT &&
      data.transcriptContent
    ) {
      [transcript] = await db
        .insert(transcripts)
        .values({
          userId: user.id,
          sourceAssetId: sourceAsset.id,
          language: data.transcriptLanguage || 'en',
          content: data.transcriptContent,
          status: TranscriptStatus.READY
        })
        .returning();
    }

    if (data.assetType === SourceAssetType.YOUTUBE_URL) {
      await enqueueYoutubeIngestionJob(sourceAsset.id, user.id);
    }

    return {
      success: 'Source asset created successfully.',
      sourceAsset,
      transcript
    };
  }
);

const createContentPackSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  sourceAssetId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, 'Content pack name is required').max(150),
  instructions: optionalTextField(5000)
});

export const createContentPack = validatedActionWithUser(
  createContentPackSchema,
  async (data, _, user) => {
    const [sourceAsset] = await db
      .select({
        id: sourceAssets.id,
        projectId: sourceAssets.projectId
      })
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.id, data.sourceAssetId),
          eq(sourceAssets.projectId, data.projectId),
          eq(sourceAssets.userId, user.id)
        )
      )
      .limit(1);

    if (!sourceAsset) {
      return { error: 'Source asset not found for this project.' };
    }

    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, data.projectId), eq(projects.userId, user.id))
      )
      .limit(1);

    if (!project) {
      return { error: 'Project not found.' };
    }

    const [transcript] = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .where(
        and(
          eq(transcripts.sourceAssetId, data.sourceAssetId),
          eq(transcripts.userId, user.id)
        )
      )
      .limit(1);

    const [contentPack] = await db
      .insert(contentPacks)
      .values({
        userId: user.id,
        projectId: data.projectId,
        sourceAssetId: data.sourceAssetId,
        transcriptId: transcript?.id ?? null,
        kind: ContentPackKind.GENERAL,
        name: data.name,
        instructions: data.instructions,
        status: ContentPackStatus.PENDING
      })
      .returning();

    return {
      success: 'Content pack created successfully.',
      contentPack
    };
  }
);

const saveProjectSchema = z.object({
  projectId: z.coerce.number().int().positive()
});

export const saveProject = validatedActionWithUser(
  saveProjectSchema,
  async (data, _, user) => {
    try {
      const result = await saveProjectSourceMedia(data.projectId, user.id);

      return {
        success:
          result.savedCount > 0
            ? 'Project media saved.'
            : 'Project marked saved.',
        savedCount: result.savedCount,
        savedBytes: result.savedBytes
      };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : 'Project could not be saved.'
      };
    }
  }
);

const deleteSourceAssetSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  sourceAssetId: z.coerce.number().int().positive()
});

export const deleteSourceAsset = validatedActionWithUser(
  deleteSourceAssetSchema,
  async (data, _, user) => {
    const sourceAsset = await db.query.sourceAssets.findFirst({
      where: and(
        eq(sourceAssets.id, data.sourceAssetId),
        eq(sourceAssets.projectId, data.projectId),
        eq(sourceAssets.userId, user.id)
      ),
      with: {
        transcript: true,
        contentPacks: {
          with: {
            generatedAssets: true
          }
        }
      }
    });

    if (!sourceAsset) {
      return { error: 'Source asset not found for this project.' };
    }

    if (sourceAsset.contentPacks.length > 0) {
      return {
        error:
          'This source asset is linked to one or more content packs. Remove those content packs before deleting the asset.'
      };
    }

    const relatedJobs = await db.query.jobs.findMany({
      where: and(
        inArray(jobs.type, [
          JobType.TRANSCRIBE_SOURCE_ASSET,
          JobType.INGEST_YOUTUBE_SOURCE_ASSET
        ]),
        sql<boolean>`payload->>'sourceAssetId' = ${String(sourceAsset.id)}`
      )
    });

    const hasProcessingJob = relatedJobs.some(
      (job) => job.status === JobStatus.PROCESSING
    );

    if (hasProcessingJob) {
      return {
        error:
          'This source asset is currently being processed. Wait for transcription to finish before deleting it.'
      };
    }

    if (
      sourceAsset.assetType === SourceAssetType.UPLOADED_FILE &&
      sourceAsset.storageKey
    ) {
      try {
        await deleteStorageObject(sourceAsset.storageKey);
      } catch (error) {
        return {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to delete the uploaded file from storage.'
        };
      }
    }

    await db.transaction(async (tx) => {
      const deletableJobIds = relatedJobs
        .filter((job) => job.status !== JobStatus.PROCESSING)
        .map((job) => job.id);

      if (deletableJobIds.length > 0) {
        await tx
          .delete(jobs)
          .where(inArray(jobs.id, deletableJobIds));
      }

      if (sourceAsset.transcript) {
        await tx
          .delete(transcriptSegments)
          .where(eq(transcriptSegments.transcriptId, sourceAsset.transcript.id));

        await tx
          .delete(transcripts)
          .where(eq(transcripts.id, sourceAsset.transcript.id));
      }

      await tx
        .delete(sourceAssets)
        .where(eq(sourceAssets.id, sourceAsset.id));
    });

    return {
      success: 'Source asset deleted successfully.'
    };
  }
);

const deleteProjectSchema = z.object({
  projectId: z.coerce.number().int().positive()
});

export const deleteProject = validatedActionWithUser(
  deleteProjectSchema,
  async (data, _, user) => {
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, data.projectId), eq(projects.userId, user.id)),
      with: {
        sourceAssets: {
          with: {
            transcript: true
          }
        },
        contentPacks: {
          with: {
            clipCandidates: {
              with: {
                renderedClips: true,
                facecamDetections: true
              }
            },
            renderedClips: true,
            generatedAssets: true
          }
        }
      }
    });

    if (!project) {
      return { error: 'Project not found.' };
    }

    const sourceAssetIds = project.sourceAssets.map((asset) => asset.id);
    const contentPackIds = project.contentPacks.map((pack) => pack.id);
    const clipCandidateIds = project.contentPacks.flatMap((pack) =>
      pack.clipCandidates.map((candidate) => candidate.id)
    );
    const transcriptIds = project.sourceAssets
      .map((asset) => asset.transcript?.id || null)
      .filter((value): value is number => Boolean(value));
    const relatedJobIds = (
      await db.query.jobs.findMany({
        where: inArray(jobs.type, [
          JobType.TRANSCRIBE_SOURCE_ASSET,
          JobType.INGEST_YOUTUBE_SOURCE_ASSET,
          JobType.GENERATE_SHORT_FORM_PACK,
          JobType.RENDER_CLIP_CANDIDATE,
          JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
          JobType.DETECT_CLIP_FACECAM
        ])
      })
    )
      .filter((job) => {
        const payload = job.payload;

        return (
          ('projectId' in payload &&
            typeof payload.projectId === 'number' &&
            payload.projectId === data.projectId) ||
          ('sourceAssetId' in payload &&
            typeof payload.sourceAssetId === 'number' &&
            sourceAssetIds.includes(payload.sourceAssetId)) ||
          ('contentPackId' in payload &&
            typeof payload.contentPackId === 'number' &&
            contentPackIds.includes(payload.contentPackId)) ||
          ('clipCandidateId' in payload &&
            typeof payload.clipCandidateId === 'number' &&
            clipCandidateIds.includes(payload.clipCandidateId))
        );
      })
      .map((job) => ({ id: job.id, status: job.status }));

    if (relatedJobIds.some((job) => job.status === JobStatus.PROCESSING)) {
      return {
        error:
          'This project is currently being processed. Wait for background jobs to finish before deleting it.'
      };
    }

    const storageKeys = [
      ...project.sourceAssets
        .filter((asset) => asset.assetType === SourceAssetType.UPLOADED_FILE)
        .map((asset) => asset.storageKey)
        .filter((value): value is string => Boolean(value)),
      ...project.contentPacks.flatMap((pack) =>
        [
          ...pack.renderedClips.map((clip) => clip.storageKey),
          ...pack.clipCandidates.flatMap((candidate) =>
            candidate.renderedClips.map((clip) => clip.storageKey)
          )
        ].filter((value): value is string => Boolean(value))
      )
    ];

    try {
      await Promise.all(storageKeys.map((storageKey) => deleteStorageObject(storageKey)));
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to delete one or more project files from storage.'
      };
    }

    await db.transaction(async (tx) => {
      if (relatedJobIds.length > 0) {
        await tx.delete(jobs).where(
          inArray(
            jobs.id,
            relatedJobIds.map((job) => job.id)
          )
        );
      }

      if (clipCandidateIds.length > 0) {
        await tx
          .delete(clipCandidateFacecamDetections)
          .where(inArray(clipCandidateFacecamDetections.clipCandidateId, clipCandidateIds));

        await tx
          .delete(renderedClips)
          .where(inArray(renderedClips.clipCandidateId, clipCandidateIds));

        await tx
          .delete(clipCandidates)
          .where(inArray(clipCandidates.id, clipCandidateIds));
      }

      if (contentPackIds.length > 0) {
        await tx
          .delete(generatedAssets)
          .where(inArray(generatedAssets.contentPackId, contentPackIds));

        await tx
          .delete(renderedClips)
          .where(inArray(renderedClips.contentPackId, contentPackIds));

        await tx
          .delete(contentPacks)
          .where(inArray(contentPacks.id, contentPackIds));
      }

      if (transcriptIds.length > 0) {
        await tx
          .delete(transcriptSegments)
          .where(inArray(transcriptSegments.transcriptId, transcriptIds));

        await tx
          .delete(transcripts)
          .where(inArray(transcripts.id, transcriptIds));
      }

      if (sourceAssetIds.length > 0) {
        await tx
          .delete(sourceAssets)
          .where(inArray(sourceAssets.id, sourceAssetIds));
      }

      await tx
        .delete(projects)
        .where(and(eq(projects.id, data.projectId), eq(projects.userId, user.id)));
    });

    return {
      success: 'Project deleted successfully.'
    };
  }
);

function buildShortFormSetupInstructions(input: {
  clipGoal?: string;
  contentType?: string;
  clipLength?: string;
  language?: string;
  captionsEnabled?: boolean;
  autoHookEnabled?: boolean;
  facecamDetectionEnabled?: boolean;
  layoutPreference?: string;
  timeframeStart?: string;
  timeframeEnd?: string;
}) {
  const lines = [
    input.clipGoal ? `Clip goal: ${input.clipGoal}` : null,
    input.contentType ? `Content type: ${input.contentType}` : null,
    input.clipLength ? `Clip length: ${input.clipLength}` : null,
    input.language ? `Language: ${input.language}` : null,
    typeof input.captionsEnabled === 'boolean'
      ? `Captions: ${input.captionsEnabled ? 'enabled' : 'disabled'}`
      : null,
    typeof input.autoHookEnabled === 'boolean'
      ? `Auto hook: ${input.autoHookEnabled ? 'enabled' : 'disabled'}`
      : null,
    typeof input.facecamDetectionEnabled === 'boolean'
      ? `Facecam detection: ${
          input.facecamDetectionEnabled ? 'enabled' : 'disabled'
        }`
      : null,
    input.layoutPreference ? `Layout preference: ${input.layoutPreference}` : null,
    input.timeframeStart || input.timeframeEnd
      ? `Timeframe: ${input.timeframeStart || 'start'} to ${
          input.timeframeEnd || 'end'
        }`
      : null
  ].filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join('\n').slice(0, 5000);
}

const generateShortFormPackSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  sourceAssetId: z.coerce.number().int().positive(),
  clipGoal: optionalTextField(2000),
  contentType: optionalTextField(80),
  clipLength: optionalTextField(80),
  language: optionalTextField(80),
  captionsEnabled: z.coerce.boolean().optional(),
  autoHookEnabled: z.coerce.boolean().optional(),
  facecamDetectionEnabled: z.coerce.boolean().optional(),
  layoutPreference: optionalTextField(120),
  timeframeStart: optionalTextField(40),
  timeframeEnd: optionalTextField(40)
});

export const generateShortFormPack = validatedActionWithUser(
  generateShortFormPackSchema,
  async (data, _, user) => {
    const sourceAsset = await db.query.sourceAssets.findFirst({
      where: and(
        eq(sourceAssets.id, data.sourceAssetId),
        eq(sourceAssets.projectId, data.projectId),
        eq(sourceAssets.userId, user.id)
      ),
      with: {
        transcript: {
          with: {
            segments: true
          }
        }
      }
    });

    if (!sourceAsset) {
      return { error: 'Source asset not found for this project.' };
    }

    try {
      assertMediaAvailable(sourceAsset, 'Source asset');
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'This source asset is no longer available.'
      };
    }

    if (
      ![SourceAssetType.UPLOADED_FILE, SourceAssetType.YOUTUBE_URL].includes(
        sourceAsset.assetType as SourceAssetType
      )
    ) {
      return {
        error:
          'Short-form clips are only supported for uploaded media and YouTube URLs.'
      };
    }

    if (!sourceAsset.transcript || sourceAsset.transcript.status !== TranscriptStatus.READY) {
      return {
        error: 'Generate clips after the transcript is ready.'
      };
    }

    if (sourceAsset.transcript.segments.length === 0) {
      return {
        error: 'This transcript does not include timestamps for clip generation.'
      };
    }

    const contentPack = await ensureShortFormContentPack({
      projectId: data.projectId,
      sourceAssetId: sourceAsset.id,
      transcriptId: sourceAsset.transcript.id,
      userId: user.id,
      instructions: buildShortFormSetupInstructions({
        clipGoal: data.clipGoal,
        contentType: data.contentType,
        clipLength: data.clipLength,
        language: data.language,
        captionsEnabled: data.captionsEnabled,
        autoHookEnabled: data.autoHookEnabled,
        facecamDetectionEnabled: data.facecamDetectionEnabled,
        layoutPreference: data.layoutPreference,
        timeframeStart: data.timeframeStart,
        timeframeEnd: data.timeframeEnd
      }),
    });

    await enqueueShortFormPackJob(
      contentPack.id,
      sourceAsset.id,
      sourceAsset.transcript.id,
      user.id
    );

    return {
      success: 'Short-form clips queued for generation.',
      contentPackId: contentPack.id,
    };
  }
);

const renderApprovedClipSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  clipCandidateId: z.coerce.number().int().positive()
});

export const renderApprovedClip = validatedActionWithUser(
  renderApprovedClipSchema,
  async (data, _, user) => {
    const clipCandidate = await db.query.clipCandidates.findFirst({
      where: and(
        eq(clipCandidates.id, data.clipCandidateId),
        eq(clipCandidates.userId, user.id)
      ),
      with: {
        contentPack: true,
        sourceAsset: true
      }
    });

    if (!clipCandidate) {
      return { error: 'Clip candidate not found.' };
    }

    try {
      assertMediaAvailable(clipCandidate.sourceAsset, 'Source asset');
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'This source asset is no longer available.'
      };
    }

    if (
      clipCandidate.contentPack.projectId !== data.projectId ||
      clipCandidate.contentPack.kind !== ContentPackKind.SHORT_FORM_CLIPS
    ) {
      return { error: 'Clip candidate not found for this project.' };
    }

    try {
      await ensureRenderedClipPending({
        clipCandidateId: clipCandidate.id,
        userId: user.id,
        variant: RenderedClipVariant.TRIMMED_ORIGINAL
      });
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'We could not queue this clip for rendering.'
      };
    }

    await enqueueRenderClipJob(
      clipCandidate.id,
      clipCandidate.contentPackId,
      clipCandidate.sourceAssetId,
      user.id
    );

    return {
      success: 'Clip queued for rendering.',
      clipCandidateId: clipCandidate.id
    };
  }
);

const formatRenderedClipShortFormSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  clipCandidateId: z.coerce.number().int().positive()
});

export const formatRenderedClipShortForm = validatedActionWithUser(
  formatRenderedClipShortFormSchema,
  async (data, _, user) => {
    const clipCandidate = await db.query.clipCandidates.findFirst({
      where: and(
        eq(clipCandidates.id, data.clipCandidateId),
        eq(clipCandidates.userId, user.id)
      ),
      with: {
        contentPack: true,
        sourceAsset: true
      }
    });

    if (!clipCandidate) {
      return { error: 'Clip candidate not found.' };
    }

    try {
      assertMediaAvailable(clipCandidate.sourceAsset, 'Source asset');
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'This source asset is no longer available.'
      };
    }

    if (
      clipCandidate.contentPack.projectId !== data.projectId ||
      clipCandidate.contentPack.kind !== ContentPackKind.SHORT_FORM_CLIPS
    ) {
      return { error: 'Clip candidate not found for this project.' };
    }

    try {
      await ensureRenderedClipPending({
        clipCandidateId: clipCandidate.id,
        userId: user.id,
        variant: RenderedClipVariant.VERTICAL_SHORT_FORM
      });
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'We could not queue this vertical clip right now.'
      };
    }

    await enqueueFormatRenderedClipShortFormJob(
      clipCandidate.id,
      clipCandidate.contentPackId,
      clipCandidate.sourceAssetId,
      user.id
    );

    return {
      success: 'Vertical short-form version queued.',
      clipCandidateId: clipCandidate.id
    };
  }
);

const detectClipFacecamSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  clipCandidateId: z.coerce.number().int().positive()
});

export const detectClipFacecam = validatedActionWithUser(
  detectClipFacecamSchema,
  async (data, _, user) => {
    const clipCandidate = await db.query.clipCandidates.findFirst({
      where: and(
        eq(clipCandidates.id, data.clipCandidateId),
        eq(clipCandidates.userId, user.id)
      ),
      with: {
        contentPack: true,
        sourceAsset: true
      }
    });

    if (!clipCandidate) {
      return { error: 'Clip candidate not found.' };
    }

    if (
      clipCandidate.contentPack.projectId !== data.projectId ||
      clipCandidate.contentPack.kind !== ContentPackKind.SHORT_FORM_CLIPS
    ) {
      return { error: 'Clip candidate not found for this project.' };
    }

    try {
      await ensureFacecamDetectionPending({
        clipCandidateId: clipCandidate.id,
        userId: user.id
      });
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'We could not queue facecam detection right now.'
      };
    }

    await enqueueDetectClipFacecamJob(
      clipCandidate.id,
      clipCandidate.contentPackId,
      clipCandidate.sourceAssetId,
      user.id
    );

    return {
      success: 'Facecam detection queued.',
      clipCandidateId: clipCandidate.id
    };
  }
);

const updateClipCandidateReviewStatusSchema = z.object({
  clipCandidateId: z.coerce.number().int().positive(),
  contentPackId: z.coerce.number().int().positive(),
  reviewStatus: z.enum([
    ClipCandidateReviewStatus.APPROVED,
    ClipCandidateReviewStatus.DISCARDED,
    ClipCandidateReviewStatus.SAVED_FOR_LATER,
  ])
});

export const updateClipCandidateReviewStatus = validatedActionWithUser(
  updateClipCandidateReviewStatusSchema,
  async (data, _, user) => {
    const clipCandidate = await db.query.clipCandidates.findFirst({
      where: and(
        eq(clipCandidates.id, data.clipCandidateId),
        eq(clipCandidates.contentPackId, data.contentPackId),
        eq(clipCandidates.userId, user.id)
      )
    });

    if (!clipCandidate) {
      return { error: 'Clip candidate not found.' };
    }

    const [updatedClipCandidate] = await db
      .update(clipCandidates)
      .set({
        reviewStatus: data.reviewStatus,
        updatedAt: new Date()
      })
      .where(eq(clipCandidates.id, data.clipCandidateId))
      .returning();

    const autoSaveResult =
      data.reviewStatus === ClipCandidateReviewStatus.APPROVED
        ? await autoSaveApprovedClipMedia(data.clipCandidateId, user.id)
        : null;

    return {
      success: autoSaveResult?.warning
        ? `Clip candidate updated. ${autoSaveResult.warning}`
        : 'Clip candidate updated.',
      clipCandidate: updatedClipCandidate
    };
  }
);

const saveApprovedClipSchema = z.object({
  clipCandidateId: z.coerce.number().int().positive()
});

export const saveApprovedClip = validatedActionWithUser(
  saveApprovedClipSchema,
  async (data, _, user) => {
    try {
      const result = await saveApprovedClipMedia(data.clipCandidateId, user.id);

      return {
        success:
          result.savedCount > 0
            ? 'Approved clip media saved.'
            : 'No ready rendered clip media needs saving.',
        savedCount: result.savedCount,
        savedBytes: result.savedBytes
      };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Approved clip media could not be saved.'
      };
    }
  }
);

const updateAutoSaveApprovedClipsSchema = z.object({
  enabled: z.enum(['true', 'false']).transform((value) => value === 'true')
});

export const updateAutoSaveApprovedClipsSetting = validatedActionWithUser(
  updateAutoSaveApprovedClipsSchema,
  async (data, _, user) => {
    const [updatedUser] = await db
      .update(users)
      .set({
        autoSaveApprovedClipsEnabled: data.enabled,
        updatedAt: new Date()
      })
      .where(eq(users.id, user.id))
      .returning({
        autoSaveApprovedClipsEnabled: users.autoSaveApprovedClipsEnabled
      });

    return {
      success: updatedUser.autoSaveApprovedClipsEnabled
        ? 'Auto-save enabled for approved clips.'
        : 'Auto-save disabled for approved clips.'
    };
  }
);

const createVoiceProfileSchema = z.object({
  name: z.string().trim().min(1, 'Voice profile name is required').max(100),
  description: optionalTextField(5000),
  tone: optionalTextField(100),
  audience: optionalTextField(150),
  writingStyleNotes: optionalTextField(10000),
  bannedPhrases: optionalTextField(10000),
  ctaStyle: optionalTextField(150),
  prompt: z.string().trim().min(1, 'Prompt is required').max(20000)
});

export const createVoiceProfile = validatedActionWithUser(
  createVoiceProfileSchema,
  async (data, _, user) => {
    const [voiceProfile] = await db
      .insert(voiceProfiles)
      .values({
        userId: user.id,
        name: data.name,
        description: data.description,
        tone: data.tone,
        audience: data.audience,
        writingStyleNotes: data.writingStyleNotes,
        bannedPhrases: data.bannedPhrases,
        ctaStyle: data.ctaStyle,
        prompt: data.prompt
      })
      .returning();

    return {
      success: 'Voice profile created successfully.',
      voiceProfile
    };
  }
);

const updateVoiceProfileSchema = z.object({
  voiceProfileId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, 'Voice profile name is required').max(100),
  description: optionalTextField(5000),
  tone: optionalTextField(100),
  audience: optionalTextField(150),
  writingStyleNotes: optionalTextField(10000),
  bannedPhrases: optionalTextField(10000),
  ctaStyle: optionalTextField(150),
  prompt: z.string().trim().min(1, 'Prompt is required').max(20000)
});

export const updateVoiceProfile = validatedActionWithUser(
  updateVoiceProfileSchema,
  async (data, _, user) => {
    const [voiceProfile] = await db
      .select({ id: voiceProfiles.id })
      .from(voiceProfiles)
      .where(
        and(
          eq(voiceProfiles.id, data.voiceProfileId),
          eq(voiceProfiles.userId, user.id)
        )
      )
      .limit(1);

    if (!voiceProfile) {
      return { error: 'Voice profile not found.' };
    }

    const [updatedVoiceProfile] = await db
      .update(voiceProfiles)
      .set({
        name: data.name,
        description: data.description,
        tone: data.tone,
        audience: data.audience,
        writingStyleNotes: data.writingStyleNotes,
        bannedPhrases: data.bannedPhrases,
        ctaStyle: data.ctaStyle,
        prompt: data.prompt,
        updatedAt: new Date()
      })
      .where(eq(voiceProfiles.id, data.voiceProfileId))
      .returning();

    return {
      success: 'Voice profile updated successfully.',
      voiceProfile: updatedVoiceProfile
    };
  }
);
