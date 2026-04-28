'use client';

import { type FormEvent, useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Layers3, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  SingleSelectPicker,
  type SingleSelectPickerOption
} from '@/components/ui/single-select-picker';
import { Textarea } from '@/components/ui/textarea';
import { createContentPack } from '@/lib/disburse/actions';
import { getSourceAssetTypeLabel } from '@/lib/disburse/presentation';
import { FormMessage } from '@/components/dashboard/dashboard-ui';

type SourceAssetOption = {
  id: number;
  title: string;
  assetType: string;
};

type CreateContentPackState = {
  error?: string;
  success?: string;
};

export function ContentPackCreateForm({
  projectId,
  sourceAssets,
  variant = 'default'
}: {
  projectId: number;
  sourceAssets: SourceAssetOption[];
  variant?: 'default' | 'editor';
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [selectedSourceAssetId, setSelectedSourceAssetId] = useState('');
  const [state, formAction, isPending] = useActionState<
    CreateContentPackState,
    FormData
  >(createContentPack, {});
  const sourceAssetOptions: SingleSelectPickerOption[] = sourceAssets.map(
    (asset) => ({
      value: String(asset.id),
      label: asset.title,
      description: getSourceAssetTypeLabel(asset.assetType)
    })
  );
  const isEditor = variant === 'editor';
  const editorInputClass = isEditor
    ? 'border-slate-200 bg-white text-slate-950 shadow-none placeholder:text-slate-400'
    : undefined;
  const editorLabelClass = isEditor ? 'text-slate-700' : undefined;

  useEffect(() => {
    if (!state.success) {
      return;
    }

    formRef.current?.reset();
    setClientError(null);
    setSelectedSourceAssetId('');
    router.refresh();
  }, [router, state.success]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (selectedSourceAssetId) {
      setClientError(null);
      return;
    }

    event.preventDefault();
    setClientError('Select a source asset.');
  }

  return (
    <Card
      className={
        isEditor
          ? 'gap-4 rounded-2xl border-slate-200 bg-white py-4 text-slate-950 shadow-none'
          : undefined
      }
    >
      <CardHeader>
        <CardTitle className={isEditor ? 'text-slate-950' : undefined}>
          Create Content Pack
        </CardTitle>
        <CardDescription className={isEditor ? 'text-slate-500' : undefined}>
          Link a source asset to a content pack that will later drive
          repurposed outputs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sourceAssets.length === 0 ? (
          <p className={`text-sm ${isEditor ? 'text-slate-500' : 'text-muted-foreground'}`}>
            Add a source asset first. Content packs are created from an existing
            project source.
          </p>
        ) : (
          <form
            ref={formRef}
            action={formAction}
            className="space-y-4"
            onSubmit={handleSubmit}
          >
            <input type="hidden" name="projectId" value={projectId} />

            <div>
              <Label htmlFor="name" className={`mb-2 ${editorLabelClass || ''}`}>
                Content Pack Name
              </Label>
              <Input
                id="name"
                name="name"
                placeholder="content pack name"
                maxLength={150}
                required
                className={editorInputClass}
              />
            </div>

            <div>
              <Label
                htmlFor="sourceAssetId"
                className={`mb-2 ${editorLabelClass || ''}`}
              >
                Source Asset
              </Label>
              <SingleSelectPicker
                aria-invalid={Boolean(clientError || state.error)}
                id="sourceAssetId"
                name="sourceAssetId"
                emptyMessage="No source assets match your search."
                onValueChange={(value) => {
                  setSelectedSourceAssetId(value);
                  setClientError(null);
                }}
                options={sourceAssetOptions}
                placeholder="Select a source asset"
                required
                value={selectedSourceAssetId}
              />
            </div>

            <div>
              <Label
                htmlFor="instructions"
                className={`mb-2 ${editorLabelClass || ''}`}
              >
                Instructions
              </Label>
              <Textarea
                id="instructions"
                name="instructions"
                rows={5}
                maxLength={5000}
                className={`min-h-28 ${editorInputClass || ''}`}
              />
            </div>

            {clientError && <FormMessage tone="error">{clientError}</FormMessage>}
            {state.error && <FormMessage tone="error">{state.error}</FormMessage>}
            {state.success && (
              <FormMessage tone="success">{state.success}</FormMessage>
            )}

            <Button
              type="submit"
              disabled={isPending}
              className={
                isEditor
                  ? 'bg-slate-950 text-white shadow-none hover:bg-slate-800'
                  : undefined
              }
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Layers3 className="mr-2 h-4 w-4" />
                  Create Content Pack
                </>
              )}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
