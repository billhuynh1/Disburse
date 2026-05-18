import { notFound, redirect } from 'next/navigation';
import {
  ContentPackKind,
  ContentPackStatus,
  FacecamDetectionStatus,
  RenderedClipStatus,
  SourceAssetType,
  TranscriptStatus
} from '@/lib/db/schema';
import { getProjectById } from '@/lib/db/queries';
import { ProjectSetupPage } from './setup-ui';

export default async function SetupPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const projectId = Number(id);

  if (!Number.isInteger(projectId) || projectId <= 0) {
    notFound();
  }

  const project = await getProjectById(projectId);

  if (!project) {
    notFound();
  }

  const sourceAssets = [...project.sourceAssets]
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    )
    .map((asset) => {
      const shortFormPack = project.contentPacks.find(
        (pack) =>
          pack.sourceAssetId === asset.id &&
          pack.kind === ContentPackKind.SHORT_FORM_CLIPS
      );
      const clipCandidates = shortFormPack?.clipCandidates || [];
      const renderedClips = [
        ...(shortFormPack?.renderedClips || []),
        ...clipCandidates.flatMap((candidate) => candidate.renderedClips),
      ];
      const hasActiveClipProcessing = Boolean(
        shortFormPack &&
          (shortFormPack.status === ContentPackStatus.PENDING ||
            shortFormPack.status === ContentPackStatus.GENERATING ||
            clipCandidates.some((candidate) =>
              [
                FacecamDetectionStatus.PENDING,
                FacecamDetectionStatus.DETECTING,
              ].includes(candidate.facecamDetectionStatus as FacecamDetectionStatus)
            ) ||
            renderedClips.some((clip) =>
              [RenderedClipStatus.PENDING, RenderedClipStatus.RENDERING].includes(
                clip.status as RenderedClipStatus
              )
            ))
      );
      const hasReadyRenderedClips = renderedClips.some(
        (clip) => clip.status === RenderedClipStatus.READY
      );
      const hasFailedClipProcessing = Boolean(
        shortFormPack?.status === ContentPackStatus.FAILED ||
          renderedClips.some((clip) => clip.status === RenderedClipStatus.FAILED)
      );

      return {
        id: asset.id,
        title: asset.title,
        assetType: asset.assetType || SourceAssetType.UPLOADED_FILE,
        mimeType: asset.mimeType,
        storageUrl: asset.storageUrl,
        mediaUrl:
          asset.assetType === SourceAssetType.UPLOADED_FILE
            ? `/api/source-assets/${asset.id}/media`
            : asset.storageUrl,
        thumbnailUrl: asset.thumbnailStorageKey
          ? `/api/source-assets/${asset.id}/thumbnail`
          : null,
        thumbnailWidth: asset.thumbnailWidth,
        thumbnailHeight: asset.thumbnailHeight,
        retentionStatus: asset.retentionStatus,
        storageDeletedAt: asset.storageDeletedAt
          ? asset.storageDeletedAt.toISOString()
          : null,
        transcriptStatus: asset.transcript?.status || TranscriptStatus.PENDING,
        shortFormPackStatus: shortFormPack?.status || null,
        hasActiveClipProcessing,
        hasReadyRenderedClips,
        hasFailedClipProcessing,
        failureReason: asset.failureReason || asset.transcript?.failureReason || null
      };
    });

  const sourceAsset =
    sourceAssets.find((asset) => asset.assetType === SourceAssetType.UPLOADED_FILE) ||
    sourceAssets.find((asset) => asset.assetType === SourceAssetType.YOUTUBE_URL) ||
    null;
  const hasActiveTranscriptWork = Boolean(
    sourceAsset &&
      [
        TranscriptStatus.PENDING,
        TranscriptStatus.PROCESSING,
      ].includes(sourceAsset.transcriptStatus as TranscriptStatus)
  );
  const hasActiveClipProcessing = Boolean(sourceAsset?.hasActiveClipProcessing);
  const hasReadyClipResults = Boolean(
    sourceAsset?.hasReadyRenderedClips && !sourceAsset.hasActiveClipProcessing
  );

  if (hasReadyClipResults && !hasActiveTranscriptWork && !hasActiveClipProcessing) {
    redirect(`/dashboard/projects/${project.id}`);
  }

  return (
    <ProjectSetupPage
      project={{
        id: project.id,
        name: project.name
      }}
      sourceAssets={sourceAssets}
    />
  );
}
