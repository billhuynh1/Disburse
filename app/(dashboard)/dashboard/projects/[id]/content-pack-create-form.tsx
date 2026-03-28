'use client';

import { useActionState, useEffect, useRef } from 'react';
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
import { NativeSelect } from '@/components/ui/native-select';
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
  const [state, formAction, isPending] = useActionState<
    CreateContentPackState,
    FormData
  >(createContentPack, {});

  useEffect(() => {
    if (!state.success) {
      return;
    }

    formRef.current?.reset();
    router.refresh();
  }, [router, state.success]);

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
          <form ref={formRef} action={formAction} className="space-y-4">
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
              <NativeSelect
                id="sourceAssetId"
                name="sourceAssetId"
                required
                defaultValue=""
              >
                <option value="" disabled>
                  Select a source asset
                </option>
                {sourceAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.title} ({getSourceAssetTypeLabel(asset.assetType)})
                  </option>
                ))}
              </NativeSelect>
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
                placeholder="instructions"
                className="min-h-28"
              />
            </div>

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
