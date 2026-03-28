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
  sourceAssets
}: {
  projectId: number;
  sourceAssets: SourceAssetOption[];
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
    <Card>
      <CardHeader>
        <CardTitle>Create Content Pack</CardTitle>
        <CardDescription>
          Link a source asset to a content pack that will later drive
          repurposed outputs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sourceAssets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
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
              <Label htmlFor="name" className="mb-2">
                Content Pack Name
              </Label>
              <Input
                id="name"
                name="name"
                placeholder="content pack name"
                maxLength={150}
                required
              />
            </div>

            <div>
              <Label htmlFor="sourceAssetId" className="mb-2">
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
              <Label htmlFor="instructions" className="mb-2">
                Instructions
              </Label>
              <Textarea
                id="instructions"
                name="instructions"
                rows={5}
                maxLength={5000}
                className="min-h-28"
              />
            </div>

            {clientError && <p className="text-sm text-red-500">{clientError}</p>}
            {state.error && <p className="text-sm text-red-500">{state.error}</p>}
            {state.success && (
              <p className="text-sm text-green-600">{state.success}</p>
            )}

            <Button
              type="submit"
              disabled={isPending}
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
