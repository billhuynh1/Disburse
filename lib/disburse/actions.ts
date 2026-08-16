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
  FacecamDetectionStatus,
  generatedAssets,
  jobs,
  JobStatus,
  JobType,
  RenderedClipLayout,
  projects,
  RenderedClipVariant,
  renderedClips,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  transcripts,
  TranscriptStatus,
  users,
  voiceProfiles
} from '@/lib/db/schema';
import {
  applyFacecamResultToClipEditConfig,
  getRenderedClipVariantForEditConfig,
  updateClipEditConfigFromEditor,
} from '@/lib/disburse/clip-edit-config-service';
import {
  assertMediaAvailable,
  deleteProjectGraph,
  deleteSourceAssetGraph,
  getTemporaryProjectExpiresAt,
  saveCurrentRenderedClipMedia,
  saveProjectSourceMedia,
} from '@/lib/disburse/media-retention-service';
import {
  enqueueDetectCandidateFacecamJob,
  enqueuePublishRenderedClipJob,
  enqueueFormatRenderedClipShortFormJob,
  enqueueRenderClipJob,
  enqueueShortFormPackJob,
  enqueueTranscriptionJob,
} from '@/lib/disburse/job-service';
import { createGenerationRunId } from '@/lib/disburse/generation-run-service';
import { triggerInternalJobProcessing } from '@/lib/disburse/internal-job-trigger';
import { isSupportedPublishPlatform } from '@/lib/disburse/linked-account-service';
import { prepareRenderedClipPublication } from '@/lib/disburse/publishing-service';
import { DIRECT_PUBLISHING_PROHIBITED_MESSAGE } from '@/lib/disburse/publishing-prohibition';
import { getReusableFontAssetForUser } from '@/lib/disburse/reusable-asset-service';
import { ensureRenderedClipPending } from '@/lib/disburse/rendered-clip-service';
import { classifyShortFormGenerationMode } from '@/lib/disburse/short-form-generation-mode-service';
import { captionStyles } from '@/lib/disburse/caption-style';
import { ensureShortFormContentPack } from '@/lib/disburse/short-form-service';
import { shouldEnqueueTranscriptionFromSetup } from '@/lib/disburse/setup-processing-policy';
import { lockProjectAndSourceForLifecycleMutation } from '@/lib/disburse/lifecycle-mutation-barrier';
import {
  buildContentPackageInstruction,
  CONTENT_PACKAGE_VALUES,
  DEFAULT_CONTENT_PACKAGE,
  type ContentPackageValue
} from '@/lib/disburse/content-package-config';

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

const optionalPositiveIntField = z.preprocess((value) => {
  if (value === '' || value === null || typeof value === 'undefined') {
    return undefined;
  }

  return value;
}, z.coerce.number().int().positive().optional());

const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(150),
  description: optionalTextField(5000)
});

export const createProject = validatedActionWithUser(
  createProjectSchema,
  async (data, _, user) => {
    try {
      const [project] = await db
        .insert(projects)
        .values({
          userId: user.id,
          name: data.name,
          description: data.description,
          isSaved: false,
          expiresAt: getTemporaryProjectExpiresAt()
        })
        .returning();

      return {
        success: 'Project created successfully.',
        project
      };
    } catch {
      return {
        error: 'Project could not be created.'
      };
    }
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
    const contentPack = await db.transaction(async (tx) => {
      await lockProjectAndSourceForLifecycleMutation(tx, {
        projectId: data.projectId,
        sourceAssetId: data.sourceAssetId,
        userId: user.id,
      });
      const [transcript] = await tx
        .select({ id: transcripts.id })
        .from(transcripts)
        .where(and(
          eq(transcripts.sourceAssetId, data.sourceAssetId),
          eq(transcripts.userId, user.id)
        ))
        .limit(1);
      const [createdContentPack] = await tx
        .insert(contentPacks)
        .values({
          userId: user.id,
          projectId: data.projectId,
          sourceAssetId: data.sourceAssetId,
          transcriptId: transcript?.id ?? null,
          kind: ContentPackKind.GENERAL,
          name: data.name,
          generationRunId: createGenerationRunId(),
          instructions: data.instructions,
          status: ContentPackStatus.PENDING
        })
        .returning();
      return createdContentPack;
    });

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
    try {
      const result = await deleteSourceAssetGraph({
        projectId: data.projectId,
        sourceAssetId: data.sourceAssetId,
        userId: user.id,
      });
      if (!result.deleted && !result.pending) {
        return { error: 'Source asset not found for this project.' };
      }
      return result.pending
        ? { success: 'Source asset deletion requested. Active processing is stopping.' }
        : { success: 'Source asset deleted successfully.' };
    } catch {
      console.error('Source asset deletion failed.');
      return {
        error: 'Source asset could not be deleted.'
      };
    }
  }
);

