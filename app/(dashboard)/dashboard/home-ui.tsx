'use client';

import Link from 'next/link';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle2,
  Clapperboard,
  FileVideo,
  Loader2,
  Sparkles,
  Upload,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createProject, createSourceAsset } from '@/lib/disburse/actions';
import {
  ContentPackKind,
  ContentPackStatus,
  SourceAssetStatus,
  SourceAssetType,
  TranscriptStatus
} from '@/lib/db/schema';
import { cn } from '@/lib/utils';
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

type ProjectHubSummary = {
  id: number;
  name: string;
  description: string | null;
  updatedAt: Date | string;
  sourceAssets: {
    id: number;
    title: string;
    assetType: string;
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
    return 'bg-emerald-400/12 text-emerald-200 ring-emerald-300/20';
  }

  if (status === 'failed') {
    return 'bg-red-400/12 text-red-200 ring-red-300/20';
  }

  if (['processing', 'queued', 'uploaded', 'personalizing'].includes(status)) {
    return 'bg-amber-400/12 text-amber-200 ring-amber-300/20';
  }

  return 'bg-muted text-muted-foreground ring-border/80';
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

function ProjectStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize ring-1 ring-inset',
        statusClasses(status)
      )}
    >
      {status.replaceAll('_', ' ')}
    </span>
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
    <div className="rounded-xl border border-border/70 bg-surface-1 p-4">
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
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-background">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
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
  const [mode, setMode] = useState<UploadMode>('file');
  const [title, setTitle] = useState('');
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
            title: title.trim() || nextProgress.fileName,
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const normalizedTitle =
      title.trim() ||
      (selectedFile ? createSourceAssetTitleFromFilename(selectedFile.name) : '') ||
      'Untitled video';

    if (mode === 'file') {
      if (!selectedFile) {
        setError('Select a video or audio file to upload.');
        return;
      }

      if (!isSupportedSourceAssetUpload(selectedFile.name, selectedFile.type)) {
        setError(`Unsupported file type. Upload ${SOURCE_ASSET_ALLOWED_FORMAT_LABEL}.`);
        return;
      }

      if (selectedFile.size > MAX_SOURCE_ASSET_FILE_SIZE_BYTES) {
        setError('File exceeds the 500 MB upload limit.');
        return;
      }
    }

    if (mode === 'youtube' && !link.trim()) {
      setError('Paste a YouTube URL to continue.');
      return;
    }

    if (mode === 'transcript' && !transcript.trim()) {
      setError('Paste transcript text to continue.');
      return;
    }

    try {
      setIsSubmitting(true);
      setUploadProgress({
        percent: 0,
        etaSeconds: null,
        label: 'Creating project',
        fileName: selectedFile?.name || normalizedTitle
      });

      const project = await createUploadProject(normalizedTitle);
      setUploadProjectProgress(project.id, normalizedTitle, {
        percent: 0,
        etaSeconds: null,
        label: mode === 'file' ? 'Preparing upload' : 'Saving source',
        fileName: selectedFile?.name || normalizedTitle
      });

      if (mode === 'file' && selectedFile) {
        await handleFileUpload(project.id, selectedFile, normalizedTitle);
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
          mode === 'youtube'
            ? SourceAssetType.YOUTUBE_URL
            : SourceAssetType.PASTED_TRANSCRIPT
        );

        if (mode === 'youtube') {
          formData.set('sourceUrl', link.trim());
        } else {
          formData.set('transcriptLanguage', 'en');
          formData.set('transcriptContent', transcript.trim());
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

  return (
    <Card className="mx-auto max-w-3xl overflow-hidden border-primary/20 bg-[linear-gradient(180deg,hsl(var(--surface-1)),hsl(var(--card)))] shadow-[0_28px_90px_rgba(0,0,0,0.32)]">
      <CardContent className="space-y-5 p-5 sm:p-7">
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/20">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground sm:text-3xl">
            Upload a video. Get a clip review queue.
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            Paste a video link or upload a file to start a project from here.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {[
              { value: 'file', label: 'Upload' },
              { value: 'youtube', label: 'Video link' },
              { value: 'transcript', label: 'Transcript' }
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value as UploadMode)}
                className={cn(
                  'rounded-lg border px-3 py-2 text-sm font-medium transition',
                  mode === option.value
                    ? 'border-primary/60 bg-primary/15 text-primary'
                    : 'border-border/70 bg-background/40 text-muted-foreground hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div>
            <Label htmlFor="upload-title" className="mb-2">
              Project title
            </Label>
            <Input
              id="upload-title"
              value={title}
              placeholder="Podcast episode, stream, webinar, or video title"
              maxLength={150}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          {mode === 'file' ? (
            <div
              className="rounded-xl border border-dashed border-border/80 bg-background/35 p-5 text-center"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files?.[0] || null;
                setSelectedFile(file);
                if (file && !title.trim()) {
                  setTitle(createSourceAssetTitleFromFilename(file.name));
                }
              }}
            >
              <FileVideo className="mx-auto h-7 w-7 text-primary" />
              <p className="mt-3 text-sm font-medium text-foreground">
                Drop a video here or choose a file
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {SOURCE_ASSET_ALLOWED_FORMAT_LABEL} up to 500 MB.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept={SOURCE_ASSET_UPLOAD_ACCEPT_ATTRIBUTE}
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] || null;
                  setSelectedFile(file);
                  if (file && !title.trim()) {
                    setTitle(createSourceAssetTitleFromFilename(file.name));
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
                Choose file
              </Button>
              {selectedFile ? (
                <p className="mt-3 truncate text-sm text-muted-foreground">
                  {selectedFile.name}
                </p>
              ) : null}
            </div>
          ) : null}

          {mode === 'youtube' ? (
            <div>
              <Label htmlFor="source-url" className="mb-2">
                Video link
              </Label>
              <Input
                id="source-url"
                type="url"
                value={link}
                placeholder="https://youtube.com/watch?v=..."
                onChange={(event) => setLink(event.target.value)}
              />
            </div>
          ) : null}

          {mode === 'transcript' ? (
            <div>
              <Label htmlFor="transcript" className="mb-2">
                Transcript
              </Label>
              <Textarea
                id="transcript"
                value={transcript}
                rows={7}
                maxLength={20000}
                placeholder="Paste transcript text"
                className="min-h-36"
                onChange={(event) => setTranscript(event.target.value)}
              />
            </div>
          ) : null}

          {progress ? (
            <UploadProgressCard
              progress={progress}
              canCancel={canCancelUpload}
              onCancel={() => abortControllerRef.current?.abort()}
            />
          ) : null}

          {error ? <p className="text-sm text-red-300">{error}</p> : null}

          <Button type="submit" size="lg" disabled={isSubmitting} className="w-full">
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Get clips
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ActiveUploadProjectCard({ upload }: { upload: ActiveUploadProject }) {
  const content = (
    <article className="overflow-hidden rounded-xl border border-primary/35 bg-card">
      <div className="relative aspect-video bg-[linear-gradient(135deg,hsl(var(--shell)),hsl(var(--surface-2))_55%,hsl(var(--primary)/0.28))]">
        <div className="absolute left-4 top-4">
          <ProjectStatusBadge status={upload.error ? 'failed' : 'uploading'} />
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-background/70 text-primary ring-1 ring-border/80">
            {upload.error ? <X className="h-6 w-6" /> : <Loader2 className="h-6 w-6 animate-spin" />}
          </span>
        </div>
        <div className="absolute inset-x-4 bottom-4 h-1.5 overflow-hidden rounded-full bg-background/70">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${upload.percent}%` }}
          />
        </div>
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
  const clips = candidateCount(project);
  const approved = approvedCount(project);

  return (
    <Link href={`/dashboard/projects/${project.id}`} className="block">
      <article className="group overflow-hidden rounded-xl border border-border/70 bg-card transition hover:border-primary/35">
        <div className="relative aspect-video bg-[linear-gradient(135deg,hsl(var(--shell)),hsl(var(--surface-2))_55%,hsl(var(--primary)/0.28))]">
          <div className="absolute left-4 top-4">
            <ProjectStatusBadge status={status} />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-background/70 text-primary ring-1 ring-border/80">
              <Clapperboard className="h-6 w-6" />
            </span>
          </div>
          <div className="absolute inset-x-4 bottom-4 h-1.5 overflow-hidden rounded-full bg-background/70">
            <div
              className="h-full rounded-full bg-primary"
              style={{
                width:
                  status === 'ready'
                    ? '100%'
                    : status === 'processing'
                      ? '62%'
                      : status === 'uploaded' || status === 'personalizing'
                        ? '38%'
                        : '12%'
              }}
            />
          </div>
        </div>
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {latestAsset?.title || project.name}
              </h2>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {latestAsset?.originalFilename || project.description || 'No source yet'}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
            <span>{clips} candidates</span>
            <span>{approved} approved</span>
            <span>{projectDate(project.updatedAt)}</span>
          </div>
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
          <div className="rounded-xl border border-dashed border-border/80 bg-surface-1/70 p-8 text-center">
            <CheckCircle2 className="mx-auto mb-3 h-7 w-7 text-primary" />
            <p className="text-sm font-medium text-foreground">No projects yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload a source above and recent projects will appear here.
            </p>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
      <div className="mx-auto max-w-7xl space-y-8">
        <UploadHeroCard onActiveUploadChange={setActiveUpload} />
        <div>
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                Recent projects
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Continue setup, review candidates, or export approved clips.
              </p>
            </div>
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
