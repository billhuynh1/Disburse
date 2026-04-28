'use client';

import Link from 'next/link';
import { useActionState, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Captions,
  CheckCircle2,
  Clock3,
  Loader2,
  ScanFace,
  Sparkles,
  WandSparkles
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { generateShortFormPack } from '@/lib/disburse/actions';
import { SourceAssetType, TranscriptStatus } from '@/lib/db/schema';
import { cn } from '@/lib/utils';

type SetupSourceAsset = {
  id: number;
  title: string;
  assetType: string;
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

const stages = [
  'Upload complete',
  'Transcribing',
  'Detecting scenes',
  'Detecting facecam',
  'Finding highlight moments',
  'Generating candidates',
  'Ready'
];

function TogglePill({
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
      onClick={() => onChange(!checked)}
      className={cn(
        'flex items-center justify-between rounded-xl border px-3 py-2 text-sm transition',
        checked
          ? 'border-primary/50 bg-primary/15 text-primary'
          : 'border-border/70 bg-background/35 text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
      <span
        className={cn(
          'h-5 w-9 rounded-full p-0.5 transition',
          checked ? 'bg-primary' : 'bg-muted'
        )}
      >
        <span
          className={cn(
            'block size-4 rounded-full bg-background transition',
            checked && 'translate-x-4'
          )}
        />
      </span>
    </button>
  );
}

function ProcessingProgressSteps({ active }: { active: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Processing stages
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {stages.map((stage, index) => {
          const isActive = active && index <= 5;
          const isReady = !active && index === 0;

          return (
            <div key={stage} className="flex items-center gap-3 text-sm">
              <span
                className={cn(
                  'flex size-7 items-center justify-center rounded-full border',
                  isActive || isReady
                    ? 'border-primary/50 bg-primary/15 text-primary'
                    : 'border-border/70 text-muted-foreground'
                )}
              >
                {isActive ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
              </span>
              <span className={isActive || isReady ? 'text-foreground' : 'text-muted-foreground'}>
                {stage}
              </span>
            </div>
          );
        })}
        <p className="pt-2 text-xs leading-5 text-muted-foreground">
          Processing may take a few minutes. This page uses existing polling and
          status refresh behavior after generation is queued.
        </p>
      </CardContent>
    </Card>
  );
}

function ClipPreferencesForm({
  project,
  sourceAssets
}: ProjectSetupPageProps) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    generateShortFormPack,
    {}
  );
  const generatableAssets = sourceAssets.filter(
    (asset) =>
      asset.assetType !== SourceAssetType.PASTED_TRANSCRIPT &&
      asset.transcriptStatus === TranscriptStatus.READY
  );
  const [selectedSourceAssetId, setSelectedSourceAssetId] = useState(
    String(generatableAssets[0]?.id || sourceAssets[0]?.id || '')
  );
  const [captions, setCaptions] = useState(true);
  const [autoHook, setAutoHook] = useState(true);
  const [facecam, setFacecam] = useState(true);

  const selectedAsset = useMemo(
    () =>
      sourceAssets.find((asset) => String(asset.id) === selectedSourceAssetId) ||
      null,
    [selectedSourceAssetId, sourceAssets]
  );
  const canGenerate =
    selectedAsset &&
    selectedAsset.assetType !== SourceAssetType.PASTED_TRANSCRIPT &&
    selectedAsset.transcriptStatus === TranscriptStatus.READY &&
    selectedAsset.retentionStatus !== 'expired' &&
    selectedAsset.retentionStatus !== 'deleted' &&
    !selectedAsset.storageDeletedAt;

  useEffect(() => {
    if (state.success) {
      router.push(`/dashboard/projects/${project.id}`);
    }
  }, [project.id, router, state.success]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Personalize clip generation</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-5">
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="sourceAssetId" value={selectedSourceAssetId} />
          <input type="hidden" name="captionsEnabled" value={String(captions)} />
          <input type="hidden" name="autoHookEnabled" value={String(autoHook)} />
          <input type="hidden" name="facecamDetectionEnabled" value={String(facecam)} />

          <div>
            <Label htmlFor="sourceAssetId" className="mb-2">
              Source
            </Label>
            <NativeSelect
              id="sourceAssetId"
              value={selectedSourceAssetId}
              onChange={(event) => setSelectedSourceAssetId(event.target.value)}
            >
              {sourceAssets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.title} ({asset.transcriptStatus.replaceAll('_', ' ')})
                </option>
              ))}
            </NativeSelect>
          </div>

          <div>
            <Label htmlFor="goal" className="mb-2">
              Clip goal
            </Label>
            <Textarea
              id="goal"
              name="clipGoal"
              rows={5}
              placeholder="Find the funniest, highest-energy, or most educational moments."
              className="min-h-28"
              maxLength={2000}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="genre" className="mb-2">
                Content type
              </Label>
              <NativeSelect id="genre" name="contentType" defaultValue="auto">
                {['Auto', 'Gaming', 'Podcast', 'Talking Head', 'Interview', 'Educational', 'Other'].map(
                  (item) => (
                    <option key={item} value={item.toLowerCase().replaceAll(' ', '_')}>
                      {item}
                    </option>
                  )
                )}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="clipLength" className="mb-2">
                Clip length
              </Label>
              <NativeSelect id="clipLength" name="clipLength" defaultValue="auto">
                {['Auto', '15-30s', '30-60s', '60-90s', '1-3m'].map((item) => (
                  <option key={item} value={item.toLowerCase()}>
                    {item}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="language" className="mb-2">
                Language
              </Label>
              <NativeSelect id="language" name="language" defaultValue="auto">
                {['Auto', 'English', 'Spanish', 'French', 'German'].map((item) => (
                  <option key={item} value={item.toLowerCase()}>
                    {item}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="layout" className="mb-2">
                Default layout
              </Label>
              <NativeSelect id="layout" name="layoutPreference" defaultValue="auto">
                {[
                  'Auto',
                  'Gameplay + Facecam',
                  'Split',
                  'Facecam Focus',
                  'Gameplay Focus',
                  'Vertical Smart Crop'
                ].map((item) => (
                  <option key={item} value={item.toLowerCase().replaceAll(' ', '_')}>
                    {item}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <TogglePill label="Captions" checked={captions} onChange={setCaptions} />
            <TogglePill label="Auto hook" checked={autoHook} onChange={setAutoHook} />
            <TogglePill label="Facecam" checked={facecam} onChange={setFacecam} />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="timeframeStart" className="mb-2">
                Start time
              </Label>
              <Input
                id="timeframeStart"
                name="timeframeStart"
                placeholder="Optional, e.g. 00:30"
                maxLength={40}
              />
            </div>
            <div>
              <Label htmlFor="timeframeEnd" className="mb-2">
                End time
              </Label>
              <Input
                id="timeframeEnd"
                name="timeframeEnd"
                placeholder="Optional, e.g. 12:00"
                maxLength={40}
              />
            </div>
          </div>

          {!canGenerate ? (
            <p className="rounded-xl border border-amber-300/20 bg-amber-400/10 p-3 text-sm leading-6 text-amber-100">
              {selectedAsset?.assetType === SourceAssetType.PASTED_TRANSCRIPT
                ? 'Short-form clips require uploaded media or a YouTube source.'
                : 'Transcript is not ready yet. Processing may take a few minutes.'}
            </p>
          ) : null}

          {state.error ? <p className="text-sm text-red-300">{state.error}</p> : null}

          <Button type="submit" disabled={!canGenerate || isPending}>
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <WandSparkles className="h-4 w-4" />
            )}
            Generate clips
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function ProjectSetupPage({ project, sourceAssets }: ProjectSetupPageProps) {
  const isProcessing = sourceAssets.some((asset) =>
    ['pending', 'processing'].includes(asset.transcriptStatus)
  );

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
          <div className="hidden items-center gap-2 rounded-full border border-border/70 bg-surface-1 px-3 py-2 text-sm text-muted-foreground md:flex">
            <Clock3 className="h-4 w-4 text-primary" />
            Processing may take a few minutes
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <ClipPreferencesForm project={project} sourceAssets={sourceAssets} />
          <ProcessingProgressSteps active={isProcessing} />
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-border/70 bg-surface-1 p-4">
            <Captions className="mb-3 h-5 w-5 text-primary" />
            <p className="text-sm font-medium text-foreground">Captions ready</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Caption preference is saved with the clip generation instructions.
            </p>
          </div>
          <div className="rounded-xl border border-border/70 bg-surface-1 p-4">
            <ScanFace className="mb-3 h-5 w-5 text-primary" />
            <p className="text-sm font-medium text-foreground">Facecam aware</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Detection can be run per candidate in the review workspace.
            </p>
          </div>
          <div className="rounded-xl border border-border/70 bg-surface-1 p-4">
            <Sparkles className="mb-3 h-5 w-5 text-primary" />
            <p className="text-sm font-medium text-foreground">Multiple candidates</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Generation creates a ranked queue, not a single output.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
