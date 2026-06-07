'use client';

import { type FormEvent, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  SingleSelectPicker,
  type SingleSelectPickerOption,
} from '@/components/ui/single-select-picker';
import {
  DashboardPageShell,
  EmptyState,
  FormMessage,
} from '@/components/dashboard/dashboard-ui';
import { RenderedClipLayout, ReusableAssetKind } from '@/lib/db/schema';
import { cn } from '@/lib/utils';

type ReusableAssetRecord = {
  id: number;
  kind: string;
  title: string;
  originalFilename: string;
};

type ReusableAssetsResponse = {
  assets?: ReusableAssetRecord[];
};

type BrandTemplateRecord = {
  id: number;
  name: string;
  captions: {
    fontFamily: string;
    fontColor: string;
    highlightColor: string;
    position: 'top' | 'middle' | 'bottom';
    animation: 'none' | 'pop' | 'fade';
    captionFontAssetId: number | null;
  };
  layout: {
    aspectRatio: '9_16' | '1_1' | '16_9';
    defaultLayout: RenderedClipLayout;
    enabledLayouts: RenderedClipLayout[];
  };
  overlays: {
    logoAssetId: number | null;
    ctaUrl: string | null;
  };
  introOutro: {
    introVideoAssetId: number | null;
    outroVideoAssetId: number | null;
  };
  cropSettings: Record<string, unknown>;
  isDefault: boolean;
};

type BrandTemplatesResponse = {
  templates?: BrandTemplateRecord[];
};

type FormState = {
  name: string;
  captionFontFamily: string;
  captionFontColor: string;
  captionHighlightColor: string;
  captionPosition: 'top' | 'middle' | 'bottom';
  captionAnimation: 'none' | 'pop' | 'fade';
  captionFontAssetId: string;
  aspectRatio: '9_16' | '1_1' | '16_9';
  defaultLayout: RenderedClipLayout;
  enabledLayouts: RenderedClipLayout[];
  logoAssetId: string;
  ctaUrl: string;
  introVideoAssetId: string;
  outroVideoAssetId: string;
  isDefault: boolean;
};

type PageMode = 'browse' | 'edit';

const emptyForm: FormState = {
  name: '',
  captionFontFamily: '',
  captionFontColor: '#ffffff',
  captionHighlightColor: '#facc15',
  captionPosition: 'bottom',
  captionAnimation: 'none',
  captionFontAssetId: '',
  aspectRatio: '9_16',
  defaultLayout: RenderedClipLayout.DEFAULT,
  enabledLayouts: [RenderedClipLayout.DEFAULT],
  logoAssetId: '',
  ctaUrl: '',
  introVideoAssetId: '',
  outroVideoAssetId: '',
  isDefault: false,
};

const layoutOptions = [
  { value: RenderedClipLayout.DEFAULT, label: 'Main content' },
  { value: RenderedClipLayout.FACECAM_TOP_50, label: '50/50 split' },
  { value: RenderedClipLayout.FACECAM_TOP_40, label: '40/60 split' },
  { value: RenderedClipLayout.FACECAM_TOP_30, label: '30/70 split' },
] as const;

const aspectRatioOptions: SingleSelectPickerOption[] = [
  { value: '9_16', label: '9:16' },
  { value: '1_1', label: '1:1' },
  { value: '16_9', label: '16:9' },
];

const captionPositionOptions: SingleSelectPickerOption[] = [
  { value: 'top', label: 'Top' },
  { value: 'middle', label: 'Middle' },
  { value: 'bottom', label: 'Bottom' },
];

const captionAnimationOptions: SingleSelectPickerOption[] = [
  { value: 'none', label: 'None' },
  { value: 'pop', label: 'Pop' },
  { value: 'fade', label: 'Fade' },
];

const fetcher = async (url: string) => {
  const response = await fetch(url, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error('Request failed.');
  }

  return await response.json();
};

function formatAspectRatio(value: string) {
  return value.replace('_', ':');
}

