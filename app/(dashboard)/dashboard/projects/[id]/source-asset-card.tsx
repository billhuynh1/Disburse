'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Scissors, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { successToastIcon } from '@/components/ui/toaster';
import { deleteSourceAsset, generateShortFormPack } from '@/lib/disburse/actions';
import { useToast } from '@/hooks/use-toast';
import {
  formatSourceAssetFileSize,
  getSourceAssetTypeLabel,
  getWorkflowStatusClasses,
} from '@/lib/disburse/presentation';
import { SourceAssetType } from '@/lib/db/schema';
import { TRANSCRIPT_TRACKING_REFRESH_EVENT } from '@/components/dashboard/transcript-toast-watcher';
import { ClipCandidateCard } from '../../clip-candidate-card';

type DeleteSourceAssetState = {
  error?: string;
  success?: string;
};

type GenerateShortFormState = {
  error?: string;
  success?: string;
};

type SourceAssetCardProps = {
  projectId: number;
  asset: {
    id: number;
    title: string;
    assetType: string;
    originalFilename: string | null;
    storageUrl: string;
    mimeType: string | null;
    fileSizeBytes: number | null;
    status: string;
    failureReason: string | null;
    transcriptStatus: string;
    transcriptSegmentCount: number;
    shortFormPackStatus: string | null;
    shortFormPack:
      | {
          id: number;
          name: string;
          status: string;
          failureReason: string | null;
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
        }
      | null;
  };
};

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

function getShortFormStatusMessage(status: string, failureReason: string | null) {
  if (status === 'failed') {
    return failureReason || 'Short-form clip generation failed.';
  }

  if (status === 'generating') {
    return 'Clip candidates are currently being generated for this source asset.';
  }

  if (status === 'pending') {
    return 'Clip candidate generation is queued and waiting for background processing.';
  }

  return 'No clip candidates have been generated for this source asset yet.';
}