const deleteProjectSchema = z.object({
  projectId: z.coerce.number().int().positive()
});

export const deleteProject = validatedActionWithUser(
  deleteProjectSchema,
  async (data, _, user) => {
    try {
      const result = await deleteProjectGraph({
        projectId: data.projectId,
        userId: user.id
      });

      if (!result.deleted && !result.pending) {
        return { error: 'Project not found.' };
      }

      if (result.pending) {
        return { success: 'Project deletion requested. Active processing is stopping.' };
      }

      return {
        success: 'Project deleted successfully.',
        deletedStorageObjectCount: result.deletedStorageObjectCount
      };
    } catch (error) {
      console.error('Project deletion failed.');

      return {
        error: 'Project could not be deleted.'
      };
    }
  }
);

function buildShortFormSetupInstructions(input: {
  contentPackage?: ContentPackageValue;
  clipGoal?: string;
  brandTemplateId?: number;
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
    input.contentPackage
      ? buildContentPackageInstruction(input.contentPackage)
      : buildContentPackageInstruction(DEFAULT_CONTENT_PACKAGE),
    input.clipGoal ? `Clip goal: ${input.clipGoal}` : null,
    input.brandTemplateId ? `Brand template id: ${input.brandTemplateId}` : null,
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
  brandTemplateId: optionalPositiveIntField,
  contentPackage: z.enum(CONTENT_PACKAGE_VALUES).default(DEFAULT_CONTENT_PACKAGE),
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

    const existingShortFormPack = await db.query.contentPacks.findFirst({
      where: and(
        eq(contentPacks.projectId, data.projectId),
        eq(contentPacks.sourceAssetId, sourceAsset.id),
        eq(contentPacks.userId, user.id),
        eq(contentPacks.kind, ContentPackKind.SHORT_FORM_CLIPS)
      ),
      columns: {
        id: true,
        generationRunId: true,
      },
    });
    if (existingShortFormPack) {
      const generationMode = await classifyShortFormGenerationMode({
        contentPackId: existingShortFormPack.id,
        generationRunId: existingShortFormPack.generationRunId,
      });
      if (generationMode.kind === 'invalid_snapshot_reference') {
        return { error: generationMode.code };
      }
      if (generationMode.kind === 'snapshot') {
        return { error: 'snapshot_generation_regeneration_not_activated' };
      }
    }

    const contentPack = await ensureShortFormContentPack({
      projectId: data.projectId,
      sourceAssetId: sourceAsset.id,
      transcriptId:
        sourceAsset.transcript?.status === TranscriptStatus.READY
          ? sourceAsset.transcript.id
          : undefined,
      userId: user.id,
      instructions: buildShortFormSetupInstructions({
        contentPackage: data.contentPackage,
        clipGoal: data.clipGoal,
        brandTemplateId: data.brandTemplateId,
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

    if (shouldEnqueueTranscriptionFromSetup(sourceAsset)) {
      await enqueueTranscriptionJob(sourceAsset.id, user.id);
    }

    await enqueueShortFormPackJob(
      contentPack.id,
      sourceAsset.id,
      sourceAsset.transcript?.status === TranscriptStatus.READY
        ? sourceAsset.transcript.id
        : undefined,
      user.id,
      data.brandTemplateId
    );
    triggerInternalJobProcessing();

    return {
      success: 'Short-form clips queued for generation.',
      contentPackId: contentPack.id,
    };
  }
);

const renderApprovedClipSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  clipCandidateId: z.coerce.number().int().positive(),
  captionsEnabled: z.coerce.boolean().optional().default(true),
  captionFontAssetId: optionalPositiveIntField
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

    const generationMode = await classifyShortFormGenerationMode({
      generationRunId: clipCandidate.generationRunId,
      contentPackId: clipCandidate.contentPackId,
    });
    if (generationMode.kind === 'invalid_snapshot_reference') {
      return { error: generationMode.code };
    }
    if (generationMode.kind === 'snapshot') {
      return { error: 'Snapshot clip rerendering is not available yet.' };
    }

    try {
      await getReusableFontAssetForUser(data.captionFontAssetId, user.id);
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Selected caption font could not be used.'
      };
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
      user.id,
      data.captionsEnabled,
      data.captionFontAssetId
    );
    triggerInternalJobProcessing();

    return {
      success: 'Clip queued for rendering.',
      clipCandidateId: clipCandidate.id
    };
  }
);

const formatRenderedClipShortFormSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  clipCandidateId: z.coerce.number().int().positive(),
  aspectRatio: z.enum(['9_16', '1_1', '16_9']).default('9_16'),
  layout: z
    .nativeEnum(RenderedClipLayout)
    .optional()
    .default(RenderedClipLayout.DEFAULT),
  captionsEnabled: z.coerce.boolean().optional().default(true),
  captionStyle: z.enum(captionStyles).optional().default('default'),
  captionFontAssetId: optionalPositiveIntField
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

    const generationMode = await classifyShortFormGenerationMode({
      generationRunId: clipCandidate.generationRunId,
      contentPackId: clipCandidate.contentPackId,
    });
    if (generationMode.kind === 'invalid_snapshot_reference') {
      return { error: generationMode.code };
    }
    if (generationMode.kind === 'snapshot') {
      return { error: 'Snapshot clip rerendering is not available yet.' };
    }

    try {
      await getReusableFontAssetForUser(data.captionFontAssetId, user.id);
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Selected caption font could not be used.'
      };
    }

    try {
      const editConfig = await updateClipEditConfigFromEditor({
        clipCandidateId: clipCandidate.id,
        userId: user.id,
        aspectRatio: data.aspectRatio,
        layout: data.layout,
        captionsEnabled: data.captionsEnabled,
        captionStyle: data.captionStyle,
        captionFontAssetId: data.captionFontAssetId
      });
      const renderedClipVariant = getRenderedClipVariantForEditConfig(editConfig);
      await ensureRenderedClipPending({
        clipCandidateId: clipCandidate.id,
        userId: user.id,
        variant: renderedClipVariant,
        layout: editConfig.layout as RenderedClipLayout,
        editConfig
      });
      await enqueueFormatRenderedClipShortFormJob(
        clipCandidate.id,
        clipCandidate.contentPackId,
        clipCandidate.sourceAssetId,
        user.id,
        editConfig.generationRunId,
        renderedClipVariant,
        editConfig.layout as RenderedClipLayout,
        editConfig.captionsEnabled,
        editConfig.captionFontAssetId ?? undefined,
        editConfig.configHash
      );
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'We could not queue this vertical clip right now.'
      };
    }
    triggerInternalJobProcessing();

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

    const generationMode = await classifyShortFormGenerationMode({
      generationRunId: clipCandidate.generationRunId,
      contentPackId: clipCandidate.contentPackId,
    });
    if (generationMode.kind === 'invalid_snapshot_reference') {
      return { error: generationMode.code };
    }
    if (generationMode.kind === 'snapshot') {
      return { error: 'Manual snapshot facecam detection is not available yet.' };
    }

    try {
      const enqueueResult = await enqueueDetectCandidateFacecamJob({
        id: clipCandidate.id,
        userId: user.id,
        contentPackId: clipCandidate.contentPackId,
        sourceAssetId: clipCandidate.sourceAssetId,
        generationRunId: clipCandidate.generationRunId,
        startTimeMs: clipCandidate.startTimeMs,
        endTimeMs: clipCandidate.endTimeMs,
      });

      if (enqueueResult.status === 'reused_completed') {
        const editConfig = await applyFacecamResultToClipEditConfig({
          clipCandidateId: clipCandidate.id,
          userId: user.id,
          generationRunId: clipCandidate.generationRunId,
          status:
            enqueueResult.job.status === JobStatus.FAILED ||
            enqueueResult.job.status === JobStatus.CANCELLED
              ? FacecamDetectionStatus.FAILED
              : FacecamDetectionStatus.READY,
        });
        await enqueueFormatRenderedClipShortFormJob(
          clipCandidate.id,
          clipCandidate.contentPackId,
          clipCandidate.sourceAssetId,
          user.id,
          clipCandidate.generationRunId,
          getRenderedClipVariantForEditConfig(editConfig),
          editConfig.layout as RenderedClipLayout,
          editConfig.captionsEnabled,
          editConfig.captionFontAssetId ?? undefined,
          editConfig.configHash,
          undefined,
          true
        );
      } else {
        await db
          .update(clipCandidates)
          .set({
            facecamDetectionStatus: FacecamDetectionStatus.PENDING,
            facecamDetectionFailureReason: null,
            facecamDetectionDebugReason: null,
            facecamDetectedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(clipCandidates.id, clipCandidate.id),
              eq(clipCandidates.userId, user.id)
            )
          );
      }
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'We could not queue facecam detection right now.'
      };
    }

    triggerInternalJobProcessing();

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
    ClipCandidateReviewStatus.PENDING,
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

    return {
      success:
        data.reviewStatus === ClipCandidateReviewStatus.APPROVED
          ? 'Clip favorited.'
          : data.reviewStatus === ClipCandidateReviewStatus.DISCARDED
            ? 'Clip rejected.'
            : data.reviewStatus === ClipCandidateReviewStatus.PENDING
              ? 'Clip reset to pending.'
          : 'Clip candidate updated.',
      clipCandidate: updatedClipCandidate
    };
  }
);

const publishRenderedClipSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  renderedClipId: z.coerce.number().int().positive(),
  platform: z.string().trim().min(1),
});

export const publishRenderedClip = validatedActionWithUser(
  publishRenderedClipSchema,
  async (data, _, user) => {
    if (DIRECT_PUBLISHING_PROHIBITED_MESSAGE.length > 0) {
      return { error: DIRECT_PUBLISHING_PROHIBITED_MESSAGE };
    }
    if (!isSupportedPublishPlatform(data.platform)) {
      return { error: 'This publishing platform is not supported.' };
    }

    const renderedClip = await db.query.renderedClips.findFirst({
      where: and(
        eq(renderedClips.id, data.renderedClipId),
        eq(renderedClips.userId, user.id)
      ),
      with: {
        contentPack: true,
      },
    });

    if (!renderedClip) {
      return { error: 'Rendered clip not found.' };
    }

    if (renderedClip.contentPack.projectId !== data.projectId) {
      return { error: 'Rendered clip not found for this project.' };
    }

    try {
      const result = await prepareRenderedClipPublication({
        projectId: data.projectId,
        renderedClipId: data.renderedClipId,
        platform: data.platform,
        userId: user.id,
      });

      if (result.publicationStatus === 'already_published') {
        return {
          success: `${data.platform === 'youtube' ? 'YouTube' : 'TikTok'} already has this clip published.`
        };
      }

      await enqueuePublishRenderedClipJob(
        result.publication.id,
        result.renderedClip.id,
        result.account.id,
        user.id,
        data.platform
      );
      triggerInternalJobProcessing();

      return {
        success:
          result.publicationStatus === 'already_pending'
            ? 'Clip publishing is already queued.'
            : 'Clip queued for publishing.',
      };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'We could not queue this clip for publishing.',
      };
    }
  }
);

