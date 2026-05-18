'use client';

import Link from 'next/link';
import {
  type ClipboardEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition
} from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Download,
  HardDrive,
  Loader2,
  MoreHorizontal,
  Share2,
  Sparkles,
  Trash2,
  Upload
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  createProject,
  createSourceAsset,
  deleteProject,
  saveProject
} from '@/lib/disburse/actions';
import {
  SourceAssetType,
} from '@/lib/db/schema';
import {
  createSourceAssetTitleFromFilename,
  isSupportedSourceAssetUpload,
  MAX_SOURCE_ASSET_FILE_SIZE_BYTES,
  SOURCE_ASSET_ALLOWED_FORMAT_LABEL,
  SOURCE_ASSET_UPLOAD_ACCEPT_ATTRIBUTE
} from '@/lib/disburse/source-asset-upload-config';
import {
  formatUploadEta,
  readJsonResponse,
  uploadSourceAssetViaServer,
  uploadToStorageWithProgress
} from './upload-client';
import { uploadSourceAssetThumbnail } from '@/lib/disburse/video-thumbnail-client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { EmptyState, ProgressBar } from '@/components/dashboard/dashboard-ui';
import { ProjectThumbnailFrame } from '@/components/dashboard/project-thumbnail-frame';
import { useToast } from '@/hooks/use-toast';
import { successToastIcon } from '@/components/ui/toaster';
import { deriveProjectProcessingState } from './project-processing-state';

const PROCESSING_REFRESH_INTERVAL_MS = 5000;

type ProjectHubSummary = {
  id: number;
  name: string;
  description: string | null;
  updatedAt: Date | string;
  sourceAssets: {
    id: number;
    title: string;
    assetType: string;
    storageUrl: string;
    originalFilename: string | null;
    thumbnailStorageKey: string | null;
    thumbnailWidth: number | null;
    thumbnailHeight: number | null;
    status: string;
    failureReason: string | null;
    updatedAt: Date | string;
    transcript: {
      id: number;
      status: string;
      content?: string | null;
      failureReason: string | null;
    } | null;
  }[];
  contentPacks: {
    id: number;
    sourceAssetId?: number;
    kind: string;
    status: string;
    failureReason: string | null;
    clipCandidates: {
      id: number;
      reviewStatus: string;
      facecamDetectionStatus: string;
      renderedClips?: { id: number; status: string }[];
    }[];
    renderedClips: { id: number; status: string }[];
  }[];
};

type StorageSummary = {
  usedBytes: number;
  limitBytes: number;
};

type UploadMode = 'file' | 'youtube' | 'transcript';

type UploadProgress = {
  percent: number;
  etaSeconds: number | null;
  label: string;
  fileName: string;
};

const TRANSCRIPT_DETECTION_MIN_LENGTH = 140;

function looksLikeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function looksLikeTranscript(value: string) {
  const trimmed = value.trim();

  if (trimmed.length < TRANSCRIPT_DETECTION_MIN_LENGTH || looksLikeUrl(trimmed)) {
    return false;
  }

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const lineCount = trimmed.split(/\n+/).filter(Boolean).length;

  return lineCount >= 2 || wordCount >= 24 || /[.!?]\s+[A-Z]/.test(trimmed);
}

function parseYouTubeVideoId(url: string) {
  try {
    const parsed = new URL(url);

    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.replace(/\//g, '').trim() || null;
    }

    if (
      parsed.hostname === 'www.youtube.com' ||
      parsed.hostname === 'youtube.com' ||
      parsed.hostname === 'm.youtube.com'
    ) {
      return parsed.searchParams.get('v')?.trim() || null;
    }

    return null;
  } catch {
    return null;
  }
}

function getSourceAssetThumbnail(asset: ProjectHubSummary['sourceAssets'][number] | null) {
  if (!asset) {
    return null;
  }

  if (asset.assetType === SourceAssetType.YOUTUBE_URL) {
    const videoId = parseYouTubeVideoId(asset.storageUrl);

    if (videoId) {
      return {
        kind: 'image' as const,
        src: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        alt: asset.title || 'YouTube thumbnail'
      };
    }
  }

  if (
    asset.assetType === SourceAssetType.UPLOADED_FILE &&
    asset.thumbnailStorageKey
  ) {
    return {
      kind: 'image' as const,
      src: `/api/source-assets/${asset.id}/thumbnail`,
      alt: asset.title || 'Source thumbnail'
    };
  }

  return {
    kind: 'placeholder' as const
  };
}

