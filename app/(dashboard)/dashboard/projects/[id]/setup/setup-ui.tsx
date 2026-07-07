'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Loader2,
} from 'lucide-react';
import {
  TemplateCard,
  type BrandTemplateRecord,
  type ReusableAssetRecord,
} from '@/app/(dashboard)/dashboard/brand-templates/brand-templates-ui';
import { useSourceAssetThumbnail } from '@/components/dashboard/source-asset-thumbnail';
import { ProjectThumbnailFrame } from '@/components/dashboard/project-thumbnail-frame';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InlineSelect, type InlineSelectOption } from '@/components/ui/inline-select';
import { Label } from '@/components/ui/label';
import { generateShortFormPack } from '@/lib/disburse/actions';
import { SourceAssetType } from '@/lib/db/schema';

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
  templates: BrandTemplateRecord[];
  reusableAssets: ReusableAssetRecord[];
};

type ActionState = {
  error?: string;
  success?: string;
};

function SourceAssetThumbnail({ asset }: { asset: SetupSourceAsset | null }) {
  const { imageSrc, imageAlt, aspectRatio } = useSourceAssetThumbnail(asset);

  return (
    <div
      className="mx-auto w-full max-w-sm lg:mx-0"
      style={{ aspectRatio }}
    >
      <ProjectThumbnailFrame imageSrc={imageSrc} imageAlt={imageAlt} />
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
  templates,
  reusableAssets
}: {
  project: ProjectSetupPageProps['project'];
  sourceAsset: SetupSourceAsset | null;
  templates: ProjectSetupPageProps['templates'];
  reusableAssets: ProjectSetupPageProps['reusableAssets'];
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    generateShortFormPack,
    {}
  );
  const captions = true;
  const [autoHook, setAutoHook] = useState(true);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    templates.find((template) => template.isDefault)?.id?.toString() || ''
  );
  const facecam = true;
  const canGenerate =
    sourceAsset &&
    sourceAsset.retentionStatus !== 'expired' &&
    sourceAsset.retentionStatus !== 'deleted' &&
    !sourceAsset.storageDeletedAt;
  const unavailableMessage = !sourceAsset
    ? 'Upload a source file before generating clips.'
    : 'This source is no longer available.';

  useEffect(() => {
    if (state.success) {
      router.push('/dashboard');
    }
  }, [router, state.success]);

  return (
    <form action={formAction} className="mx-auto w-full max-w-2xl space-y-6">
      <input type="hidden" name="projectId" value={project.id} />
      <input type="hidden" name="sourceAssetId" value={sourceAsset?.id || ''} />
      <input type="hidden" name="captionsEnabled" value={String(captions)} />
      <input type="hidden" name="autoHookEnabled" value={String(autoHook)} />
      <input type="hidden" name="facecamDetectionEnabled" value={String(facecam)} />
      <input type="hidden" name="brandTemplateId" value={selectedTemplateId} />

      <Card className="mx-auto w-full max-w-2xl">
        <CardContent className="space-y-5">
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
                'border-warning/20 bg-warning/10 text-warning'
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
        </CardContent>
      </Card>

      <Card className="mx-auto w-full max-w-2xl gap-0 py-0">
        <CardContent className="space-y-4 px-6 py-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Templates
            </h2>
            <div
              className={selectedTemplateId ? 'flex items-center gap-2' : 'invisible'}
              aria-hidden={!selectedTemplateId}
            >
              <span className="text-xs text-zinc-400">1 selected</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedTemplateId('')}>
                Clear
              </Button>
            </div>
          </div>

          {templates.length > 0 ? (
            <div className="flex flex-wrap justify-start gap-4 overflow-visible">
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  reusableAssets={reusableAssets}
                  onSelect={(selectedTemplate) =>
                    setSelectedTemplateId((current) =>
                      current === selectedTemplate.id.toString()
                        ? ''
                        : selectedTemplate.id.toString()
                    )
                  }
                  selected={selectedTemplateId === template.id.toString()}
                  hideDelete
                  actionLabel={`Apply ${template.name}`}
                  compact
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No templates yet. Create one in{' '}
              <Link href="/dashboard/brand-templates" className="underline underline-offset-4">
                Brand templates
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>
    </form>
  );
}

export function ProjectSetupPage({
  project,
  sourceAssets,
  templates,
  reusableAssets,
}: ProjectSetupPageProps) {
  const sourceAsset =
    sourceAssets.find((asset) => asset.assetType === SourceAssetType.UPLOADED_FILE) ||
    sourceAssets.find((asset) => asset.assetType === SourceAssetType.YOUTUBE_URL) ||
    null;
  const hasActiveClipProcessing = sourceAssets.some(
    (asset) => asset.id === sourceAsset?.id && asset.hasActiveClipProcessing
  );
  const hasFailedClipProcessing = Boolean(sourceAsset?.hasFailedClipProcessing);

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
            templates={templates}
            reusableAssets={reusableAssets}
          />
        </div>
        {hasActiveClipProcessing ? (
          <Card className="mx-auto w-full max-w-2xl">
            <CardContent>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Processing continues in the background. Return to the dashboard to
                track progress.
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
