'use client';

import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ArrowLeft, ChevronDown, Loader2, Plus, Trash2 } from 'lucide-react';
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

const fieldBackgroundClassName =
  'border-border/60 bg-transparent shadow-none focus-visible:border-ring/50 focus-visible:ring-ring/20';
const labelClassName =
  'text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground';
const fieldGroupClassName = 'space-y-4';

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
  triggerClassName,
}: {
  label: string;
  value: string;
  assets: ReusableAssetRecord[];
  kinds: ReusableAssetKind[];
  onChange: (value: string) => void;
  triggerClassName?: string;
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
      <Label className={labelClassName}>{label}</Label>
      <SingleSelectPicker
        value={value}
        onValueChange={onChange}
        options={options}
        placeholder="None"
        triggerClassName={triggerClassName}
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

function CreateTemplateCard({ onSelect }: { onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="cursor-pointer rounded-xl border border-dashed border-border/80 text-left outline-none transition hover:border-foreground/30 hover:bg-white/[0.02] focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Create template"
    >
      <div className="flex min-h-[20rem] items-center justify-center p-6">
        <Plus className="h-8 w-8 text-muted-foreground" />
      </div>
    </button>
  );
}

function FieldGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(fieldGroupClassName, className)}>{children}</div>;
}

function EditorAccordion({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className="border-t border-border/70 first:border-t-0">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 py-4 text-left transition"
        aria-expanded={isOpen}
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold tracking-tight text-foreground">
            {title}
          </span>
          {description ? (
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            isOpen ? 'rotate-180' : null
          )}
        />
      </button>
      {isOpen ? (
        <div className="space-y-4 border-t border-border/60 pb-5 pt-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function EditorSwitch({
  label,
  description,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/50 py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          checked
            ? 'border-foreground bg-foreground'
            : 'border-border bg-muted',
          disabled ? 'cursor-not-allowed opacity-60' : null
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full bg-background shadow-sm transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5'
          )}
        />
      </button>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className={labelClassName}>{label}</Label>
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-transparent px-2 py-1 shadow-none">
        <Input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-10 border-0 bg-transparent p-0"
        />
        <Input
          value={value}
          readOnly
          className="h-8 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-0"
        />
      </div>
    </div>
  );
}

function assetTitle(assets: ReusableAssetRecord[], value: string) {
  return assets.find((asset) => asset.id.toString() === value)?.title;
}

