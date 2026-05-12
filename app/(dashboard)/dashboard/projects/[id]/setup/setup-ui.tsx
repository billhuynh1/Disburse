'use client';

import Link from 'next/link';
import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Loader2,
  WandSparkles
} from 'lucide-react';
import { ProjectThumbnailFrame } from '@/components/dashboard/project-thumbnail-frame';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InlineSelect, type InlineSelectOption } from '@/components/ui/inline-select';
import { Label } from '@/components/ui/label';
import { generateShortFormPack } from '@/lib/disburse/actions';
import { ContentPackStatus, SourceAssetType, TranscriptStatus } from '@/lib/db/schema';
import { extractVideoThumbnail } from '@/lib/disburse/video-thumbnail-client';

type SetupSourceAsset = {
  id: number;
  title: string;
  assetType: string;
  mimeType: string | null;
  storageUrl: string;
  mediaUrl: string;
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  retentionStatus: string | null;
  storageDeletedAt: string | null;
  transcriptStatus: string;
  shortFormPackStatus: string | null;
  hasActiveClipProcessing: boolean;
  hasReadyRenderedClips: boolean;
  hasFailedClipProcessing: boolean;
  failureReason: string | null;
};

type ProjectSetupPageProps = {
  project: {
    id: number;
    name: string;
  };
  sourceAssets: SetupSourceAsset[];
};

type ActionState = {
  error?: string;
  success?: string;
};

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

