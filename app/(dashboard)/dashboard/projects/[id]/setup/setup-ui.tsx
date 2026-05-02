'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
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
import { SourceAssetType, TranscriptStatus } from '@/lib/db/schema';

type SetupSourceAsset = {
  id: number;
  title: string;
  assetType: string;
  mimeType: string | null;
  storageUrl: string;
  mediaUrl: string;
  retentionStatus: string | null;
  storageDeletedAt: string | null;
  transcriptStatus: string;
  shortFormPackStatus: string | null;
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

const THUMBNAIL_MAX_HEIGHT_PX = 480;

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

function extractVideoThumbnail(
  sourceUrl: string
): Promise<{ src: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.playsInline = true;
    video.muted = true;

    let hasCaptured = false;

    function cleanup() {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }

    function captureFrame() {
      if (hasCaptured || !video.videoWidth || !video.videoHeight) {
        return;
      }

      hasCaptured = true;

      const height = Math.min(video.videoHeight, THUMBNAIL_MAX_HEIGHT_PX);
      const width = Math.max(
        1,
        Math.round((height / video.videoHeight) * video.videoWidth)
      );
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');

      if (!context) {
        cleanup();
        reject(new Error('Canvas context unavailable.'));
        return;
      }

      let src: string;

      try {
        context.drawImage(video, 0, 0, width, height);
        src = canvas.toDataURL('image/jpeg', 0.72);
      } catch {
        cleanup();
        reject(new Error('Thumbnail frame could not be read.'));
        return;
      }

      cleanup();
      resolve({ src, width, height });
    }

    video.addEventListener('loadeddata', () => {
      if (video.currentTime > 0) {
        captureFrame();
        return;
      }

      const seekTime = Math.min(0.1, Math.max(video.duration * 0.01, 0));

      if (Number.isFinite(seekTime) && seekTime > 0) {
        video.currentTime = seekTime;
        return;
      }

      captureFrame();
    });

    video.addEventListener('seeked', captureFrame);
    video.addEventListener('error', () => {
      cleanup();
      reject(new Error('Thumbnail extraction failed.'));
    });

    video.src = sourceUrl;
  });
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

    setThumbnail(null);

    if (!asset) {
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

        setThumbnail({
          kind: 'image',
          src: result.src,
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
  sourceAsset
}: {
  project: ProjectSetupPageProps['project'];
  sourceAsset: SetupSourceAsset | null;
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
      router.push(`/dashboard/projects/${project.id}`);
    }
  }, [project.id, router, state.success]);

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
              options={[
                { label: 'Clips only', value: 'clips_only' },
                { label: 'Clips + X posts', value: 'clips_x_posts' },
                { label: 'Clips + LinkedIn posts', value: 'clips_linkedin_posts' },
                { label: 'Full content pack', value: 'full_content_pack' }
              ]}
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
                  ? 'border-red-300/20 bg-red-400/10 text-red-100'
                  : 'border-amber-300/20 bg-amber-400/10 text-amber-100'
              ].join(' ')}
            >
              {unavailableMessage}
            </p>
          ) : null}

          {state.error ? <p className="text-sm text-red-300">{state.error}</p> : null}

          <Button type="submit" disabled={!canGenerate || isPending}>
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Generate clips
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function ProjectSetupPage({ project, sourceAssets }: ProjectSetupPageProps) {
  const sourceAsset =
    sourceAssets.find((asset) => asset.assetType === SourceAssetType.UPLOADED_FILE) ||
    sourceAssets.find((asset) => asset.assetType === SourceAssetType.YOUTUBE_URL) ||
    null;

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
          <ClipPreferencesForm project={project} sourceAsset={sourceAsset} />
        </div>
      </div>
    </section>
  );
}
