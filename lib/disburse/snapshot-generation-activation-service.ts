import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import {
  brandTemplates,
  contentPacks,
  ContentPackKind,
  ContentPackStatus,
  RenderedClipLayout,
  sourceAssets,
  TranscriptStatus,
  type BrandTemplate,
} from '@/lib/db/schema';
import { buildContentPackageInstruction, type ContentPackageValue } from '@/lib/disburse/content-package-config';
import { FACECAM_DETECTOR_VERSION } from '@/lib/disburse/facecam-detection-service';
import { materializeGenerationSnapshot } from '@/lib/disburse/generation-snapshot';
import { createGenerationRunId, insertGenerationRun } from '@/lib/disburse/generation-run-service';
import { cancelShortFormPipelineJobsForContentPack, enqueueShortFormPackJob, enqueueTranscriptionJob } from '@/lib/disburse/job-service';
import { lockProjectAndSourceForLifecycleMutation } from '@/lib/disburse/lifecycle-mutation-barrier';
import { normalizeShortFormClipLength } from '@/lib/disburse/short-form-setup-config';
import { shouldEnqueueTranscriptionFromSetup } from '@/lib/disburse/setup-processing-policy';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ActivateSnapshotShortFormGenerationParams = {
  projectId: number;
  sourceAssetId: number;
  userId: number;
  brandTemplateId?: number;
  contentPackage: ContentPackageValue;
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
};

function buildShortFormSetupInstructions(input: ActivateSnapshotShortFormGenerationParams) {
  const lines = [
    buildContentPackageInstruction(input.contentPackage),
    input.clipGoal ? `Clip goal: ${input.clipGoal}` : null,
    input.brandTemplateId ? `Brand template id: ${input.brandTemplateId}` : null,
    input.contentType ? `Content type: ${input.contentType}` : null,
    input.clipLength ? `Clip length: ${input.clipLength}` : null,
    input.language ? `Language: ${input.language}` : null,
    typeof input.captionsEnabled === 'boolean' ? `Captions: ${input.captionsEnabled ? 'enabled' : 'disabled'}` : null,
    typeof input.autoHookEnabled === 'boolean' ? `Auto hook: ${input.autoHookEnabled ? 'enabled' : 'disabled'}` : null,
    typeof input.facecamDetectionEnabled === 'boolean' ? `Facecam detection: ${input.facecamDetectionEnabled ? 'enabled' : 'disabled'}` : null,
    input.layoutPreference ? `Layout preference: ${input.layoutPreference}` : null,
    input.timeframeStart || input.timeframeEnd ? `Timeframe: ${input.timeframeStart || 'start'} to ${input.timeframeEnd || 'end'}` : null,
  ].filter(Boolean);
  return lines.join('\n').slice(0, 5000);
}

function snapshotForSetup(params: ActivateSnapshotShortFormGenerationParams, instructions: string, template: BrandTemplate | undefined) {
  const clipLength = normalizeShortFormClipLength(params.clipLength);
  return materializeGenerationSnapshot({
    brandTemplateId: template?.id ?? null,
    ranking: {
      generationInstructions: instructions,
      clipLength,
      autoHookEnabled: params.autoHookEnabled ?? true,
      contentPackage: params.contentPackage,
    },
    facecam: {
      detectionEnabled: params.facecamDetectionEnabled ?? true,
      detectorVersion: FACECAM_DETECTOR_VERSION,
      preferredLayout: (template?.defaultLayout as RenderedClipLayout | undefined) ?? RenderedClipLayout.DEFAULT,
      fallbackLayout: RenderedClipLayout.DEFAULT,
    },
    render: {
      aspectRatio: (template?.aspectRatio as '9_16' | '1_1' | '16_9' | undefined) ?? '9_16',
      captionsEnabled: params.captionsEnabled ?? true,
      captionStyle: (template?.captionStyle as 'default') ?? 'default',
      captionFontAssetId: template?.captionFontAssetId ?? null,
      captionFontFamily: template?.captionFontFamily ?? null,
      captionFontColor: template?.captionFontColor ?? '#ffffff',
      captionHighlightColor: template?.captionHighlightColor ?? '#facc15',
      captionPosition: (template?.captionPosition as 'bottom') ?? 'bottom',
      captionAnimation: (template?.captionAnimation as 'none') ?? 'none',
      overlayLogoAssetId: template?.logoAssetId ?? null,
      introVideoAssetId: template?.introVideoAssetId ?? null,
      outroVideoAssetId: template?.outroVideoAssetId ?? null,
      ctaUrl: template?.ctaUrl ?? null,
      cropSettings: template?.cropSettings,
      autoEditPreset: 'default_short_form_v1',
    },
  });
}

export async function activateSnapshotShortFormGeneration(params: ActivateSnapshotShortFormGenerationParams) {
  return await db.transaction(async (tx: DbTransaction) => {
    await lockProjectAndSourceForLifecycleMutation(tx, params);
    const sourceAsset = await tx.query.sourceAssets.findFirst({
      where: and(
        eq(sourceAssets.id, params.sourceAssetId),
        eq(sourceAssets.projectId, params.projectId),
        eq(sourceAssets.userId, params.userId),
      ),
      with: { transcript: true },
    });
    if (!sourceAsset) throw new Error('Source asset not found.');
    const transcriptId = sourceAsset.transcript?.status === TranscriptStatus.READY
      ? sourceAsset.transcript.id
      : null;
    const instructions = buildShortFormSetupInstructions(params);
    const template = await tx.query.brandTemplates.findFirst({
      where: and(
        eq(brandTemplates.userId, params.userId),
        params.brandTemplateId ? eq(brandTemplates.id, params.brandTemplateId) : eq(brandTemplates.isDefault, true),
      ),
    });
    if (params.brandTemplateId && !template) throw new Error('Selected brand template was not found.');

    const existingPack = await tx.query.contentPacks.findFirst({
      where: and(eq(contentPacks.projectId, params.projectId), eq(contentPacks.sourceAssetId, params.sourceAssetId), eq(contentPacks.userId, params.userId), eq(contentPacks.kind, ContentPackKind.SHORT_FORM_CLIPS)),
    });
    const generationRunId = createGenerationRunId();
    const snapshot = snapshotForSetup(params, instructions, template);
    const contentPack = existingPack
      ? (await tx.update(contentPacks).set({ generationRunId, shortFormGenerationMode: 'snapshot', instructions, transcriptId, status: ContentPackStatus.PENDING, failureReason: null, updatedAt: new Date() }).where(eq(contentPacks.id, existingPack.id)).returning())[0]!
      : (await tx.insert(contentPacks).values({ userId: params.userId, projectId: params.projectId, sourceAssetId: params.sourceAssetId, transcriptId, kind: ContentPackKind.SHORT_FORM_CLIPS, name: `${sourceAsset.title} Short Clips`, generationRunId, shortFormGenerationMode: 'snapshot', instructions, status: ContentPackStatus.PENDING }).returning())[0]!;

    if (existingPack) await cancelShortFormPipelineJobsForContentPack(existingPack.id, 'generation_run_stale', existingPack.generationRunId, 'eq', tx);
    await insertGenerationRun({ generationRunId, contentPackId: contentPack.id, selectedBrandTemplateId: template?.id ?? null, snapshot }, tx);
    if (shouldEnqueueTranscriptionFromSetup(sourceAsset)) await enqueueTranscriptionJob(sourceAsset.id, params.userId, tx);
    const job = await enqueueShortFormPackJob(contentPack.id, sourceAsset.id, transcriptId ?? undefined, params.userId, undefined, tx);
    return { contentPack, generationRunId, snapshot, job };
  });
}