function BrandTemplateLivePreview({
  form,
  reusableAssets,
}: {
  form: FormState;
  reusableAssets: ReusableAssetRecord[];
}) {
  const [facecam, content] = getLayoutRatio(form.defaultLayout);
  const logoTitle = assetTitle(reusableAssets, form.logoAssetId);
  const introTitle = assetTitle(reusableAssets, form.introVideoAssetId);
  const outroTitle = assetTitle(reusableAssets, form.outroVideoAssetId);

  return (
    <div className="space-y-5 pt-1">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Live preview
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
            Brand clip
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatAspectRatio(form.aspectRatio)} • {getLayoutLabel(form.defaultLayout)}
          </p>
        </div>
        {form.isDefault ? (
          <span className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
            Default
          </span>
        ) : null}
      </div>

      <div className="mx-auto w-full max-w-[21rem] lg:mx-0">
        <div className="relative aspect-[9/16] overflow-hidden rounded-[1.75rem] border border-border bg-zinc-950 p-3 shadow-xl">
          {introTitle ? (
            <div className="absolute left-4 top-4 z-20 rounded-full bg-background/90 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-sm">
              Intro
            </div>
          ) : null}
          {logoTitle ? (
            <div className="absolute right-4 top-4 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-background/90 text-[10px] font-semibold uppercase text-foreground shadow-sm">
              Logo
            </div>
          ) : null}

          <div className="flex h-full flex-col gap-2 overflow-hidden rounded-[1.25rem] bg-background">
            {facecam > 0 ? (
              <div
                className="relative flex items-center justify-center bg-muted text-xs font-medium text-muted-foreground"
                style={{ flex: facecam }}
              >
                Speaker video
              </div>
            ) : null}
            <div
              className="relative flex min-h-0 items-center justify-center overflow-hidden bg-foreground text-background"
              style={{ flex: content }}
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.28),transparent_30%),linear-gradient(145deg,rgba(255,255,255,0.16),transparent_45%)]" />
              <div className="relative grid h-28 w-28 place-items-center rounded-full border border-background/20 bg-background/10 text-center text-xs font-medium">
                Source clip
              </div>
            </div>
          </div>

          <p
            className={cn(
              'absolute left-8 right-8 z-30 rounded-md px-3 py-2 text-center text-sm font-bold leading-snug shadow-lg',
              form.captionAnimation === 'pop' ? 'scale-105' : null,
              form.captionAnimation === 'fade' ? 'opacity-80' : null,
              form.captionPosition === 'top'
                ? 'top-20'
                : form.captionPosition === 'middle'
                  ? 'top-1/2 -translate-y-1/2'
                  : 'bottom-24'
            )}
            style={{
              color: form.captionFontColor,
              backgroundColor: form.captionHighlightColor,
              fontFamily: form.captionFontFamily || undefined,
            }}
          >
            Turn one episode into a week of clips
          </p>

          {form.ctaUrl ? (
            <div className="absolute bottom-8 left-8 right-8 z-30 rounded-xl border border-background/30 bg-background/95 px-3 py-2 text-center text-xs font-semibold text-foreground shadow-lg">
              {form.ctaUrl}
            </div>
          ) : null}
          {outroTitle ? (
            <div className="absolute bottom-4 right-4 z-30 rounded-full bg-background/90 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-sm">
              Outro
            </div>
          ) : null}
        </div>
      </div>
    </div>
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onBack} className="px-0">
          <ArrowLeft className="h-4 w-4" />
          Back to templates
        </Button>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {editingTemplateId ? 'Editing template' : 'New template'}
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="grid gap-6 lg:grid-cols-[24rem_minmax(0,1fr)] lg:gap-16 xl:grid-cols-[26rem_minmax(0,1fr)] xl:gap-20"
      >
        <aside className="order-2 lg:order-1">
          <div>
            <div className="mb-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Brand template
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
                {editingTemplateId ? 'Edit template' : 'Create template'}
              </h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Configure the template controls and watch the preview update.
              </p>
            </div>

            <div className="space-y-1">
              <EditorAccordion
                title="Brand Info"
                description="Name and default behavior"
                defaultOpen
              >
                <FieldGroup>
                  <div className="space-y-1.5">
                    <Label htmlFor="template-name" className={labelClassName}>
                      Template name
                    </Label>
                    <Input
                      id="template-name"
                      value={form.name}
                      onChange={(event) => updateForm('name', event.target.value)}
                      placeholder="Podcast clips"
                      required
                      className={fieldBackgroundClassName}
                    />
                  </div>
                  <EditorSwitch
                    label="Default template"
                    description="Use this as the fallback template for new clip exports."
                    checked={form.isDefault}
                    onCheckedChange={(checked) => updateForm('isDefault', checked)}
                  />
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion
                title="Video Layout"
                description="Aspect ratio and clip framing"
                defaultOpen
              >
                <FieldGroup>
                  <div className="space-y-1.5">
                    <Label className={labelClassName}>Aspect ratio</Label>
                    <SingleSelectPicker
                      value={form.aspectRatio}
                      onValueChange={(value) =>
                        updateForm('aspectRatio', value as FormState['aspectRatio'])
                      }
                      options={aspectRatioOptions}
                      placeholder="Select aspect ratio"
                      triggerClassName={fieldBackgroundClassName}
                    />
                  </div>

                  <div className="space-y-3">
                    <Label className={labelClassName}>Default layout</Label>
                    <LayoutPreview layout={form.defaultLayout} compact />
                    <div className="grid gap-2">
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
                            'rounded-lg border px-3 py-2.5 text-left text-sm font-medium transition-colors',
                            form.defaultLayout === layout.value
                              ? 'border-foreground text-foreground'
                              : 'border-border/60 bg-transparent text-muted-foreground hover:border-border hover:text-foreground'
                          )}
                        >
                          {layout.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className={labelClassName}>Enabled layouts</Label>
                    {layoutOptions.map((layout) => (
                      <EditorSwitch
                        key={layout.value}
                        label={layout.label}
                        description={
                          layout.value === form.defaultLayout
                            ? 'Current default layout'
                            : undefined
                        }
                        checked={form.enabledLayouts.includes(layout.value)}
                        disabled={layout.value === form.defaultLayout}
                        onCheckedChange={() => toggleLayout(layout.value)}
                      />
                    ))}
                  </div>
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion
                title="Captions"
                description="Position and animation"
                defaultOpen
              >
                <FieldGroup>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className={labelClassName}>Caption position</Label>
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
                        triggerClassName={fieldBackgroundClassName}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className={labelClassName}>Animation</Label>
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
                        triggerClassName={fieldBackgroundClassName}
                      />
                    </div>
                  </div>
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion title="Colors" description="Caption palette">
                <FieldGroup>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ColorField
                      label="Font color"
                      value={form.captionFontColor}
                      onChange={(value) => updateForm('captionFontColor', value)}
                    />
                    <ColorField
                      label="Highlight"
                      value={form.captionHighlightColor}
                      onChange={(value) =>
                        updateForm('captionHighlightColor', value)
                      }
                    />
                  </div>
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion title="Fonts" description="Typeface and assets">
                <FieldGroup>
                  <div className="space-y-1.5">
                    <Label className={labelClassName}>Font family</Label>
                    <Input
                      value={form.captionFontFamily}
                      onChange={(event) =>
                        updateForm('captionFontFamily', event.target.value)
                      }
                      placeholder={selectedFont?.title || 'Inter'}
                      className={fieldBackgroundClassName}
                    />
                  </div>
                  <AssetSelect
                    label="Uploaded font"
                    value={form.captionFontAssetId}
                    assets={reusableAssets}
                    kinds={[ReusableAssetKind.FONT]}
                    onChange={(value) => updateForm('captionFontAssetId', value)}
                    triggerClassName={fieldBackgroundClassName}
                  />
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion
                title="Logo / Watermark"
                description="Reusable visual overlay"
              >
                <FieldGroup>
                  <AssetSelect
                    label="Logo"
                    value={form.logoAssetId}
                    assets={reusableAssets}
                    kinds={[ReusableAssetKind.IMAGE, ReusableAssetKind.VIDEO]}
                    onChange={(value) => updateForm('logoAssetId', value)}
                    triggerClassName={fieldBackgroundClassName}
                  />
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion title="CTA / Outro" description="Intro, outro, and CTA">
                <FieldGroup>
                  <AssetSelect
                    label="Intro video"
                    value={form.introVideoAssetId}
                    assets={reusableAssets}
                    kinds={[ReusableAssetKind.VIDEO]}
                    onChange={(value) => updateForm('introVideoAssetId', value)}
                    triggerClassName={fieldBackgroundClassName}
                  />
                  <AssetSelect
                    label="Outro video"
                    value={form.outroVideoAssetId}
                    assets={reusableAssets}
                    kinds={[ReusableAssetKind.VIDEO]}
                    onChange={(value) => updateForm('outroVideoAssetId', value)}
                    triggerClassName={fieldBackgroundClassName}
                  />
                  <div className="space-y-1.5">
                    <Label className={labelClassName}>CTA URL</Label>
                    <Input
                      value={form.ctaUrl}
                      onChange={(event) => updateForm('ctaUrl', event.target.value)}
                      placeholder="https://example.com"
                      className={fieldBackgroundClassName}
                    />
                  </div>
                </FieldGroup>
              </EditorAccordion>
            </div>

            <div className="mt-8 border-t border-border/70 pt-5">
              {clientError ? (
                <div className="mb-3">
                  <FormMessage tone="error">{clientError}</FormMessage>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={isSaving} className="flex-1">
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {editingTemplateId ? 'Save template' : 'Create template'}
                </Button>
                <Button type="button" variant="ghost" onClick={onBack}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </aside>

        <section className="order-1 lg:order-2 lg:pl-10 xl:pl-14">
          <div>
            <BrandTemplateLivePreview form={form} reusableAssets={reusableAssets} />
          </div>
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
      <div className="mb-6 max-w-3xl">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">
          Brand Templates
        </h1>
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
          {clientError ? <FormMessage tone="error">{clientError}</FormMessage> : null}
          {error ? (
            <FormMessage tone="error">
              Unable to load brand templates right now.
            </FormMessage>
          ) : null}

          {!error ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <CreateTemplateCard onSelect={startCreate} />
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
          ) : null}
        </div>
      )}
    </DashboardPageShell>
  );
}
