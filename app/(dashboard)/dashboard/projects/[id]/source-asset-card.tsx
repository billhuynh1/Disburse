'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { deleteSourceAsset } from '@/lib/disburse/actions';
import { useToast } from '@/hooks/use-toast';
import {
  formatSourceAssetFileSize,
  getSourceAssetTypeLabel,
  getWorkflowStatusClasses,
} from '@/lib/disburse/presentation';
import { SourceAssetType } from '@/lib/db/schema';
import { TRANSCRIPT_TRACKING_REFRESH_EVENT } from '@/components/dashboard/transcript-toast-watcher';

type DeleteSourceAssetState = {
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

export function SourceAssetCard({ projectId, asset }: SourceAssetCardProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const lastToastKeyRef = useRef<string | null>(null);
  const [state, formAction, isPending] = useActionState<
    DeleteSourceAssetState,
    FormData
  >(deleteSourceAsset, {});

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
      {asset.assetType === SourceAssetType.UPLOADED_FILE &&
      asset.status === 'processing' ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Transcription is currently running for this source asset.
        </p>
      ) : null}
      {asset.failureReason ? (
        <p className="mt-2 text-sm text-red-600">{asset.failureReason}</p>
      ) : null}
    </div>
  );
}
