'use client';

import Link from 'next/link';
import { type ClipboardEvent, type FormEvent, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Clapperboard,
  Loader2,
  Sparkles,
  Upload,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createProject, createSourceAsset } from '@/lib/disburse/actions';
import {
  ContentPackKind,
  ContentPackStatus,
  SourceAssetStatus,
  SourceAssetType,
  TranscriptStatus
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
import {
  EmptyState,
  ProgressBar,
  StatusBadge
} from '@/components/dashboard/dashboard-ui';

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
    status: string;
    failureReason: string | null;
    updatedAt: Date | string;
    transcript: {
      id: number;
      status: string;
      failureReason: string | null;
    } | null;
  }[];
  contentPacks: {
    id: number;
    kind: string;
    status: string;
    failureReason: string | null;
    clipCandidates: { id: number; reviewStatus: string }[];
    renderedClips: { id: number; status: string }[];
  }[];
};

type UploadMode = 'file' | 'youtube' | 'transcript';

type UploadProgress = {
  percent: number;
  etaSeconds: number | null;
  label: string;
  fileName: string;
};

type ActiveUploadProject = UploadProgress & {
  projectId: number | null;
  title: string;
  error: string | null;
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

  return {
    kind: 'placeholder' as const
  };
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

function projectDate(value: Date | string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function deriveProjectStatus(project: ProjectHubSummary) {
  const latestAsset = project.sourceAssets[0] || null;
  const shortFormPacks = project.contentPacks.filter(
    (pack) => pack.kind === ContentPackKind.SHORT_FORM_CLIPS
  );
  const hasFailed =
    latestAsset?.status === SourceAssetStatus.FAILED ||
    latestAsset?.transcript?.status === TranscriptStatus.FAILED ||
    shortFormPacks.some((pack) => pack.status === ContentPackStatus.FAILED);

  if (hasFailed) {
    return 'failed';
  }

  if (
    shortFormPacks.some((pack) => pack.status === ContentPackStatus.READY) ||
    shortFormPacks.some((pack) => pack.clipCandidates.length > 0)
  ) {
    return 'ready';
  }

  if (
    latestAsset?.transcript?.status === TranscriptStatus.PROCESSING ||
    latestAsset?.transcript?.status === TranscriptStatus.PENDING ||
    shortFormPacks.some((pack) => pack.status === ContentPackStatus.GENERATING)
  ) {
    return 'processing';
  }

  if (latestAsset?.status === SourceAssetStatus.READY) {
    return 'personalizing';
  }

  if (latestAsset?.status === SourceAssetStatus.UPLOADED) {
    return 'uploaded';
  }

  return latestAsset ? latestAsset.status : 'empty';
}

function statusClasses(status: string) {
  if (status === 'ready') {
    return 'bg-white/10 text-white ring-white/15';
  }

  if (status === 'failed') {
    return 'bg-white/12 text-white ring-white/20';
  }

  if (['processing', 'queued', 'uploaded', 'personalizing'].includes(status)) {
    return 'bg-white/8 text-white/90 ring-white/10';
  }

  return 'bg-white/6 text-white/70 ring-white/10';
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
          <Button type="button" variant="ghost" size="icon" onClick={onCancel}>
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
      <ProgressBar value={progress.percent} className="mt-4" />
      <p className="mt-2 text-xs text-muted-foreground">{progress.percent}%</p>
    </div>
  );
}

function UploadHeroCard({
  onActiveUploadChange
}: {
  onActiveUploadChange: (upload: ActiveUploadProject | null) => void;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [link, setLink] = useState('');
  const [transcript, setTranscript] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [canCancelUpload, setCanCancelUpload] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function setUploadProgress(nextProgress: UploadProgress | null) {
    setProgress(nextProgress);
    onActiveUploadChange(
      nextProgress
        ? {
            ...nextProgress,
            projectId: null,
            title:
              deriveProjectTitle({
                file: selectedFile,
                link,
                transcript
              }) || nextProgress.fileName,
            error: null
          }
        : null
    );
  }

  function setUploadProjectProgress(
    projectId: number | null,
    projectTitle: string,
    nextProgress: UploadProgress,
    nextError: string | null = null
  ) {
    setProgress(nextProgress);
    onActiveUploadChange({
      ...nextProgress,
      projectId,
      title: projectTitle,
      error: nextError
    });
  }

  async function createUploadProject(projectTitle: string) {
    const formData = new FormData();
    formData.set('name', projectTitle);
    formData.set('description', '');
    const result = await createProject({}, formData);

    if ('error' in result || !('project' in result)) {
      throw new Error(
        'error' in result ? result.error : 'Project could not be created.'
      );
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
          onActiveUploadChange({
            projectId,
            title: uploadTitle,
            percent: snapshot.percent,
            etaSeconds: snapshot.etaSeconds,
            label: snapshot.percent >= 100 ? 'Attaching upload' : 'Uploading',
            fileName: file.name,
            error: null
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
      await uploadSourceAssetViaServer({
        file,
        projectId,
        title: uploadTitle
      });
      return;
    }

    setCanCancelUpload(false);
    setUploadProjectProgress(projectId, uploadTitle, {
      percent: 100,
      etaSeconds: 0,
      label: 'Saving upload',
      fileName: file.name
    });

    await readJsonResponse(
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
    setSelectedFile(null);
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

    const nextFile = assetOverride?.file ?? selectedFile;
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
      setUploadProgress({
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
        submitError instanceof Error ? submitError.message : 'Upload could not start.';
      setError(message);
      if (progress) {
        onActiveUploadChange({
          projectId: null,
          title: normalizedTitle,
          ...progress,
          error: message
        });
      }
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
    setSelectedFile(file);
    setError(null);
    setLink('');
    setTranscript('');
  }

  async function handleUploadButtonClick() {
    if (selectedFile) {
      await startSubmission({ file: selectedFile, link: '', transcript: '' });
      return;
    }

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
                  setSelectedFile(null);
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
                className="h-10 rounded-md border border-white/15 bg-white text-black hover:bg-white/90"
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
                void handleSelectedFile(event.target.files?.[0] || null);
                event.target.value = '';
              }}
            />
            <Button
              type="button"
              className="rounded-md border border-white/15 bg-white text-black hover:bg-white/90"
              disabled={isSubmitting}
              onClick={() => void handleUploadButtonClick()}
            >
              <Upload className="h-4 w-4" />
              Upload file
            </Button>
            {selectedFile ? (
              <div className="flex min-w-0 items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
                <p className="max-w-[220px] truncate text-xs text-muted-foreground">
                  {selectedFile.name}
                </p>
                <button
                  type="button"
                  className="shrink-0 text-white/45 transition hover:text-white"
                  disabled={isSubmitting}
                  onClick={() => setSelectedFile(null)}
                  aria-label="Remove selected file"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : null}
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

function ActiveUploadProjectCard({ upload }: { upload: ActiveUploadProject }) {
  const content = (
    <article className="overflow-hidden rounded-xl border border-white/10 bg-card">
      <div className="relative aspect-video bg-[linear-gradient(135deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02)_55%,rgba(255,255,255,0.08))]">
        <div className="absolute left-4 top-4">
          <StatusBadge
            status={upload.error ? 'failed' : 'uploading'}
            className={statusClasses(upload.error ? 'failed' : 'uploading')}
          />
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-white/10 text-white ring-1 ring-white/15">
            {upload.error ? <X className="h-6 w-6" /> : <Loader2 className="h-6 w-6 animate-spin" />}
          </span>
        </div>
        <ProgressBar value={upload.percent} className="absolute inset-x-4 bottom-4 h-1.5" />
      </div>
      <div className="p-4">
        <h2 className="truncate text-sm font-semibold text-foreground">
          {upload.title}
        </h2>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {upload.fileName}
        </p>
        <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{upload.error || upload.label}</span>
          <span>
            {upload.percent}% · {formatUploadEta(upload.etaSeconds)}
          </span>
        </div>
      </div>
    </article>
  );

  return upload.projectId ? (
    <Link href={`/dashboard/projects/${upload.projectId}`}>{content}</Link>
  ) : (
    content
  );
}

function ProjectCard({ project }: { project: ProjectHubSummary }) {
  const status = deriveProjectStatus(project);
  const latestAsset = project.sourceAssets[0] || null;
  const thumbnail = getSourceAssetThumbnail(latestAsset);
  const clips = candidateCount(project);
  const approved = approvedCount(project);
  const secondaryLabel =
    latestAsset?.assetType === SourceAssetType.YOUTUBE_URL
      ? 'YouTube'
      : latestAsset?.assetType === SourceAssetType.PASTED_TRANSCRIPT
        ? 'Transcript'
        : 'Uploaded video';
  const tertiaryLabel =
    clips > 0 ? `${clips} clips` : approved > 0 ? `${approved} approved` : projectDate(project.updatedAt);

  return (
    <Link href={`/dashboard/projects/${project.id}`} className="block">
      <article className="group space-y-1">
        <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-black">
          {thumbnail?.kind === 'image' ? (
            <img
              src={thumbnail.src}
              alt={thumbnail.alt}
              className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))]">
              <div className="flex items-center gap-1.5 rounded-full bg-black/40 px-2.5 py-1 text-[11px] text-white/70">
                <Clapperboard className="h-3.5 w-3.5" />
                Video
              </div>
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/0 to-black/0" />
        </div>
        <div className="px-0.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-0.5">
              <h2 className="truncate text-sm font-medium tracking-[-0.01em] text-white">
                {latestAsset?.originalFilename || latestAsset?.title || project.name}
              </h2>
              <p className="truncate text-[10px] text-white/55">{secondaryLabel}</p>
            </div>
            <span className="pt-0.5 text-sm leading-none text-white/70 transition group-hover:text-white">
              ...
            </span>
          </div>
          <p className="text-[10px] text-white/40">{tertiaryLabel}</p>
        </div>
      </article>
    </Link>
  );
}

function ProjectGrid({
  projects,
  activeUpload
}: {
  projects: ProjectHubSummary[];
  activeUpload: ActiveUploadProject | null;
}) {
  if (projects.length === 0) {
    return (
      <>
        {activeUpload ? <ActiveUploadProjectCard upload={activeUpload} /> : null}
        {!activeUpload ? (
          <EmptyState
            title="No projects yet"
            description="Upload a source above and recent projects will appear here."
            className="p-8"
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {activeUpload ? <ActiveUploadProjectCard upload={activeUpload} /> : null}
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
  );
}

export function HomePage({ projects }: { projects: ProjectHubSummary[] }) {
  const [activeUpload, setActiveUpload] = useState<ActiveUploadProject | null>(
    null
  );
  const sortedProjects = useMemo(
    () =>
      [...projects].map((project) => ({
        ...project,
        sourceAssets: [...project.sourceAssets].sort(
          (left, right) =>
            new Date(right.updatedAt || project.updatedAt).getTime() -
            new Date(left.updatedAt || project.updatedAt).getTime()
        )
      })),
    [projects]
  );

  return (
    <section className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-7xl space-y-12">
        <UploadHeroCard onActiveUploadChange={setActiveUpload} />
        <div>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-foreground">Recent projects</h2>
            <Button asChild variant="outline">
              <Link href="/dashboard/projects">View library</Link>
            </Button>
          </div>
          <ProjectGrid projects={sortedProjects} activeUpload={activeUpload} />
        </div>
      </div>
    </section>
  );
}
