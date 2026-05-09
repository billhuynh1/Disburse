import { notFound } from 'next/navigation';
import {
  ContentPackKind,
  SourceAssetType,
  TranscriptStatus
} from '@/lib/db/schema';
import {
  getProjectById,
  getUser,
  listClipPublicationsForRenderedClips
} from '@/lib/db/queries';
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

  const [project, user] = await Promise.all([getProjectById(projectId), getUser()]);

  if (!project) {
    notFound();
  }

  const renderedClipIds = project.contentPacks.flatMap((pack) => [
    ...pack.renderedClips.map((clip) => clip.id),
    ...pack.clipCandidates.flatMap((candidate) =>
      candidate.renderedClips.map((clip) => clip.id)
    )
  ]);
  const clipPublications = await listClipPublicationsForRenderedClips([
    ...new Set(renderedClipIds)
  ]);
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

  const clipCandidates = project.contentPacks
    .filter((pack) => pack.kind === ContentPackKind.SHORT_FORM_CLIPS)
    .flatMap((pack) =>
      [...pack.clipCandidates]
        .sort((left, right) => left.rank - right.rank)
        .map((candidate) => ({
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
          whyItWorks: candidate.whyItWorks,
          platformFit: candidate.platformFit,
          confidence: candidate.confidence,
          reviewStatus: candidate.reviewStatus,
          facecamDetectionStatus: candidate.facecamDetectionStatus,
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
          renderedClips: candidate.renderedClips.map((clip) => ({
            id: clip.id,
            variant: clip.variant,
            layout: clip.layout,
            status: clip.status,
            title: clip.title,
            durationMs: clip.durationMs,
            fileSizeBytes: clip.fileSizeBytes,
            retentionStatus: clip.retentionStatus,
            expiresAt: clip.expiresAt ? clip.expiresAt.toISOString() : null,
            savedAt: clip.savedAt ? clip.savedAt.toISOString() : null,
            deletedAt: clip.deletedAt ? clip.deletedAt.toISOString() : null,
            storageDeletedAt: clip.storageDeletedAt
              ? clip.storageDeletedAt.toISOString()
              : null,
            deletionReason: clip.deletionReason,
            failureReason: clip.failureReason,
            publications: (
              clipPublicationsByRenderedClipId.get(clip.id) || []
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
          }))
        }))
    );

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
      autoSaveApprovedClipsEnabled={
        user?.autoSaveApprovedClipsEnabled || false
      }
    />
  );
}