export function SourceAssetCard({ projectId, asset }: SourceAssetCardProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const lastToastKeyRef = useRef<string | null>(null);
  const shortFormToastKeyRef = useRef<string | null>(null);
  const [state, formAction, isPending] = useActionState<
    DeleteSourceAssetState,
    FormData
  >(deleteSourceAsset, {});
  const [generateState, generateAction, isGeneratePending] = useActionState<
    GenerateShortFormState,
    FormData
  >(generateShortFormPack, {});

  useEffect(() => {
    if (state.success) {
      const toastKey = `success:${state.success}`;

      if (lastToastKeyRef.current !== toastKey) {
        toast({
          title: 'Source asset deleted',
          description: state.success,
          icon: successToastIcon,
        });
        lastToastKeyRef.current = toastKey;
      }

      setIsConfirmOpen(false);
      window.dispatchEvent(new Event(TRANSCRIPT_TRACKING_REFRESH_EVENT));
      router.refresh();
      return;
    }

    if (state.error) {
      const toastKey = `error:${state.error}`;

      if (lastToastKeyRef.current !== toastKey) {
        toast({
          title: 'Unable to delete source asset',
          description: state.error,
          variant: 'destructive',
        });
        lastToastKeyRef.current = toastKey;
      }
    }
  }, [router, state.error, state.success, toast]);

  useEffect(() => {
    if (generateState.success) {
      const toastKey = `success:${generateState.success}`;

      if (shortFormToastKeyRef.current !== toastKey) {
        toast({
          title: 'Short-form clips queued',
          description: generateState.success,
          icon: successToastIcon,
        });
        shortFormToastKeyRef.current = toastKey;
      }

      router.refresh();
      return;
    }

    if (generateState.error) {
      const toastKey = `error:${generateState.error}`;

      if (shortFormToastKeyRef.current !== toastKey) {
        toast({
          title: 'Unable to generate clips',
          description: generateState.error,
          variant: 'destructive',
        });
        shortFormToastKeyRef.current = toastKey;
      }
    }
  }, [generateState.error, generateState.success, router, toast]);

  const canGenerateShortForm =
    asset.assetType !== SourceAssetType.PASTED_TRANSCRIPT &&
    asset.transcriptStatus === 'ready';
  const shortFormCandidates = asset.shortFormPack?.clipCandidates || [];

  return (
    <div className="rounded-xl border border-border/70 bg-surface-1 p-4">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-medium text-foreground">{asset.title}</p>
          <p className="text-sm text-muted-foreground">
            {getSourceAssetTypeLabel(asset.assetType)}
            {asset.originalFilename ? ` • ${asset.originalFilename}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {canGenerateShortForm ? (
            <form action={generateAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="sourceAssetId" value={asset.id} />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={isGeneratePending}
              >
                {isGeneratePending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Queueing...
                  </>
                ) : (
                  <>
                    <Scissors className="h-4 w-4" />
                    {asset.shortFormPackStatus ? 'Regenerate Clips' : 'Generate Clips'}
                  </>
                )}
              </Button>
            </form>
          ) : null}
          <StatusBadge status={asset.status} />
          <AlertDialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete source asset?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes <strong>{asset.title}</strong>.
                  Uploaded files will also remove their transcript and
                  transcription job history. Deletion is blocked if the asset is
                  tied to a content pack or currently being transcribed.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <form action={formAction} className="space-y-4">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="sourceAssetId" value={asset.id} />

                {state.error ? (
                  <p className="text-sm text-red-500">{state.error}</p>
                ) : null}

                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={isPending}
                  >
                    {isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Deleting...
                      </>
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4" />
                        Delete Asset
                      </>
                    )}
                  </Button>
                </AlertDialogFooter>
              </form>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {asset.assetType === SourceAssetType.YOUTUBE_URL ? (
        <a
          href={asset.storageUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary underline-offset-4 hover:text-secondary hover:underline"
        >
          {asset.storageUrl}
        </a>
      ) : asset.assetType === SourceAssetType.PASTED_TRANSCRIPT ? (
        <p className="text-sm text-muted-foreground">
          Transcript text was pasted directly and is ready for downstream
          workflows.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {[asset.mimeType || 'Unknown type', formatSourceAssetFileSize(asset.fileSizeBytes)]
            .filter(Boolean)
            .join(' • ')}
        </p>
      )}

      {asset.assetType === SourceAssetType.UPLOADED_FILE &&
      asset.status === 'uploaded' ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Upload complete. Transcription will start in the background when a
          worker picks up the job.
        </p>
      ) : null}
      {asset.assetType === SourceAssetType.YOUTUBE_URL &&
      asset.status === 'uploaded' ? (
        <p className="mt-2 text-sm text-muted-foreground">
          YouTube transcript ingestion is queued and waiting for a worker.
        </p>
      ) : null}
      {asset.assetType === SourceAssetType.UPLOADED_FILE &&
      asset.status === 'processing' ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Transcription is currently running for this source asset.
        </p>
      ) : null}
      {asset.assetType === SourceAssetType.YOUTUBE_URL &&
      asset.status === 'processing' ? (
        <p className="mt-2 text-sm text-muted-foreground">
          YouTube transcript ingestion is currently running for this source asset.
        </p>
      ) : null}
      {asset.shortFormPackStatus ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Short-form clip pack status: <span className="capitalize">{asset.shortFormPackStatus}</span>
        </p>
      ) : null}
      {asset.failureReason ? (
        <p className="mt-2 text-sm text-red-600">{asset.failureReason}</p>
      ) : null}

      {asset.shortFormPack ? (
        <div className="mt-4">
          <Collapsible>
            <CollapsibleTrigger className="bg-background/60">
              <div className="flex min-w-0 flex-col gap-1 text-left sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Clip Candidates
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {asset.shortFormPack.name}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{shortFormCandidates.length} clips</span>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 font-medium capitalize ${getWorkflowStatusClasses(
                      asset.shortFormPack.status
                    )}`}
                  >
                    {asset.shortFormPack.status}
                  </span>
                </div>
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {shortFormCandidates.length > 0 ? (
                <div className="space-y-3">
                  {shortFormCandidates.map((candidate) => (
                    <ClipCandidateCard
                      key={candidate.id}
                      contentPackId={asset.shortFormPack!.id}
                      projectId={projectId}
                      sourceAssetType={asset.assetType}
                      candidate={candidate}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-xl bg-background/60 p-4">
                  <p
                    className={`text-sm ${
                      asset.shortFormPack.status === 'failed'
                        ? 'text-red-600'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {getShortFormStatusMessage(
                      asset.shortFormPack.status,
                      asset.shortFormPack.failureReason
                    )}
                  </p>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}
    </div>
  );
}
