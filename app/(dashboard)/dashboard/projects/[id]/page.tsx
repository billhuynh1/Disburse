import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  ContentPackKind,
  SourceAssetType,
  TranscriptStatus
} from '@/lib/db/schema';
import {
  formatSourceAssetFileSize,
  getSourceAssetTypeLabel,
  getWorkflowStatusClasses
} from '@/lib/disburse/presentation';
import { getProjectById } from '@/lib/db/queries';
import { ArrowLeft } from 'lucide-react';
import { ContentPackCard } from '../../content-pack-card';
import { ContentPackCreateForm } from './content-pack-create-form';
import { SourceAssetCard } from './source-asset-card';
import { SourceAssetCreateForm } from './source-asset-create-form';

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${getWorkflowStatusClasses(
        status
      )}`}
    >
      {status}
    </span>
  );
}

function formatDate(value: Date | string) {
  return new Date(value).toLocaleDateString();
}

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

  const project = await getProjectById(projectId);

  if (!project) {
    notFound();
  }

  const sourceAssets = [...project.sourceAssets].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  const contentPacks = [...project.contentPacks].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  const transcriptEntries = sourceAssets.map((asset) => ({
    sourceAsset: asset,
    transcript: asset.transcript,
    status: asset.transcript?.status || TranscriptStatus.PENDING
  }));
  const generatedAssets = contentPacks.flatMap((pack) =>
    pack.generatedAssets.map((asset) => ({
      ...asset,
      contentPackName: pack.name
    }))
  );

  return (
    <section className="flex-1 p-4 lg:p-8">
      <div className="mb-8">
        <Link
          href="/dashboard/projects"
          className="mb-4 inline-flex items-center text-sm font-medium text-primary hover:text-secondary"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Projects
        </Link>
        <h1 className="text-lg font-medium text-foreground lg:text-2xl">
          {project.name}
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground lg:text-base">
          {project.description || 'No project description yet.'}
        </p>
      </div>

      <div className="mb-8 grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Created</CardDescription>
            <CardTitle>{formatDate(project.createdAt)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Last Updated</CardDescription>
            <CardTitle>{formatDate(project.updatedAt)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Source Assets</CardDescription>
            <CardTitle>{sourceAssets.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Content Packs</CardDescription>
            <CardTitle>{contentPacks.length}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="mb-8">
        <SourceAssetCreateForm projectId={project.id} />
      </div>

      <div className="mb-8">
        <ContentPackCreateForm
          projectId={project.id}
          sourceAssets={sourceAssets.map((asset) => ({
            id: asset.id,
            title: asset.title,
            assetType: asset.assetType
          }))}
        />
      </div>

      <div className="space-y-8">
        <Card>
          <CardHeader>
            <CardTitle>Source Assets</CardTitle>
            <CardDescription>
              Uploaded inputs and source placeholders connected to this project.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sourceAssets.length > 0 ? (
              <div className="space-y-4">
                {sourceAssets.map((asset) => {
                  const shortFormPack = contentPacks.find(
                    (pack) =>
                      pack.sourceAssetId === asset.id &&
                      pack.kind === ContentPackKind.SHORT_FORM_CLIPS
                  );
                  const sortedShortFormCandidates = shortFormPack
                    ? [...shortFormPack.clipCandidates].sort(
                        (a, b) => a.rank - b.rank
                      )
                    : [];

                  return (
                    <SourceAssetCard
                      key={asset.id}
                      projectId={project.id}
                      asset={{
                        ...asset,
                        transcriptStatus:
                          asset.transcript?.status || TranscriptStatus.PENDING,
                        transcriptSegmentCount:
                          asset.transcript?.segments.length || 0,
                        shortFormPackStatus: shortFormPack?.status || null,
                        shortFormPack: shortFormPack
                          ? {
                              id: shortFormPack.id,
                              name: shortFormPack.name,
                              status: shortFormPack.status,
                              failureReason: shortFormPack.failureReason,
                              clipCandidates: sortedShortFormCandidates,
                            }
                          : null,
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No source assets have been added to this project yet.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Transcripts</CardTitle>
            <CardDescription>
              Transcript readiness by source asset.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {transcriptEntries.length > 0 ? (
              <div className="space-y-4">
                {transcriptEntries.map(({ sourceAsset, transcript, status }) => (
                  <div
                    key={sourceAsset.id}
                    className="rounded-xl border border-border/70 bg-surface-1 p-4"
                  >
                    <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-medium text-foreground">
                          {sourceAsset.title}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {transcript?.language || 'Language not set'}
                        </p>
                      </div>
                      <StatusBadge status={status} />
                    </div>

                    {status === TranscriptStatus.READY && transcript?.content ? (
                      <p className="text-sm text-muted-foreground">
                        {transcript.content.length > 220
                          ? `${transcript.content.slice(0, 220)}...`
                          : transcript.content}
                      </p>
                    ) : null}

                    {status === TranscriptStatus.PROCESSING ? (
                      <p className="text-sm text-muted-foreground">
                        Transcript processing has started for this source asset.
                      </p>
                    ) : null}

                    {status === TranscriptStatus.PENDING ? (
                      <p className="text-sm text-muted-foreground">
                        {[SourceAssetType.UPLOADED_FILE, SourceAssetType.YOUTUBE_URL].includes(
                          sourceAsset.assetType as SourceAssetType
                        )
                          ? 'Transcript is queued and waiting for background processing.'
                          : 'No transcript has been created for this source asset yet.'}
                      </p>
                    ) : null}

                    {status === TranscriptStatus.FAILED ? (
                      <p className="text-sm text-red-600">
                        {transcript?.failureReason ||
                          'Transcript generation failed.'}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Transcripts will appear here once source assets are added.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Content Packs</CardTitle>
            <CardDescription>
              Repurposing bundles and workflow state for this project.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {contentPacks.length > 0 ? (
              <div className="space-y-4">
                {contentPacks.map((pack) => (
                  <ContentPackCard
                    key={pack.id}
                    projectId={project.id}
                    contentPack={pack}
                    showClipCandidates={false}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No content packs have been created for this project yet.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Generated Assets</CardTitle>
            <CardDescription>
              Output records connected to this project will appear here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {generatedAssets.length > 0 ? (
              <div className="space-y-4">
                {generatedAssets.map((asset) => (
                  <div
                    key={asset.id}
                    className="rounded-xl border border-border/70 bg-surface-1 p-4"
                  >
                    <p className="font-medium text-foreground">
                      {asset.title || 'Untitled generated asset'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {asset.assetType} • {asset.contentPackName}
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {asset.content.length > 220
                        ? `${asset.content.slice(0, 220)}...`
                        : asset.content}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border/80 bg-surface-1 p-6">
                <p className="text-sm text-muted-foreground">
                  No generated assets exist for this project yet. This section
                  is ready for future generation workflows.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