function getSourceAssetAspectRatio(
  asset: ProjectHubSummary['sourceAssets'][number] | null
) {
  if (!asset) {
    return '16 / 9';
  }

  if (
    asset.assetType === SourceAssetType.YOUTUBE_URL ||
    asset.assetType === SourceAssetType.UPLOADED_FILE
  ) {
    if (
      asset.assetType === SourceAssetType.UPLOADED_FILE &&
      asset.thumbnailWidth &&
      asset.thumbnailHeight
    ) {
      return `${asset.thumbnailWidth} / ${asset.thumbnailHeight}`;
    }

    return '16 / 9';
  }

  return '4 / 3';
}

function deriveProjectTitle(params: {
  file?: File | null;
  link?: string;
  transcript?: string;
}) {
  if (params.file) {
    return createSourceAssetTitleFromFilename(params.file.name);
  }

  const link = params.link?.trim() || '';

  if (looksLikeUrl(link)) {
    try {
      const url = new URL(link);
      if (url.hostname.includes('youtube.com') || url.hostname.includes('youtu.be')) {
        return 'YouTube video';
      }

      return url.hostname.replace(/^www\./, '');
    } catch {
      return 'Video link';
    }
  }

  const transcript = params.transcript?.trim() || '';

  if (transcript) {
    const firstLine = transcript
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);

    if (firstLine) {
      return firstLine.slice(0, 80);
    }
  }

  return 'Untitled video';
}