const updateClipCandidateTitleSchema = z.object({
  clipCandidateId: z.coerce.number().int().positive(),
  contentPackId: z.coerce.number().int().positive(),
  title: z.string().trim().min(1, 'Title is required').max(150)
});

export const updateClipCandidateTitle = validatedActionWithUser(
  updateClipCandidateTitleSchema,
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
        title: data.title,
        updatedAt: new Date()
      })
      .where(eq(clipCandidates.id, data.clipCandidateId))
      .returning();

    return {
      success: 'Clip title updated.',
      clipCandidate: updatedClipCandidate
    };
  }
);

const approveClipCandidateAndQueueRenderSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  clipCandidateId: z.coerce.number().int().positive(),
  contentPackId: z.coerce.number().int().positive(),
  aspectRatio: z.enum(['9_16', '1_1', '16_9']),
  layout: z
    .nativeEnum(RenderedClipLayout)
    .optional()
    .default(RenderedClipLayout.DEFAULT),
  captionsEnabled: z.coerce.boolean().optional().default(true),
  captionFontAssetId: optionalPositiveIntField
});

export const favoriteClipCandidate = validatedActionWithUser(
  approveClipCandidateAndQueueRenderSchema,
  async (data, _, user) => {
    const clipCandidate = await db.query.clipCandidates.findFirst({
      where: and(
        eq(clipCandidates.id, data.clipCandidateId),
        eq(clipCandidates.contentPackId, data.contentPackId),
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

    const [updatedClipCandidate] = await db
      .update(clipCandidates)
      .set({
        reviewStatus:
          clipCandidate.reviewStatus === ClipCandidateReviewStatus.APPROVED
            ? ClipCandidateReviewStatus.PENDING
            : ClipCandidateReviewStatus.APPROVED,
        updatedAt: new Date()
      })
      .where(eq(clipCandidates.id, data.clipCandidateId))
      .returning();

    return {
      success:
        updatedClipCandidate.reviewStatus === ClipCandidateReviewStatus.APPROVED
          ? 'Clip favorited.'
          : 'Clip unfavorited.',
      clipCandidate: updatedClipCandidate
    };
  }
);

export const approveClipCandidateAndQueueRender = favoriteClipCandidate;

const saveApprovedClipSchema = z.object({
  clipCandidateId: z.coerce.number().int().positive(),
  renderedClipId: z.coerce.number().int().positive(),
  renderConfigId: z.coerce.number().int().positive().optional()
});

export const saveApprovedClip = validatedActionWithUser(
  saveApprovedClipSchema,
  async (data, _, user) => {
    try {
      const result = await saveCurrentRenderedClipMedia(data, user.id);

      return {
        success:
          result.savedCount > 0
            ? 'Clip media saved.'
            : 'No ready rendered clip media needs saving.',
        savedCount: result.savedCount,
        savedBytes: result.savedBytes
      };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Clip media could not be saved.'
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
        ? 'Auto-save enabled for favorited clips.'
        : 'Auto-save disabled for favorited clips.'
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
