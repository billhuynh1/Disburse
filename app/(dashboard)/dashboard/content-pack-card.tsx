import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { ContentPackKind } from '@/lib/db/schema';
import {
  getContentPackStatusMessage,
  getSourceAssetTypeLabel
} from '@/lib/disburse/presentation';
import { ClipCandidateCard } from './clip-candidate-card';
import {
  EmptyState,
  FormMessage,
  WorkflowStatusBadge
} from '@/components/dashboard/dashboard-ui';

type ContentPackCardProps = {
  projectId?: number;
  showClipCandidates?: boolean;
  contentPack: {
    id: number;
    kind: string;
    name: string;
    status: string;
    instructions: string | null;
    failureReason: string | null;
    updatedAt: Date | string;
    project?: {
      id: number;
      name: string;
    } | null;
    sourceAsset: {
      id: number;
      title: string;
      assetType: string;
    };
    transcript?: {
      id: number;
      status: string;
    } | null;
    clipCandidates: {
      id: number;
      rank: number;
      startTimeMs: number;
      endTimeMs: number;
      durationMs: number;
      hook: string;
      title: string;
      captionCopy: string;
      summary: string;
      transcriptExcerpt: string;
      whyItWorks: string;
      platformFit: string;
      confidence: number;
      reviewStatus: string;
      facecamDetectionStatus: string;
      facecamDetectionFailureReason: string | null;
      facecamDetectedAt: Date | string | null;
      facecamDetections: {
        id: number;
        rank: number;
        frameWidth: number;
        frameHeight: number;
        xPx: number;
        yPx: number;
        widthPx: number;
        heightPx: number;
        confidence: number;
        sampledFrameCount: number;
      }[];
      renderedClips: {
        id: number;
        variant: string;
        status: string;
        title: string;
        durationMs: number;
        fileSizeBytes: number | null;
        failureReason: string | null;
      }[];
    }[];
    renderedClips: {
      id: number;
      status: string;
    }[];
    generatedAssets: {
      id: number;
    }[];
  };
  showProjectName?: boolean;
};

const placeholderSections = [
  'LinkedIn post',
  'X thread',
  'Newsletter draft',
  'Hooks/titles',
  'CTA variants'
];

export function ContentPackCard({
  projectId,
  contentPack,
  showProjectName = false,
  showClipCandidates = true
}: ContentPackCardProps) {
  const sortedClipCandidates = [...contentPack.clipCandidates].sort(
    (a, b) => a.rank - b.rank
  );
  const isShortFormPack = contentPack.kind === ContentPackKind.SHORT_FORM_CLIPS;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{contentPack.name}</CardTitle>
            <CardDescription className="mt-2">
              {showProjectName && contentPack.project
                ? `${contentPack.project.name} • `
                : ''}
              Source asset: {contentPack.sourceAsset.title}
            </CardDescription>
          </div>
          <WorkflowStatusBadge status={contentPack.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm text-muted-foreground">
          <p>{contentPack.instructions || 'No content pack instructions yet.'}</p>
          <p className="mt-2">{getContentPackStatusMessage(contentPack.status)}</p>
          {contentPack.failureReason ? (
            <FormMessage tone="error">{contentPack.failureReason}</FormMessage>
          ) : null}
        </div>

        {isShortFormPack ? (
          showClipCandidates ? (
            sortedClipCandidates.length > 0 ? (
              <div className="space-y-3">
                {sortedClipCandidates.map((candidate) => (
                  <ClipCandidateCard
                    key={candidate.id}
                    contentPackId={contentPack.id}
                    projectId={projectId || contentPack.project?.id || 0}
                    sourceAssetType={contentPack.sourceAsset.assetType}
                    candidate={candidate}
                  />
                ))}
              </div>
            ) : (
              <EmptyState description="No clip candidates yet. Generate or rerun this short-form pack to create ranked clips." />
            )
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Review clip candidates from the linked source asset in the
                project page.
              </p>
            </div>
          )
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {placeholderSections.map((section) => (
              <div
                key={section}
                className="rounded-xl border border-dashed border-border/80 bg-surface-1/80 p-3"
              >
                <p className="text-sm font-medium text-foreground">{section}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Placeholder only. This slot is ready for future generated
                  content.
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-4">
          <span>Kind: {contentPack.kind.replaceAll('_', ' ')}</span>
          <span>
            Asset type: {getSourceAssetTypeLabel(contentPack.sourceAsset.assetType)}
          </span>
          <span>
            Transcript: {contentPack.transcript?.status || 'not linked yet'}
          </span>
          {isShortFormPack ? (
            <span>Clip candidates: {sortedClipCandidates.length}</span>
          ) : null}
          {isShortFormPack ? (
            <span>Rendered clips: {contentPack.renderedClips.length}</span>
          ) : null}
          <span>Generated assets: {contentPack.generatedAssets.length}</span>
        </div>
      </CardContent>
    </Card>
  );
}