function formatStorageGb(value: number) {
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatStorageUsed(value: number) {
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;

  if (value >= gb) {
    return formatStorageGb(value);
  }

  return `${(value / mb).toFixed(1)} MB`;
}

function projectDate(value: Date | string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function candidateCount(project: ProjectHubSummary) {
  return project.contentPacks.reduce(
    (count, pack) => count + pack.clipCandidates.length,
    0
  );
}

function approvedCount(project: ProjectHubSummary) {
  return project.contentPacks.reduce(
    (count, pack) =>
      count +
      pack.clipCandidates.filter((candidate) => candidate.reviewStatus === 'approved')
        .length,
    0
  );
}

function UploadProgressCard({
  progress,
  canCancel,
  onCancel
}: {
  progress: UploadProgress;
  canCancel: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {progress.fileName}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {progress.label} · {formatUploadEta(progress.etaSeconds)}
          </p>
        </div>
        {canCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      <ProgressBar value={progress.percent} className="mt-4" />
      <p className="mt-2 text-xs text-muted-foreground">{progress.percent}%</p>
    </div>
  );
}

function UploadHeroCard() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [link, setLink] = useState('');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [canCancelUpload, setCanCancelUpload] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function setUploadProjectProgress(
    _projectId: number | null,
    _projectTitle: string,
    nextProgress: UploadProgress
  ) {
    setProgress(nextProgress);
  }

  async function createUploadProject(projectTitle: string) {
    const formData = new FormData();
    formData.set('name', projectTitle);
    formData.set('description', '');
    const result = await createProject({}, formData);

    if ('error' in result || !('project' in result)) {
      throw new Error('Project could not be created.');
    }

    return result.project;
  }

  async function handleFileUpload(projectId: number, file: File, uploadTitle: string) {
    setUploadProjectProgress(null, uploadTitle, {
      percent: 0,
      etaSeconds: null,
      label: 'Requesting upload URL',
      fileName: file.name
    });
    setCanCancelUpload(false);

    const initiatedUpload = await readJsonResponse(
      await fetch('/api/source-assets/uploads/initiate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          projectId,
          filename: file.name,
          mimeType: file.type,
          fileSizeBytes: file.size
        })
      })
    );

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setCanCancelUpload(true);

    try {
      await uploadToStorageWithProgress({
        uploadUrl: initiatedUpload.uploadUrl,
        method: initiatedUpload.method,
        headers: initiatedUpload.headers,
        file,
        signal: abortController.signal,
        onProgress: (snapshot) => {
          setProgress({
            percent: snapshot.percent,
            etaSeconds: snapshot.etaSeconds,
            label: snapshot.percent >= 100 ? 'Attaching upload' : 'Uploading',
            fileName: file.name
          });
        }
      });
    } catch (uploadError) {
      const message =
        uploadError instanceof Error ? uploadError.message : 'Upload failed.';

      if (message === 'Upload canceled.') {
        throw uploadError;
      }

      setCanCancelUpload(false);
      setUploadProjectProgress(projectId, uploadTitle, {
        percent: 0,
        etaSeconds: null,
        label: 'Uploading through fallback',
        fileName: file.name
      });
      const fallbackResult = await uploadSourceAssetViaServer({
        file,
        projectId,
        title: uploadTitle
      });
      const sourceAssetId = fallbackResult?.sourceAsset?.id;

      if (typeof sourceAssetId === 'number') {
        await uploadSourceAssetThumbnail({ sourceAssetId, file }).catch(() => undefined);
      }
      return;
    }

    setCanCancelUpload(false);
    setUploadProjectProgress(projectId, uploadTitle, {
      percent: 100,
      etaSeconds: 0,
      label: 'Saving upload',
      fileName: file.name
    });

    const result = await readJsonResponse(
      await fetch('/api/source-assets/uploads/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          uploadToken: initiatedUpload.uploadToken,
          title: uploadTitle
        })
      })
    );
    const sourceAssetId = result?.sourceAsset?.id;

    if (typeof sourceAssetId === 'number') {
      await uploadSourceAssetThumbnail({ sourceAssetId, file }).catch(() => undefined);
    }
  }

  function resetToLinkMode() {
    setTranscript('');
  }

  function handleLinkPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pastedText = event.clipboardData.getData('text');

    if (!looksLikeTranscript(pastedText)) {
      return;
    }

    event.preventDefault();
    setLink('');
    setTranscript(pastedText.trim());
    setError(null);
  }

  async function startSubmission(assetOverride?: {
    file?: File | null;
    link?: string;
    transcript?: string;
  }) {
    setError(null);

    const nextFile = assetOverride?.file ?? null;
    const nextLink = assetOverride?.link ?? link;
    const nextTranscript = assetOverride?.transcript ?? transcript;
    const activeMode: UploadMode = nextFile
      ? 'file'
      : nextTranscript.trim()
        ? 'transcript'
        : 'youtube';
    const normalizedTitle = deriveProjectTitle({
      file: nextFile,
      link: nextLink,
      transcript: nextTranscript
    });

    if (activeMode === 'file') {
      if (!nextFile) {
        setError('Select a video or audio file to upload.');
        return;
      }

      if (!isSupportedSourceAssetUpload(nextFile.name, nextFile.type)) {
        setError(`Unsupported file type. Upload ${SOURCE_ASSET_ALLOWED_FORMAT_LABEL}.`);
        return;
      }

      if (nextFile.size > MAX_SOURCE_ASSET_FILE_SIZE_BYTES) {
        setError('File exceeds the 500 MB upload limit.');
        return;
      }
    }

    if (activeMode === 'youtube' && !nextLink.trim()) {
      setError('Paste a video link or upload a file to continue.');
      return;
    }

    if (activeMode === 'youtube' && !looksLikeUrl(nextLink.trim())) {
      setError('Paste a valid video link, or paste transcript text instead.');
      return;
    }

    if (activeMode === 'transcript' && !nextTranscript.trim()) {
      setError('Paste transcript text to continue.');
      return;
    }

    try {
      setIsSubmitting(true);
      setProgress({
        percent: 0,
        etaSeconds: null,
        label: 'Creating project',
        fileName: nextFile?.name || normalizedTitle
      });

      const project = await createUploadProject(normalizedTitle);
      setUploadProjectProgress(project.id, normalizedTitle, {
        percent: 0,
        etaSeconds: null,
        label: activeMode === 'file' ? 'Preparing upload' : 'Saving source',
        fileName: nextFile?.name || normalizedTitle
      });

      if (activeMode === 'file' && nextFile) {
        await handleFileUpload(project.id, nextFile, normalizedTitle);
      } else {
        setUploadProjectProgress(project.id, normalizedTitle, {
          percent: 0,
          etaSeconds: null,
          label: 'Saving source',
          fileName: normalizedTitle
        });
        const formData = new FormData();
        formData.set('projectId', String(project.id));
        formData.set('title', normalizedTitle);
        formData.set(
          'assetType',
          activeMode === 'youtube'
            ? SourceAssetType.YOUTUBE_URL
            : SourceAssetType.PASTED_TRANSCRIPT
        );

        if (activeMode === 'youtube') {
          formData.set('sourceUrl', nextLink.trim());
        } else {
          formData.set('transcriptLanguage', 'en');
          formData.set('transcriptContent', nextTranscript.trim());
        }

        const result = await createSourceAsset({}, formData);

        if ('error' in result) {
          throw new Error(result.error);
        }
      }

      router.push(`/dashboard/projects/${project.id}/setup`);
    } catch (submitError) {
      const message =
        submitError instanceof Error && submitError.message
          ? submitError.message
          : 'Unable to upload this file right now.';
      setError(message);
    } finally {
      setIsSubmitting(false);
      setCanCancelUpload(false);
      abortControllerRef.current = null;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await startSubmission();
  }

  async function handleSelectedFile(file: File | null) {
    setError(null);
    setLink('');
    setTranscript('');

    if (!file) {
      return;
    }

    await startSubmission({ file, link: '', transcript: '' });
  }

  async function handleUploadButtonClick() {
    fileInputRef.current?.click();
  }

  return (
    <Card className="mx-auto max-w-xl overflow-hidden border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] shadow-[0_28px_90px_rgba(0,0,0,0.24)]">
      <CardContent className="space-y-3 p-3.5 sm:p-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-1.5">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="source-url"
                type="text"
                value={transcript ? '' : link}
                placeholder="Paste a YouTube link or transcript"
                className="h-10 border-0 bg-transparent text-white placeholder:text-white/45 shadow-none focus-visible:ring-0"
                disabled={isSubmitting}
                onPaste={handleLinkPaste}
                onChange={(event) => {
                  setLink(event.target.value);
                  if (transcript) {
                    resetToLinkMode();
                  }
                }}
              />
              <Button
                type="submit"
                size="lg"
                disabled={isSubmitting}
                className="h-10 rounded-md border-0 bg-white text-black hover:bg-white/90"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Get clips
              </Button>
            </div>
          </div>

          {transcript ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">
                  Transcript detected
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => resetToLinkMode()}
                >
                  Use link instead
                </Button>
              </div>
              <Textarea
                id="transcript"
                value={transcript}
                rows={6}
                maxLength={20000}
                placeholder="Paste transcript text"
                className="mt-2.5 min-h-28 border-0 bg-transparent px-0 text-white placeholder:text-white/45 shadow-none focus-visible:ring-0"
                disabled={isSubmitting}
                onChange={(event) => setTranscript(event.target.value)}
              />
            </div>
          ) : null}

          <div className="flex items-center gap-3 py-1">
            <input
              ref={fileInputRef}
              type="file"
              accept={SOURCE_ASSET_UPLOAD_ACCEPT_ATTRIBUTE}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                event.target.value = '';
                void handleSelectedFile(file);
              }}
            />
            <Button
              type="button"
              className="rounded-md border-0 bg-white text-black hover:bg-white/90"
              disabled={isSubmitting}
              onClick={() => void handleUploadButtonClick()}
            >
              <Upload className="h-4 w-4" />
              Upload file
            </Button>
          </div>

          {progress ? (
            <UploadProgressCard
              progress={progress}
              canCancel={canCancelUpload}
              onCancel={() => abortControllerRef.current?.abort()}
            />
          ) : null}

          {error ? <p className="text-sm text-white">{error}</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}