function getLayoutLabel(layout: RenderedClipLayout) {
  return (
    layoutOptions.find((item) => item.value === layout)?.label || 'Main content'
  );
}

function getLayoutRatio(layout: RenderedClipLayout) {
  if (layout === RenderedClipLayout.FACECAM_TOP_50) {
    return [50, 50];
  }

  if (layout === RenderedClipLayout.FACECAM_TOP_40) {
    return [40, 60];
  }

  if (layout === RenderedClipLayout.FACECAM_TOP_30) {
    return [30, 70];
  }

  return [0, 100];
}

function toFormState(template: BrandTemplateRecord): FormState {
  return {
    name: template.name,
    captionFontFamily: template.captions.fontFamily,
    captionFontColor: template.captions.fontColor,
    captionHighlightColor: template.captions.highlightColor,
    captionPosition: template.captions.position,
    captionAnimation: template.captions.animation,
    captionFontAssetId: template.captions.captionFontAssetId?.toString() || '',
    aspectRatio: template.layout.aspectRatio,
    defaultLayout: template.layout.defaultLayout,
    enabledLayouts: template.layout.enabledLayouts,
    logoAssetId: template.overlays.logoAssetId?.toString() || '',
    ctaUrl: template.overlays.ctaUrl || '',
    introVideoAssetId: template.introOutro.introVideoAssetId?.toString() || '',
    outroVideoAssetId: template.introOutro.outroVideoAssetId?.toString() || '',
    isDefault: template.isDefault,
  };
}

function AssetSelect({
  label,
  value,
  assets,
  kinds,
  onChange,
}: {
  label: string;
  value: string;
  assets: ReusableAssetRecord[];
  kinds: ReusableAssetKind[];
  onChange: (value: string) => void;
}) {
  const filteredAssets = assets.filter((asset) =>
    kinds.includes(asset.kind as ReusableAssetKind)
  );
  const options: SingleSelectPickerOption[] = [
    { value: '', label: 'None' },
    ...filteredAssets.map((asset) => ({
      value: asset.id.toString(),
      label: asset.title,
    })),
  ];

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <SingleSelectPicker
        value={value}
        onValueChange={onChange}
        options={options}
        placeholder="None"
      />
    </div>
  );
}

function LayoutPreview({
  layout,
  compact = false,
}: {
  layout: RenderedClipLayout;
  compact?: boolean;
}) {
  const [facecam, content] = getLayoutRatio(layout);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border/70 bg-background/30 p-2',
        compact ? 'h-20 max-w-none' : 'h-24 max-w-xs'
      )}
    >
      {facecam > 0 ? (
        <div className="flex h-full flex-col gap-1.5">
          <div
            className="flex items-center justify-center rounded-md bg-muted text-[11px] text-muted-foreground"
            style={{ flex: facecam }}
          >
            Facecam {facecam}%
          </div>
          <div
            className="flex items-center justify-center rounded-md bg-foreground text-[11px] text-background"
            style={{ flex: content }}
          >
            Content {content}%
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center rounded-md bg-foreground text-xs text-background">
          Main content
        </div>
      )}
    </div>
  );
}

