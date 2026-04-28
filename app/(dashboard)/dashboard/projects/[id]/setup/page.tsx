import { notFound } from 'next/navigation';
import {
  ContentPackKind,
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

      return {
        id: asset.id,
        title: asset.title,
        assetType: asset.assetType || SourceAssetType.UPLOADED_FILE,
        retentionStatus: asset.retentionStatus,
        storageDeletedAt: asset.storageDeletedAt
          ? asset.storageDeletedAt.toISOString()
          : null,
        transcriptStatus: asset.transcript?.status || TranscriptStatus.PENDING,
        shortFormPackStatus: shortFormPack?.status || null,
        failureReason: asset.failureReason || asset.transcript?.failureReason || null
      };
    });

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