function formatProcessingEta(etaSeconds: number | null) {
  return etaSeconds === null ? 'Processing…' : formatUploadEta(etaSeconds);
}

function ProjectProcessingDialog({
  projectName,
  stepLabel,
  percentComplete,
  etaSeconds,
  steps,
  open,
  onOpenChange
}: {
  projectName: string;
  stepLabel: string;
  percentComplete: number;
  etaSeconds: number | null;
  steps: ReturnType<typeof deriveProjectProcessingState>['steps'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{projectName}</DialogTitle>
          <DialogDescription>
            Background processing is still running. This view only reflects the
            current pipeline state.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">{stepLabel}</p>
              <p className="text-xs text-muted-foreground">
                {percentComplete}% · {formatProcessingEta(etaSeconds)}
              </p>
            </div>
            <ProgressBar value={percentComplete} />
          </div>
          <div className="space-y-2">
            {steps.map((step) => (
              <div
                key={step.key}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      'flex h-5 w-5 items-center justify-center rounded-full border text-[10px]',
                      step.status === 'complete'
                        ? 'border-primary/30 bg-primary text-primary-foreground'
                        : step.status === 'current'
                          ? 'border-primary/40 bg-primary/15 text-primary'
                          : 'border-border/70 text-muted-foreground'
                    ].join(' ')}
                  >
                    {step.status === 'complete' ? (
                      <Check className="h-3 w-3" />
                    ) : step.status === 'current' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <span className="block h-1.5 w-1.5 rounded-full bg-current" />
                    )}
                  </span>
                  <span className="text-sm text-foreground">{step.label}</span>
                </div>
                <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  {step.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectCard({ project }: { project: ProjectHubSummary }) {
  const router = useRouter();
  const { toast } = useToast();
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isProgressOpen, setIsProgressOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const latestAsset = project.sourceAssets[0] || null;
  const thumbnail = getSourceAssetThumbnail(latestAsset);
  const thumbnailAspectRatio = getSourceAssetAspectRatio(latestAsset);
  const processingState = deriveProjectProcessingState(project);
  const clips = candidateCount(project);
  const approved = approvedCount(project);
  const projectLabel =
    latestAsset?.originalFilename || latestAsset?.title || project.name;
  const transcriptContent =
    latestAsset?.transcript?.content ||
    project.sourceAssets.find((asset) => asset.transcript?.content)?.transcript?.content ||
    null;
  const secondaryLabel =
    latestAsset?.assetType === SourceAssetType.YOUTUBE_URL
      ? 'YouTube'
      : latestAsset?.assetType === SourceAssetType.PASTED_TRANSCRIPT
        ? 'Transcript'
        : 'Uploaded video';
  const tertiaryLabel =
    clips > 0 ? `${clips} clips` : approved > 0 ? `${approved} approved` : projectDate(project.updatedAt);
  const cardHref = `/dashboard/projects/${project.id}`;

  useEffect(() => {
    if (!processingState.isProcessing) {
      setIsProgressOpen(false);
    }
  }, [processingState.isProcessing]);

  function showError(message: string) {
    toast({
      title: 'Action failed',
      description: message,
      variant: 'destructive'
    });
  }

  function handleSaveProject() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set('projectId', String(project.id));

      const result = await saveProject({}, formData);

      if ('error' in result) {
        showError(result.error || 'Project could not be saved.');
        return;
      }

      toast({
        title: 'Saved to storage',
        description: result.success,
        icon: successToastIcon
      });
      router.refresh();
    });
  }

  function handleShareProject() {
    startTransition(async () => {
      const shareUrl = `${window.location.origin}/dashboard/projects/${project.id}`;

      try {
        await navigator.clipboard.writeText(shareUrl);
        toast({
          title: 'Project link copied',
          description: shareUrl,
          icon: successToastIcon
        });
      } catch {
        showError('Your browser blocked clipboard access.');
      }
    });
  }

  function handleDownloadTranscript() {
    if (!transcriptContent) {
      showError('This project does not have a transcript available yet.');
      return;
    }

    const fileBase =
      (latestAsset?.originalFilename || latestAsset?.title || project.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'transcript';
    const blob = new Blob([transcriptContent], { type: 'text/plain;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = `${fileBase}-transcript.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
  }

  function handleDeleteProject() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set('projectId', String(project.id));

      const result = await deleteProject({}, formData);

      if ('error' in result) {
        showError(result.error || 'Project could not be deleted.');
        return;
      }

      toast({
        title: 'Project deleted',
        description: result.success,
        icon: successToastIcon
      });
      setIsDeleteOpen(false);
      router.refresh();
    });
  }

  const cardPreview = (
    <div
      className="relative"
      style={{ aspectRatio: thumbnailAspectRatio }}
    >
      <ProjectThumbnailFrame
        imageSrc={thumbnail?.kind === 'image' ? thumbnail.src : null}
        imageAlt={thumbnail?.kind === 'image' ? thumbnail.alt : 'Project thumbnail'}
        imageClassName="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
      />
      {processingState.isProcessing ? (
        <div className="absolute inset-0 flex flex-col justify-end bg-black/30 p-3">
          <div className="rounded-xl border border-white/12 bg-black/55 p-3 backdrop-blur-sm">
            <div className="flex items-center justify-between gap-3">
              <p className="truncate text-xs font-medium text-white">
                {processingState.currentStepLabel || 'Processing'}
              </p>
              <p className="shrink-0 text-[11px] text-white/70">
                {processingState.percentComplete}%
              </p>
            </div>
            <ProgressBar
              value={processingState.percentComplete}
              className="mt-2 h-1.5 bg-white/10"
              indicatorClassName="bg-white"
            />
            <p className="mt-2 text-[11px] text-white/70">
              {formatProcessingEta(processingState.etaSeconds)}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );

  const cardTitle = (
    <>
      <h2 className="truncate text-sm font-medium tracking-[-0.01em] text-white">
        {projectLabel}
      </h2>
      <p className="truncate text-[10px] text-white/55">{secondaryLabel}</p>
    </>
  );

  return (
    <>
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <article className="group space-y-1">
          {processingState.isProcessing ? (
            <button
              type="button"
              className="block w-full text-left"
              onClick={() => setIsProgressOpen(true)}
            >
              {cardPreview}
            </button>
          ) : (
            <Link href={cardHref} className="block">
              {cardPreview}
            </Link>
          )}
          <div className="px-0.5">
            <div className="flex items-start justify-between gap-2">
              {processingState.isProcessing ? (
                <button
                  type="button"
                  className="min-w-0 space-y-0.5 text-left"
                  onClick={() => setIsProgressOpen(true)}
                >
                  {cardTitle}
                </button>
              ) : (
                <Link href={cardHref} className="min-w-0 space-y-0.5">
                  {cardTitle}
                </Link>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md text-white/70 hover:bg-white/8 hover:text-white"
                    disabled={isPending}
                    aria-label="Project actions"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onSelect={handleSaveProject} disabled={isPending}>
                    <HardDrive className="h-4 w-4" />
                    Save to storage
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleShareProject} disabled={isPending}>
                    <Share2 className="h-4 w-4" />
                    Share project
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleDownloadTranscript}
                    disabled={!transcriptContent || isPending}
                  >
                    <Download className="h-4 w-4" />
                    Download transcript
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setIsDeleteOpen(true)}
                    disabled={isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <p className="text-[10px] text-white/40">{tertiaryLabel}</p>
          </div>
        </article>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the project, its source assets, transcripts, generated
              clips, and related outputs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-0" disabled={isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                handleDeleteProject();
              }}
              disabled={isPending}
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {processingState.isProcessing && processingState.currentStepLabel ? (
        <ProjectProcessingDialog
          projectName={projectLabel}
          stepLabel={processingState.currentStepLabel}
          percentComplete={processingState.percentComplete}
          etaSeconds={processingState.etaSeconds}
          steps={processingState.steps}
          open={isProgressOpen}
          onOpenChange={setIsProgressOpen}
        />
      ) : null}
    </>
  );
}

function ProjectGrid({ projects }: { projects: ProjectHubSummary[] }) {
  if (projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Upload a source above and recent projects will appear here."
        className="border-0 bg-transparent p-8"
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
  );
}

export function HomePage({
  projects,
  storage
}: {
  projects: ProjectHubSummary[];
  storage: StorageSummary;
}) {
  const sortedProjects = useMemo(
    () =>
      [...projects]
        .filter((project) => project.sourceAssets.length > 0)
        .map((project) => ({
          ...project,
          sourceAssets: [...project.sourceAssets].sort(
            (left, right) =>
              new Date(right.updatedAt || project.updatedAt).getTime() -
              new Date(left.updatedAt || project.updatedAt).getTime()
          )
        })),
    [projects]
  );
  const router = useRouter();
  const hasProcessingProjects = sortedProjects.some(
    (project) => deriveProjectProcessingState(project).isProcessing
  );

  useEffect(() => {
    if (!hasProcessingProjects) {
      return;
    }

    const interval = window.setInterval(() => {
      router.refresh();
    }, PROCESSING_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [hasProcessingProjects, router]);

  return (
    <section className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-7xl space-y-12">
        <UploadHeroCard />
        <div>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-foreground">Recent projects</h2>
            <div className="flex items-center gap-3 self-start sm:self-auto">
              <p className="text-sm text-muted-foreground">
                {formatStorageUsed(storage.usedBytes)} / {formatStorageGb(storage.limitBytes)}
              </p>
              <Button asChild variant="outline" className="border-0">
                <Link href="/dashboard/projects">View library</Link>
              </Button>
            </div>
          </div>
          <ProjectGrid projects={sortedProjects} />
        </div>
      </div>
    </section>
  );
}
