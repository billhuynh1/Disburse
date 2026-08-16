import { notFound } from 'next/navigation';
import {
  ContentPackKind,
  FacecamDetectionStatus,
  SourceAssetType,
  TranscriptStatus
} from '@/lib/db/schema';
import { listProjectRecoveryActions } from '@/lib/disburse/job-recovery-service';
import {
  getProjectById,
  getTeamForUser,
  getUser,
  listClipPublicationsForRenderedClips
} from '@/lib/db/queries';
import { projectRenderedClip } from '@/lib/disburse/project-rendered-clip-projection';
import { ProjectClipEditor } from './project-clip-editor';

export default async function ProjectDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const projectId = Number(id);

  if (!Number.isInteger(projectId) || projectId <= 0) {
    notFound();
  }

  const [project, user, team] = await Promise.all([
    getProjectById(projectId),
    getUser(),
    getTeamForUser(),
  ]);

  if (!project) {
    notFound();
  }

  const projectClipProjections = project.contentPacks
    .filter((pack) => pack.kind === ContentPackKind.SHORT_FORM_CLIPS)
    .flatMap((pack) =>
      pack.clipCandidates.map((candidate) => ({
        pack,
        projection: projectRenderedClip({
          candidate,
          editConfig: candidate.editConfig,
          generationMode:
            pack.shortFormGenerationMode === 'snapshot'
              ? ('snapshot' as const)
              : ('legacy' as const),
          currentRenderConfig: candidate.currentRenderConfig,
          legacyRenderedClips: candidate.renderedClips
        })
      }))
    );
  const renderedClipIds = projectClipProjections.flatMap(({ projection }) =>
    projection.renderedClip ? [projection.renderedClip.id] : []
  );
  const clipPublications = await listClipPublicationsForRenderedClips([
    ...new Set(renderedClipIds)
  ]);
  const recoveryActions = user
    ? await listProjectRecoveryActions(project.id, user.id)
    : [];
  const clipPublicationsByRenderedClipId = new Map<number, typeof clipPublications>();

  for (const publication of clipPublications) {
    const existing =
      clipPublicationsByRenderedClipId.get(publication.renderedClipId) || [];
    existing.push(publication);
    clipPublicationsByRenderedClipId.set(publication.renderedClipId, existing);
  }

  const sourceAssets = [...project.sourceAssets]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .map((asset) => {
      const shortFormPack = project.contentPacks.find(
        (pack) =>
          pack.sourceAssetId === asset.id &&
          pack.kind === ContentPackKind.SHORT_FORM_CLIPS
      );

      return {
        id: asset.id,
        title: asset.title,
        assetType: asset.assetType,
        originalFilename: asset.originalFilename,
        storageUrl: asset.storageUrl,
        mimeType: asset.mimeType,
        thumbnailStorageKey: asset.thumbnailStorageKey,
        thumbnailUrl: asset.thumbnailStorageKey
          ? `/api/source-assets/${asset.id}/thumbnail`
          : null,
        thumbnailWidth: asset.thumbnailWidth,
        thumbnailHeight: asset.thumbnailHeight,
        fileSizeBytes: asset.fileSizeBytes,
        status: asset.status,
        retentionStatus: asset.retentionStatus,
        expiresAt: asset.expiresAt ? asset.expiresAt.toISOString() : null,
        savedAt: asset.savedAt ? asset.savedAt.toISOString() : null,
        deletedAt: asset.deletedAt ? asset.deletedAt.toISOString() : null,
        storageDeletedAt: asset.storageDeletedAt
          ? asset.storageDeletedAt.toISOString()
          : null,
        deletionReason: asset.deletionReason,
        failureReason: asset.failureReason,
        transcriptStatus: asset.transcript?.status || TranscriptStatus.PENDING,
        transcriptSegmentCount: asset.transcript?.segments.length || 0,
        transcriptContent: asset.transcript?.content || null,
        transcriptLanguage: asset.transcript?.language || null,
        transcriptFailureReason: asset.transcript?.failureReason || null,
        shortFormPackStatus: shortFormPack?.status || null,
        shortFormPackFailureReason: shortFormPack?.failureReason || null
      };
    });

  const contentPacks = [...project.contentPacks]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .map((pack) => ({
      id: pack.id,
      name: pack.name,
      status: pack.status,
      sourceAssetId: pack.sourceAssetId
    }));

  const clipCandidates = projectClipProjections
    .sort((left, right) => left.projection.candidate.rank - right.projection.candidate.rank)
    .map(({ pack, projection }) => {
      const { candidate, editConfig, effectiveRenderConfig, renderedClip } = projection;
      const generationMode: 'legacy' | 'snapshot' =
        pack.shortFormGenerationMode === 'snapshot' ? 'snapshot' : 'legacy';
      return {
          id: candidate.id,
          contentPackId: pack.id,
          contentPackName: pack.name,
          sourceAssetId: candidate.sourceAssetId,
          sourceAssetTitle: pack.sourceAsset.title,
          sourceAssetType: pack.sourceAsset.assetType,
          sourceAssetStorageUrl: pack.sourceAsset.storageUrl,
          sourceAssetMimeType: pack.sourceAsset.mimeType,
          sourceAssetRetentionStatus: pack.sourceAsset.retentionStatus,
          sourceAssetExpiresAt: pack.sourceAsset.expiresAt
            ? pack.sourceAsset.expiresAt.toISOString()
            : null,
          sourceAssetStorageDeletedAt: pack.sourceAsset.storageDeletedAt
            ? pack.sourceAsset.storageDeletedAt.toISOString()
            : null,
          rank: candidate.rank,
          startTimeMs: candidate.startTimeMs,
          endTimeMs: candidate.endTimeMs,
          durationMs: candidate.durationMs,
          hook: candidate.hook,
          title: candidate.title,
          captionCopy: candidate.captionCopy,
          summary: candidate.summary,
          transcriptExcerpt: candidate.transcriptExcerpt,
          transcriptSegments: (pack.transcript?.segments || []).map((segment) => ({
            startTimeMs: segment.startTimeMs,
            endTimeMs: segment.endTimeMs,
            text: segment.text
          })),
          transcriptWords: (pack.transcript?.words || []).map((word) => ({
            startTimeMs: word.startTimeMs,
            endTimeMs: word.endTimeMs,
            text: word.text
          })),
          whyItWorks: candidate.whyItWorks,
          platformFit: candidate.platformFit,
          confidence: candidate.confidence,
          reviewStatus: candidate.reviewStatus,
          facecamDetectionStatus: candidate.editConfig?.facecamDetected
            ? FacecamDetectionStatus.READY
            : candidate.facecamDetectionStatus,
          facecamDetectionFailureReason:
            candidate.facecamDetectionFailureReason,
          facecamDetectedAt: candidate.facecamDetectedAt
            ? candidate.facecamDetectedAt.toISOString()
            : null,
          facecamDetections: candidate.facecamDetections.map((detection) => ({
            id: detection.id,
            rank: detection.rank,
            frameWidth: detection.frameWidth,
            frameHeight: detection.frameHeight,
            xPx: detection.xPx,
            yPx: detection.yPx,
            widthPx: detection.widthPx,
            heightPx: detection.heightPx,
            confidence: detection.confidence,
            sampledFrameCount: detection.sampledFrameCount
          })),
          currentRenderConfigId: candidate.currentRenderConfigId,
          generationMode,
          effectiveRenderConfig: effectiveRenderConfig
            ? {
                id: effectiveRenderConfig.id,
                aspectRatio: effectiveRenderConfig.aspectRatio,
                layout: effectiveRenderConfig.layout,
                layoutRatio: effectiveRenderConfig.layoutRatio,
                captionsEnabled: effectiveRenderConfig.captionsEnabled,
                captionStyle: effectiveRenderConfig.captionStyle
              }
            : null,
          editConfig: editConfig
            ? {
                id: editConfig.id,
                aspectRatio: editConfig.aspectRatio,
                layout: editConfig.layout,
                layoutRatio: editConfig.layoutRatio,
                captionsEnabled: editConfig.captionsEnabled,
                captionStyle: editConfig.captionStyle,
                captionFontAssetId: editConfig.captionFontAssetId,
                brandTemplateId: editConfig.brandTemplateId,
                facecamDetectionId: editConfig.facecamDetectionId,
                facecamDetected: editConfig.facecamDetected,
                autoEditPreset: editConfig.autoEditPreset,
                autoEditAppliedAt: editConfig.autoEditAppliedAt
                  ? editConfig.autoEditAppliedAt.toISOString()
                  : null,
                configVersion: editConfig.configVersion,
                configHash: editConfig.configHash
              }
            : null,
          renderedClip: renderedClip
            ? {
            id: renderedClip.id,
            renderedClipId: renderedClip.id,
            clipCandidateId: renderedClip.clipCandidateId,
            clipRenderConfigId: renderedClip.clipRenderConfigId,
            variant: renderedClip.variant,
            layout: renderedClip.layout,
            editConfigId: renderedClip.editConfigId,
            editConfigVersion: renderedClip.editConfigVersion,
            editConfigHash: renderedClip.editConfigHash,
            status: renderedClip.status,
            title: renderedClip.title,
            durationMs: renderedClip.durationMs,
            fileSizeBytes: renderedClip.fileSizeBytes,
            retentionStatus: renderedClip.retentionStatus,
            expiresAt: renderedClip.expiresAt ? renderedClip.expiresAt.toISOString() : null,
            savedAt: renderedClip.savedAt ? renderedClip.savedAt.toISOString() : null,
            deletedAt: renderedClip.deletedAt ? renderedClip.deletedAt.toISOString() : null,
            storageDeletedAt: renderedClip.storageDeletedAt
              ? renderedClip.storageDeletedAt.toISOString()
              : null,
            deletionReason: renderedClip.deletionReason,
            failureReason: renderedClip.failureReason,
            publications: (
              clipPublicationsByRenderedClipId.get(renderedClip.id) || []
            ).map((publication) => ({
              id: publication.id,
              platform: publication.platform,
              status: publication.status,
              platformUrl: publication.platformUrl,
              failureReason: publication.failureReason,
              linkedAccountId: publication.linkedAccountId,
              linkedAccountName:
                publication.linkedAccount.platformAccountName ||
                publication.linkedAccount.platformAccountUsername ||
                publication.linkedAccount.platform,
            }))
              }
            : null
        };
    });

  return (
    <ProjectClipEditor
      project={{
        id: project.id,
        name: project.name,
        description: project.description,
        savedAt: project.savedAt ? project.savedAt.toISOString() : null
      }}
      sourceAssets={sourceAssets}
      clipCandidates={clipCandidates}
      contentPacks={contentPacks}
      recoveryActions={recoveryActions}
      autoSaveApprovedClipsEnabled={
        user?.autoSaveApprovedClipsEnabled || false
      }
      subscriptionStatus={team?.subscriptionStatus || null}
    />
  );
}