function SourceAssetThumbnail({ asset }: { asset: SetupSourceAsset | null }) {
  const [thumbnail, setThumbnail] = useState<{
    kind: 'image';
    src: string;
    width: number;
    height: number;
    label: string;
  } | null>(null);

  useEffect(() => {
    let isActive = true;
    let objectUrl: string | null = null;

    setThumbnail(null);

    if (!asset) {
      return () => {
        isActive = false;
      };
    }

    if (asset.thumbnailUrl && asset.thumbnailWidth && asset.thumbnailHeight) {
      setThumbnail({
        kind: 'image',
        src: asset.thumbnailUrl,
        width: asset.thumbnailWidth,
        height: asset.thumbnailHeight,
        label: `Extracted thumbnail: ${asset.thumbnailWidth}x${asset.thumbnailHeight}`
      });
      return () => {
        isActive = false;
      };
    }

    if (asset.assetType === SourceAssetType.YOUTUBE_URL) {
      const videoId = parseYouTubeVideoId(asset.storageUrl);

      if (videoId) {
        setThumbnail({
          kind: 'image',
          src: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          width: 480,
          height: 360,
          label: 'YouTube preview'
        });
        return () => {
          isActive = false;
        };
      }
    }

    if (asset.assetType !== SourceAssetType.UPLOADED_FILE) {
      return () => {
        isActive = false;
      };
    }

    if (asset.mimeType && !asset.mimeType.startsWith('video/')) {
      return () => {
        isActive = false;
      };
    }

    extractVideoThumbnail(asset.mediaUrl)
      .then((result) => {
        if (!isActive) {
          return;
        }

        objectUrl = URL.createObjectURL(result.blob);
        setThumbnail({
          kind: 'image',
          src: objectUrl,
          width: result.width,
          height: result.height,
          label: `Extracted thumbnail: ${result.width}x${result.height}`
        });
      })
      .catch(() => {
        return;
      });

    return () => {
      isActive = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [asset]);

  const aspectRatio =
    thumbnail && thumbnail.width > 0 && thumbnail.height > 0
      ? `${thumbnail.width} / ${thumbnail.height}`
      : asset?.assetType === SourceAssetType.PASTED_TRANSCRIPT
        ? '4 / 3'
        : '16 / 9';

  return (
    <div
      className="mx-auto w-full max-w-sm lg:mx-0"
      style={{ aspectRatio }}
    >
      <ProjectThumbnailFrame
        imageSrc={thumbnail?.src || null}
        imageAlt={asset?.title || 'Source thumbnail'}
      />
    </div>
  );
}

function CompactSelect({
  label,
  name,
  defaultValue,
  options
}: {
  label: string;
  name: string;
  defaultValue: string;
  options: InlineSelectOption[];
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <InlineSelect
        name={name}
        defaultValue={defaultValue}
        options={options}
        ariaLabel={label}
      />
    </div>
  );
}

function CompactSwitch({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex cursor-pointer items-center gap-2 text-sm"
    >
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span
        className={[
          'relative h-5 w-9 rounded-full p-0.5 transition-colors',
          checked ? 'bg-white' : 'bg-muted'
        ].join(' ')}
      >
        <span
          className={[
            'block size-4 rounded-full bg-black transition',
            checked ? 'translate-x-4' : 'translate-x-0'
          ].join(' ')}
        />
      </span>
    </button>
  );
}

function ClipPreferencesForm({
  project,
  sourceAsset,
  onGenerationQueued
}: {
  project: ProjectSetupPageProps['project'];
  sourceAsset: SetupSourceAsset | null;
  onGenerationQueued: () => void;
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    generateShortFormPack,
    {}
  );
  const captions = true;
  const [autoHook, setAutoHook] = useState(true);
  const facecam = true;
  const canGenerate =
    sourceAsset &&
    sourceAsset.transcriptStatus === TranscriptStatus.READY &&
    sourceAsset.retentionStatus !== 'expired' &&
    sourceAsset.retentionStatus !== 'deleted' &&
    !sourceAsset.storageDeletedAt;
  const hasTranscriptFailed =
    sourceAsset?.transcriptStatus === TranscriptStatus.FAILED;
  const unavailableMessage = !sourceAsset
    ? 'Upload a source file before generating clips.'
    : hasTranscriptFailed
      ? sourceAsset.failureReason || 'Transcript processing failed.'
      : 'Transcript is not ready yet. Processing may take a few minutes.';

  useEffect(() => {
    if (state.success) {
      onGenerationQueued();
      router.refresh();
    }
  }, [onGenerationQueued, router, state.success]);

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardContent>
        <form action={formAction} className="space-y-5">
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="sourceAssetId" value={sourceAsset?.id || ''} />
          <input type="hidden" name="captionsEnabled" value={String(captions)} />
          <input type="hidden" name="autoHookEnabled" value={String(autoHook)} />
          <input type="hidden" name="facecamDetectionEnabled" value={String(facecam)} />

          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <CompactSelect
              label="Package"
              name="contentPackage"
              defaultValue="clips_only"
              options={[{ label: 'Clips only', value: 'clips_only' }]}
            />
            <CompactSelect
              label="Genre"
              name="contentType"
              defaultValue="auto"
              options={[
                { label: 'Default', value: 'auto' },
                { label: 'Gaming', value: 'gaming' },
                { label: 'Podcast', value: 'podcast' },
                { label: 'Talking Head', value: 'talking_head' },
                { label: 'Interview', value: 'interview' },
                { label: 'Educational', value: 'educational' },
                { label: 'Other', value: 'other' }
              ]}
            />
            <CompactSelect
              label="Clip Length"
              name="clipLength"
              defaultValue="30-60s"
              options={[
                { label: '15-30s', value: '15-30s' },
                { label: '30-60s', value: '30-60s' },
                { label: '60-90s', value: '60-90s' },
                { label: '1-3m', value: '1-3m' }
              ]}
            />
            <CompactSwitch label="Auto hook" checked={autoHook} onChange={setAutoHook} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal" className="text-sm font-normal text-muted-foreground">
              Include specific moments
            </Label>
            <Input
              id="goal"
              name="clipGoal"
              placeholder="Example: find moments when we talked about the playoffs"
              maxLength={2000}
            />
          </div>

          {!canGenerate ? (
            <p
              className={[
                'rounded-xl border p-3 text-sm leading-6',
                hasTranscriptFailed
                  ? 'border-danger/20 bg-danger/10 text-danger'
                  : 'border-warning/20 bg-warning/10 text-warning'
              ].join(' ')}
            >
              {unavailableMessage}
            </p>
          ) : null}

          {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}

          <Button
            type="submit"
            disabled={
              !canGenerate ||
              isPending ||
              sourceAsset?.hasActiveClipProcessing ||
              Boolean(state.success && !state.error)
            }
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {isPending || (state.success && !state.error)
              ? 'Generating clips'
              : 'Generate clips'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function ProjectSetupPage({ project, sourceAssets }: ProjectSetupPageProps) {
  const router = useRouter();
  const hasRedirectedToResultsRef = useRef(false);
  const [hasQueuedClipGeneration, setHasQueuedClipGeneration] = useState(false);
  const handleGenerationQueued = useCallback(() => {
    setHasQueuedClipGeneration(true);
  }, []);
  const sourceAsset =
    sourceAssets.find((asset) => asset.assetType === SourceAssetType.UPLOADED_FILE) ||
    sourceAssets.find((asset) => asset.assetType === SourceAssetType.YOUTUBE_URL) ||
    null;
  const hasActiveTranscriptWork = sourceAssets.some(
    (asset) =>
      asset.transcriptStatus === TranscriptStatus.PENDING ||
      asset.transcriptStatus === TranscriptStatus.PROCESSING
  );
  const hasActiveClipProcessing = sourceAssets.some(
    (asset) => asset.hasActiveClipProcessing
  );
  const hasReadyClipResults = sourceAssets.some(
    (asset) =>
      asset.shortFormPackStatus === ContentPackStatus.READY &&
      asset.hasReadyRenderedClips &&
      !asset.hasActiveClipProcessing
  );
  const hasFailedClipProcessing = sourceAssets.some(
    (asset) => asset.hasFailedClipProcessing
  );
  const shouldPollProcessing =
    hasActiveTranscriptWork || hasActiveClipProcessing || hasQueuedClipGeneration;

  useEffect(() => {
    if (hasReadyClipResults || hasFailedClipProcessing) {
      setHasQueuedClipGeneration(false);
    }
  }, [hasFailedClipProcessing, hasReadyClipResults]);

  useEffect(() => {
    if (!shouldPollProcessing) {
      return;
    }

    const refreshProcessingState = async () => {
      await fetch('/api/transcripts/statuses', {
        cache: 'no-store'
      }).catch(() => null);
      router.refresh();
    };

    void refreshProcessingState();
    const interval = window.setInterval(() => {
      void refreshProcessingState();
    }, 4000);

    return () => window.clearInterval(interval);
  }, [router, shouldPollProcessing]);

  useEffect(() => {
    if (
      hasRedirectedToResultsRef.current ||
      !hasReadyClipResults ||
      hasActiveTranscriptWork ||
      hasActiveClipProcessing
    ) {
      return;
    }

    hasRedirectedToResultsRef.current = true;
    router.push(`/dashboard/projects/${project.id}`);
  }, [
    hasActiveClipProcessing,
    hasActiveTranscriptWork,
    hasReadyClipResults,
    project.id,
    router
  ]);

  return (
    <section className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Button asChild variant="ghost" className="mb-3 px-0">
              <Link href="/dashboard">
                <ArrowLeft className="h-4 w-4" />
                Home
              </Link>
            </Button>
            <h1 className="text-2xl font-semibold text-foreground">
              Setup for {project.name}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Configure how this video should be analyzed before candidates are
              generated.
            </p>
          </div>
        </div>

        <div className="flex justify-center">
          <SourceAssetThumbnail asset={sourceAsset} />
        </div>

        <div>
          <ClipPreferencesForm
            project={project}
            sourceAsset={sourceAsset}
            onGenerationQueued={handleGenerationQueued}
          />
        </div>
        {hasActiveClipProcessing || hasQueuedClipGeneration ? (
          <Card className="mx-auto w-full max-w-2xl">
            <CardContent>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Processing clips, facecam layout, and edited renders. This page is only watching status.
              </div>
            </CardContent>
          </Card>
        ) : hasFailedClipProcessing ? (
          <Card className="mx-auto w-full max-w-2xl border-danger/20 bg-danger/10">
            <CardContent>
              <p className="text-sm text-danger">
                Clip processing failed. Adjust setup and run generation again.
              </p>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </section>
  );
}