function CaptionPreview({
  form,
  compact = false,
}: {
  form: FormState;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/70 bg-background/30',
        compact ? 'p-3' : 'max-w-xs p-4'
      )}
    >
      <div
        className={cn(
          'flex justify-center rounded-md bg-muted/40',
          compact ? 'aspect-[4/5] p-3' : 'aspect-[9/16] items-end p-4'
        )}
        style={{ alignItems: compact ? 'stretch' : undefined }}
      >
        <p
          className={cn(
            'rounded px-2 py-1 text-center text-sm font-semibold',
            compact ? 'text-xs' : null,
            form.captionAnimation === 'pop' ? 'scale-105' : null,
            form.captionAnimation === 'fade' ? 'opacity-80' : null
          )}
          style={{
            color: form.captionFontColor,
            backgroundColor: form.captionHighlightColor,
            fontFamily: form.captionFontFamily || undefined,
            alignSelf:
              form.captionPosition === 'top'
                ? 'flex-start'
                : form.captionPosition === 'middle'
                  ? 'center'
                  : 'flex-end',
          }}
        >
          Caption preview
        </p>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  deletingTemplateId,
  onDelete,
  onSelect,
}: {
  template: BrandTemplateRecord;
  deletingTemplateId: number | null;
  onDelete: (templateId: number) => void;
  onSelect: (template: BrandTemplateRecord) => void;
}) {
  const previewForm = toFormState(template);
  const extras = [
    template.overlays.logoAssetId ? 'Logo' : null,
    template.introOutro.introVideoAssetId ? 'Intro' : null,
    template.introOutro.outroVideoAssetId ? 'Outro' : null,
    template.overlays.ctaUrl ? 'CTA' : null,
  ].filter(Boolean) as string[];

  return (
    <Card className="gap-4 overflow-hidden py-0">
      <CardHeader className="border-b border-border/60 px-4 py-4 sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{template.name}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatAspectRatio(template.layout.aspectRatio)} •{' '}
              {getLayoutLabel(template.layout.defaultLayout)} •{' '}
              {template.captions.position} captions
            </p>
          </div>
          <div className="flex items-center gap-2">
            {template.isDefault ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                Default
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={deletingTemplateId === template.id}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(template.id);
              }}
              aria-label={`Delete ${template.name}`}
            >
              {deletingTemplateId === template.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <button
        type="button"
        onClick={() => onSelect(template)}
        className="cursor-pointer text-left outline-none transition hover:bg-white/[0.02] focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CardContent className="space-y-4 px-4 py-4 sm:px-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <CaptionPreview form={previewForm} compact />
            <LayoutPreview layout={template.layout.defaultLayout} compact />
          </div>
          {extras.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {extras.map((label) => (
                <span
                  key={label}
                  className="rounded-full border border-border/60 bg-background/40 px-2 py-1 text-[11px] text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}
        </CardContent>
      </button>
    </Card>
  );
}

function BrandTemplateEditor({
  clientError,
  editingTemplateId,
  form,
  isSaving,
  reusableAssets,
  selectedFont,
  onBack,
  onSubmit,
  toggleLayout,
  updateForm,
}: {
  clientError: string | null;
  editingTemplateId: number | null;
  form: FormState;
  isSaving: boolean;
  reusableAssets: ReusableAssetRecord[];
  selectedFont?: ReusableAssetRecord;
  onBack: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  toggleLayout: (layout: RenderedClipLayout) => void;
  updateForm: <Key extends keyof FormState>(key: Key, value: FormState[Key]) => void;
}) {
  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" onClick={onBack} className="px-0">
          <ArrowLeft className="h-4 w-4" />
          Back to templates
        </Button>
      </div>

      <form onSubmit={onSubmit} className="space-y-8">
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground">
            {editingTemplateId ? 'Edit template' : 'Create template'}
          </h2>

          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="template-name" className="text-xs text-muted-foreground">
                    Template name
                  </Label>
                  <Input
                    id="template-name"
                    value={form.name}
                    onChange={(event) => updateForm('name', event.target.value)}
                    placeholder="Podcast clips"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Aspect ratio
                  </Label>
                  <SingleSelectPicker
                    value={form.aspectRatio}
                    onValueChange={(value) =>
                      updateForm('aspectRatio', value as FormState['aspectRatio'])
                    }
                    options={aspectRatioOptions}
                    placeholder="Select aspect ratio"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Font color</Label>
                  <Input
                    type="color"
                    value={form.captionFontColor}
                    onChange={(event) =>
                      updateForm('captionFontColor', event.target.value)
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Highlight
                  </Label>
                  <Input
                    type="color"
                    value={form.captionHighlightColor}
                    onChange={(event) =>
                      updateForm('captionHighlightColor', event.target.value)
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Font family
                  </Label>
                  <Input
                    value={form.captionFontFamily}
                    onChange={(event) =>
                      updateForm('captionFontFamily', event.target.value)
                    }
                    placeholder={selectedFont?.title || 'Inter'}
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <AssetSelect
                  label="Uploaded font"
                  value={form.captionFontAssetId}
                  assets={reusableAssets}
                  kinds={[ReusableAssetKind.FONT]}
                  onChange={(value) => updateForm('captionFontAssetId', value)}
                />
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Caption position
                  </Label>
                  <SingleSelectPicker
                    value={form.captionPosition}
                    onValueChange={(value) =>
                      updateForm(
                        'captionPosition',
                        value as FormState['captionPosition']
                      )
                    }
                    options={captionPositionOptions}
                    placeholder="Select position"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Animation
                  </Label>
                  <SingleSelectPicker
                    value={form.captionAnimation}
                    onValueChange={(value) =>
                      updateForm(
                        'captionAnimation',
                        value as FormState['captionAnimation']
                      )
                    }
                    options={captionAnimationOptions}
                    placeholder="Select animation"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <AssetSelect
                  label="Logo"
                  value={form.logoAssetId}
                  assets={reusableAssets}
                  kinds={[ReusableAssetKind.IMAGE, ReusableAssetKind.VIDEO]}
                  onChange={(value) => updateForm('logoAssetId', value)}
                />
                <AssetSelect
                  label="Intro video"
                  value={form.introVideoAssetId}
                  assets={reusableAssets}
                  kinds={[ReusableAssetKind.VIDEO]}
                  onChange={(value) => updateForm('introVideoAssetId', value)}
                />
                <AssetSelect
                  label="Outro video"
                  value={form.outroVideoAssetId}
                  assets={reusableAssets}
                  kinds={[ReusableAssetKind.VIDEO]}
                  onChange={(value) => updateForm('outroVideoAssetId', value)}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    CTA URL
                  </Label>
                  <Input
                    value={form.ctaUrl}
                    onChange={(event) => updateForm('ctaUrl', event.target.value)}
                    placeholder="https://example.com"
                  />
                </div>
                <label className="flex items-center gap-2 self-end rounded-md border border-border/60 bg-background/30 px-3 py-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={form.isDefault}
                    onChange={(event) =>
                      updateForm('isDefault', event.target.checked)
                    }
                  />
                  Make default template
                </label>
              </div>

              <div className="space-y-3">
                <Label className="text-xs text-muted-foreground">
                  Layout preferences
                </Label>
                <div className="grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
                  <LayoutPreview layout={form.defaultLayout} />
                  <div className="flex flex-wrap gap-2">
                    {layoutOptions.map((layout) => (
                      <button
                        key={layout.value}
                        type="button"
                        onClick={() => {
                          updateForm('defaultLayout', layout.value);
                          if (!form.enabledLayouts.includes(layout.value)) {
                            toggleLayout(layout.value);
                          }
                        }}
                        className={cn(
                          'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                          form.defaultLayout === layout.value
                            ? 'bg-muted text-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {layout.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <CaptionPreview form={form} />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="ghost"
              disabled={isSaving}
              className="h-auto px-0 text-base font-semibold text-foreground hover:bg-transparent"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editingTemplateId ? 'Save template' : 'Create template'}
            </Button>
            <Button type="button" variant="ghost" onClick={onBack}>
              Cancel
            </Button>
          </div>

          {clientError ? <FormMessage tone="error">{clientError}</FormMessage> : null}
        </section>
      </form>
    </div>
  );
}

export function BrandTemplatesPage() {
  const [pageMode, setPageMode] = useState<PageMode>('browse');
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingTemplateId, setEditingTemplateId] = useState<number | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState<number | null>(null);
  const { data, error, mutate } = useSWR<BrandTemplatesResponse>(
    '/api/brand-templates',
    fetcher
  );
  const { data: reusableAssetsData } = useSWR<ReusableAssetsResponse>(
    '/api/reusable-assets',
    fetcher
  );
  const templates = data?.templates || [];
  const reusableAssets = reusableAssetsData?.assets || [];
  const selectedFont = useMemo(
    () =>
      reusableAssets.find(
        (asset) => asset.id.toString() === form.captionFontAssetId
      ),
    [form.captionFontAssetId, reusableAssets]
  );

  function updateForm<Key extends keyof FormState>(key: Key, value: FormState[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    setClientError(null);
  }

  function startCreate() {
    setForm(emptyForm);
    setEditingTemplateId(null);
    setClientError(null);
    setPageMode('edit');
  }

  function startEdit(template: BrandTemplateRecord) {
    setEditingTemplateId(template.id);
    setForm(toFormState(template));
    setClientError(null);
    setPageMode('edit');
  }

  function returnToBrowse() {
    setForm(emptyForm);
    setEditingTemplateId(null);
    setClientError(null);
    setPageMode('browse');
  }

  function toggleLayout(layout: RenderedClipLayout) {
    setForm((current) => {
      const enabled = current.enabledLayouts.includes(layout)
        ? current.enabledLayouts.filter((item) => item !== layout)
        : [...current.enabledLayouts, layout];

      return {
        ...current,
        enabledLayouts: enabled.length > 0 ? enabled : [current.defaultLayout],
      };
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setClientError(null);

    try {
      const response = await fetch(
        editingTemplateId
          ? `/api/brand-templates?id=${editingTemplateId}`
          : '/api/brand-templates',
        {
          method: editingTemplateId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...form,
            cropSettings: {},
          }),
        }
      );
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(result?.error || 'Unable to save brand template.');
      }

      await mutate();
      returnToBrowse();
    } catch (saveError) {
      setClientError(
        saveError instanceof Error
          ? saveError.message
          : 'Unable to save brand template.'
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(templateId: number) {
    setDeletingTemplateId(templateId);
    setClientError(null);

    try {
      const response = await fetch(`/api/brand-templates?id=${templateId}`, {
        method: 'DELETE',
      });
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(result?.error || 'Unable to delete brand template.');
      }

      if (editingTemplateId === templateId) {
        returnToBrowse();
      }

      await mutate();
    } catch (deleteError) {
      setClientError(
        deleteError instanceof Error
          ? deleteError.message
          : 'Unable to delete brand template.'
      );
    } finally {
      setDeletingTemplateId(null);
    }
  }

  return (
    <DashboardPageShell>
      <div className="mb-6 max-w-2xl">
        <h1 className="text-3xl font-semibold text-foreground">Brand Templates</h1>
        <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
          Save reusable caption, layout, and overlay settings for clip renders.
        </p>
      </div>

      {pageMode === 'edit' ? (
        <BrandTemplateEditor
          clientError={clientError}
          editingTemplateId={editingTemplateId}
          form={form}
          isSaving={isSaving}
          reusableAssets={reusableAssets}
          selectedFont={selectedFont}
          onBack={returnToBrowse}
          onSubmit={handleSubmit}
          toggleLayout={toggleLayout}
          updateForm={updateForm}
        />
      ) : (
        <div className="max-w-6xl space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                Templates ({templates.length})
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Apply these presets from the clip editor to rerender clips in one click.
              </p>
            </div>
            <Button type="button" onClick={startCreate}>
              <Plus className="h-4 w-4" />
              Create template
            </Button>
          </div>

          {clientError ? <FormMessage tone="error">{clientError}</FormMessage> : null}
          {error ? (
            <FormMessage tone="error">
              Unable to load brand templates right now.
            </FormMessage>
          ) : null}

          {templates.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  deletingTemplateId={deletingTemplateId}
                  onDelete={handleDelete}
                  onSelect={startEdit}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <EmptyState
                title="No brand templates yet"
                description="Create a reusable style preset for captions, split layouts, overlays, and render defaults."
              />
              <div className="flex justify-center">
                <Button type="button" onClick={startCreate}>
                  <Plus className="h-4 w-4" />
                  Create template
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </DashboardPageShell>
  );
}
