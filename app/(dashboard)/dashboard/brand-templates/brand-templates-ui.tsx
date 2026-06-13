'use client';

import { type FormEvent, type ReactNode, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  ArrowLeft,
  ChevronDown,
  Clapperboard,
  CheckCircle2,
  Image,
  Link2,
  Loader2,
  Monitor,
  Palette,
  Plus,
  Square,
  Smartphone,
  Type,
  Trash2,
  WholeWord,
  WrapText,
} from 'lucide-react';
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
    position: 'top' | 'middle' | 'bottom' | 'manual';
    animation: 'none' | 'pop' | 'fade';
    captionFontAssetId: number | null;
  };
  layout: {
    aspectRatio: '9_16' | '1_1' | '16_9';
    enabledAspectRatios: ('9_16' | '1_1' | '16_9')[];
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

type AspectRatio = '9_16' | '1_1' | '16_9';
type CaptionPosition = 'top' | 'middle' | 'bottom' | 'manual';
type CaptionPlacement = {
  x: number;
  y: number;
};
type CaptionPlacements = Partial<Record<AspectRatio, CaptionPlacement>>;

type BrandTemplatesResponse = {
  templates?: BrandTemplateRecord[];
};

type FormState = {
  name: string;
  captionFontFamily: string;
  captionFontColor: string;
  captionHighlightColor: string;
  captionPosition: CaptionPosition;
  captionAnimation: 'none' | 'pop' | 'fade';
  captionFontAssetId: string;
  aspectRatio: AspectRatio;
  enabledAspectRatios: AspectRatio[];
  defaultLayout: RenderedClipLayout;
  enabledLayouts: RenderedClipLayout[];
  sourceCrop: 'original' | '4_3' | '1_1';
  captionPlacements: CaptionPlacements;
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
  enabledAspectRatios: ['9_16'],
  defaultLayout: RenderedClipLayout.DEFAULT,
  enabledLayouts: [RenderedClipLayout.DEFAULT],
  sourceCrop: 'original',
  captionPlacements: {},
  logoAssetId: '',
  ctaUrl: '',
  introVideoAssetId: '',
  outroVideoAssetId: '',
  isDefault: false,
};

const layoutOptions = [
  { value: RenderedClipLayout.PRESERVE_ASPECT, label: 'Fit' },
  { value: RenderedClipLayout.DEFAULT, label: 'Fill' },
  { value: RenderedClipLayout.FACECAM_TOP_50, label: '50/50 split' },
  { value: RenderedClipLayout.FACECAM_TOP_40, label: '40/60 split' },
  { value: RenderedClipLayout.FACECAM_TOP_30, label: '30/70 split' },
] as const;

const splitLayouts = [
  RenderedClipLayout.FACECAM_TOP_50,
  RenderedClipLayout.FACECAM_TOP_40,
  RenderedClipLayout.FACECAM_TOP_30,
] as const;

const cropOptions = [
  { value: 'original', label: 'Original' },
  { value: '4_3', label: '4:3' },
  { value: '1_1', label: '1:1' },
] as const;

const captionPositionOptions: SingleSelectPickerOption[] = [
  { value: 'top', label: 'Top' },
  { value: 'middle', label: 'Middle' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'manual', label: 'Manual' },
];

const captionAnimationOptions: SingleSelectPickerOption[] = [
  { value: 'none', label: 'None' },
  { value: 'pop', label: 'Pop' },
  { value: 'fade', label: 'Fade' },
];

const fieldBackgroundClassName =
  'border-border/60 bg-transparent shadow-none focus-visible:border-ring/50 focus-visible:ring-ring/20';
const labelClassName =
  'text-sm font-medium tracking-normal text-muted-foreground';
const fieldGroupClassName = 'space-y-4';
const previewCaptionInsetPx = 16;
const previewCaptionSnapThresholdPx = 14;
const previewSplitGuideRatios = [0.3, 0.4, 0.5] as const;

const defaultCaptionPlacements: Record<
  AspectRatio,
  Record<'top' | 'middle' | 'bottom', CaptionPlacement>
> = {
  '9_16': {
    top: { x: 0.5, y: 0.18 },
    middle: { x: 0.5, y: 0.5 },
    bottom: { x: 0.5, y: 0.82 },
  },
  '1_1': {
    top: { x: 0.5, y: 0.18 },
    middle: { x: 0.5, y: 0.5 },
    bottom: { x: 0.5, y: 0.75 },
  },
  '16_9': {
    top: { x: 0.5, y: 0.2 },
    middle: { x: 0.5, y: 0.5 },
    bottom: { x: 0.5, y: 0.78 },
  },
};

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

function aspectRatioLabel(value: FormState['aspectRatio']) {
  return formatAspectRatio(value);
}

function aspectRatioIcon(value: FormState['aspectRatio']) {
  if (value === '1_1') {
    return <Square className="h-4 w-4" />;
  }

  if (value === '16_9') {
    return <Monitor className="h-4 w-4" />;
  }

  return <Smartphone className="h-4 w-4" />;
}

function aspectRatioPreviewClassName(value: FormState['aspectRatio']) {
  if (value === '1_1') {
    return 'aspect-square';
  }

  if (value === '16_9') {
    return 'aspect-video';
  }

  return 'aspect-[9/16]';
}

function aspectRatioPreviewWidthClassName(value: FormState['aspectRatio']) {
  if (value === '16_9') {
    return 'max-w-[34rem]';
  }

  if (value === '1_1') {
    return 'max-w-[26rem]';
  }

  return 'max-w-[20rem]';
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

function getDefaultCaptionPlacement(
  aspectRatio: AspectRatio,
  position: Exclude<CaptionPosition, 'manual'> = 'bottom'
) {
  return defaultCaptionPlacements[aspectRatio][position];
}

function getStoredCaptionPlacements(
  cropSettings: Record<string, unknown>
): CaptionPlacements {
  const placements = cropSettings.captionPlacements;

  if (!placements || typeof placements !== 'object' || Array.isArray(placements)) {
    return {};
  }

  const normalized: CaptionPlacements = {};

  for (const aspectRatio of ['9_16', '1_1', '16_9'] as const) {
    const placement = (placements as Record<string, unknown>)[aspectRatio];

    if (!placement || typeof placement !== 'object' || Array.isArray(placement)) {
      continue;
    }

    const x = (placement as { x?: unknown }).x;
    const y = (placement as { y?: unknown }).y;

    if (typeof x !== 'number' || typeof y !== 'number') {
      continue;
    }

    normalized[aspectRatio] = { x: clampUnit(x), y: clampUnit(y) };
  }

  return normalized;
}

function ensureManualCaptionPlacement(
  form: FormState,
  fallbackPosition: Exclude<CaptionPosition, 'manual'> = 'bottom'
) {
  if (form.captionPlacements[form.aspectRatio]) {
    return form;
  }

  return {
    ...form,
    captionPlacements: {
      ...form.captionPlacements,
      [form.aspectRatio]: getDefaultCaptionPlacement(
        form.aspectRatio,
        fallbackPosition
      ),
    },
  };
}

function getPreviewCaptionPlacement(form: FormState) {
  if (form.captionPosition === 'manual') {
    return (
      form.captionPlacements[form.aspectRatio] ||
      getDefaultCaptionPlacement(form.aspectRatio, 'bottom')
    );
  }

  return getDefaultCaptionPlacement(form.aspectRatio, form.captionPosition);
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

function isSplitLayout(layout: RenderedClipLayout) {
  return splitLayouts.includes(layout as (typeof splitLayouts)[number]);
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
    enabledAspectRatios: template.layout.enabledAspectRatios?.length
      ? template.layout.enabledAspectRatios
      : [template.layout.aspectRatio],
    defaultLayout: template.layout.defaultLayout,
    enabledLayouts: template.layout.enabledLayouts,
    sourceCrop:
      template.cropSettings.sourceCrop === '4_3' ||
      template.cropSettings.sourceCrop === '1_1'
        ? template.cropSettings.sourceCrop
        : 'original',
    captionPlacements: getStoredCaptionPlacements(template.cropSettings),
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
            className="flex items-center justify-center rounded-md bg-muted text-xs text-muted-foreground"
            style={{ flex: facecam }}
          >
            Facecam {facecam}%
          </div>
          <div
            className="flex items-center justify-center rounded-md bg-foreground text-xs text-background"
            style={{ flex: content }}
          >
            Content {content}%
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center rounded-md bg-foreground text-sm text-background">
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
  const placement = getPreviewCaptionPlacement(form);

  return (
    <div
      className={cn(
        'rounded-lg border border-border/70 bg-background/30',
        compact ? 'p-3' : 'max-w-xs p-4'
      )}
    >
      <div
        className={cn(
          'relative rounded-md bg-muted/40',
          compact ? 'aspect-[4/5] p-3' : 'aspect-[9/16] p-4'
        )}
      >
        <p
          className={cn(
            'absolute max-w-[calc(100%-1.5rem)] -translate-x-1/2 -translate-y-1/2 rounded px-2 py-1 text-center text-sm font-semibold',
            compact ? 'text-xs' : null,
            form.captionAnimation === 'pop' ? 'scale-105' : null,
            form.captionAnimation === 'fade' ? 'opacity-80' : null
          )}
          style={{
            left: `${placement.x * 100}%`,
            top: `${placement.y * 100}%`,
            color: form.captionFontColor,
            backgroundColor: form.captionHighlightColor,
            fontFamily: form.captionFontFamily || undefined,
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
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
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
      <Button
        type="button"
        variant="ghost"
        onClick={() => onSelect(template)}
        className="h-auto w-full justify-start rounded-none px-0 py-0 text-left hover:bg-white/[0.02]"
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
                  className="rounded-full border border-border/60 bg-background/40 px-2 py-1 text-xs text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Button>
    </Card>
  );
}

function CreateTemplateCard({ onSelect }: { onSelect: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onSelect}
      className="h-auto w-full rounded-xl border border-dashed border-border/80 px-0 py-0 text-left hover:border-foreground/30 hover:bg-white/[0.02]"
      aria-label="Create template"
    >
      <div className="flex min-h-[20rem] items-center justify-center p-6">
        <Plus className="h-8 w-8 text-muted-foreground" />
      </div>
    </Button>
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
  id,
  title,
  description,
  icon,
  isOpen,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  icon?: ReactNode;
  isOpen: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <section>
      <Button
        type="button"
        variant="ghost"
        onClick={() => onToggle(id)}
        className="h-auto w-full justify-between gap-3 px-0 py-4 text-left transition"
        aria-expanded={isOpen}
        aria-controls={`template-section-${id}`}
      >
        <span className="flex min-w-0 items-start gap-3">
          {icon ? (
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {icon}
            </span>
          ) : null}
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
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            isOpen ? 'rotate-180' : null
          )}
        />
      </Button>
      <div
        id={`template-section-${id}`}
        className={cn(
          'grid overflow-hidden transition-all duration-200 ease-out',
          isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={cn(
              'transition-transform duration-200 ease-out',
              isOpen ? 'translate-y-0' : '-translate-y-2'
            )}
          >
            <div className="pb-5 pt-4">
              <Card className="gap-0 border-0 bg-none bg-muted/50 py-0 shadow-none">
                <CardContent className="space-y-4 px-4 py-4">
                  {children}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </section>
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

function getSnappedPreviewAxis(params: {
  rawValuePx: number;
  sizePx: number;
  candidates: number[];
}) {
  let closestCandidate: number | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of params.candidates) {
    const candidatePx = candidate * params.sizePx;
    const distance = Math.abs(params.rawValuePx - candidatePx);

    if (distance <= previewCaptionSnapThresholdPx && distance < closestDistance) {
      closestCandidate = candidate;
      closestDistance = distance;
    }
  }

  return closestCandidate;
}

function BrandTemplateLivePreview({
  form,
  reusableAssets,
  updateCaptionPlacement,
}: {
  form: FormState;
  reusableAssets: ReusableAssetRecord[];
  updateCaptionPlacement: (aspectRatio: AspectRatio, placement: CaptionPlacement) => void;
}) {
  const [facecam, content] = getLayoutRatio(form.defaultLayout);
  const logoTitle = assetTitle(reusableAssets, form.logoAssetId);
  const introTitle = assetTitle(reusableAssets, form.introVideoAssetId);
  const outroTitle = assetTitle(reusableAssets, form.outroVideoAssetId);
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const [dragState, setDragState] = useState<{
    pointerId: number;
    originPlacement: CaptionPlacement;
    snappedX: number | null;
    snappedY: number | null;
  } | null>(null);
  const previewPlacement = getPreviewCaptionPlacement(form);
  const isManual = form.captionPosition === 'manual';
  const showDragGuides = isManual && dragState !== null;

  const updatePlacementFromPointer = (clientX: number, clientY: number) => {
    const previewFrame = previewFrameRef.current;
    const captionElement = captionRef.current;

    if (!previewFrame || !captionElement) {
      return;
    }

    const frameRect = previewFrame.getBoundingClientRect();
    const captionRect = captionElement.getBoundingClientRect();
    const minX = captionRect.width / 2 + previewCaptionInsetPx;
    const maxX = frameRect.width - captionRect.width / 2 - previewCaptionInsetPx;
    const minY = captionRect.height / 2 + previewCaptionInsetPx;
    const maxY = frameRect.height - captionRect.height / 2 - previewCaptionInsetPx;
    const localX = clientX - frameRect.left;
    const localY = clientY - frameRect.top;
    const snappedX = getSnappedPreviewAxis({
      rawValuePx: localX,
      sizePx: frameRect.width,
      candidates: [
        dragState?.originPlacement.x ?? previewPlacement.x,
        0.5,
      ],
    });
    const snappedY = getSnappedPreviewAxis({
      rawValuePx: localY,
      sizePx: frameRect.height,
      candidates: [
        dragState?.originPlacement.y ?? previewPlacement.y,
        ...previewSplitGuideRatios,
        0.5,
      ],
    });
    const boundedX = Math.min(
      Math.max(
        snappedX == null ? localX : snappedX * frameRect.width,
        minX
      ),
      Math.max(minX, maxX)
    );
    const boundedY = Math.min(
      Math.max(
        snappedY == null ? localY : snappedY * frameRect.height,
        minY
      ),
      Math.max(minY, maxY)
    );

    setDragState((current) =>
      current
        ? {
            ...current,
            snappedX,
            snappedY,
          }
        : current
    );

    updateCaptionPlacement(form.aspectRatio, {
      x: clampUnit(boundedX / frameRect.width),
      y: clampUnit(boundedY / frameRect.height),
    });
  };

  return (
    <div
      className={cn(
        'mx-auto w-full lg:mx-0',
        aspectRatioPreviewWidthClassName(form.aspectRatio)
      )}
    >
      <div
        ref={previewFrameRef}
        className={cn(
          'relative overflow-hidden rounded-[1.75rem] bg-zinc-950 p-3',
          aspectRatioPreviewClassName(form.aspectRatio)
        )}
      >
          {introTitle ? (
            <div className="absolute left-4 top-4 z-20 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm">
              Intro
            </div>
          ) : null}
          {logoTitle ? (
            <div className="absolute right-4 top-4 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-background/90 text-xs font-semibold uppercase text-foreground shadow-sm">
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

          {showDragGuides
            ? previewSplitGuideRatios.map((ratio) => (
                <div
                  key={ratio}
                  className="pointer-events-none absolute inset-x-6 z-20 h-px bg-red-500/70"
                  style={{ top: `${ratio * 100}%` }}
                />
              ))
            : null}
          {dragState?.snappedX != null ? (
            <div
              className="pointer-events-none absolute inset-y-6 z-20 w-px bg-red-500"
              style={{ left: `${dragState.snappedX * 100}%` }}
            />
          ) : null}
          {dragState?.snappedY != null ? (
            <div
              className="pointer-events-none absolute inset-x-6 z-20 h-px bg-red-500"
              style={{ top: `${dragState.snappedY * 100}%` }}
            />
          ) : null}

          <p
            ref={captionRef}
            className={cn(
              'absolute z-30 max-w-[calc(100%-4rem)] -translate-x-1/2 -translate-y-1/2 rounded-md px-3 py-2 text-center text-sm font-bold leading-snug shadow-lg',
              form.captionAnimation === 'pop' ? 'scale-105' : null,
              form.captionAnimation === 'fade' ? 'opacity-80' : null,
              isManual ? 'cursor-grab touch-none active:cursor-grabbing' : null
            )}
            style={{
              left: `${previewPlacement.x * 100}%`,
              top: `${previewPlacement.y * 100}%`,
              color: form.captionFontColor,
              backgroundColor: form.captionHighlightColor,
              fontFamily: form.captionFontFamily || undefined,
            }}
            onPointerDown={(event) => {
              if (!isManual) {
                return;
              }

              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragState({
                pointerId: event.pointerId,
                originPlacement: previewPlacement,
                snappedX: null,
                snappedY: null,
              });
              updatePlacementFromPointer(event.clientX, event.clientY);
            }}
            onPointerMove={(event) => {
              if (!isManual || dragState?.pointerId !== event.pointerId) {
                return;
              }

              updatePlacementFromPointer(event.clientX, event.clientY);
            }}
            onPointerUp={(event) => {
              if (dragState?.pointerId !== event.pointerId) {
                return;
              }

              event.currentTarget.releasePointerCapture(event.pointerId);
              setDragState(null);
            }}
            onPointerCancel={(event) => {
              if (dragState?.pointerId !== event.pointerId) {
                return;
              }

              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              setDragState(null);
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
            <div className="absolute bottom-4 right-4 z-30 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm">
              Outro
            </div>
          ) : null}
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
  updateForm,
  updateCaptionPosition,
  updateCaptionPlacement,
}: {
  clientError: string | null;
  editingTemplateId: number | null;
  form: FormState;
  isSaving: boolean;
  reusableAssets: ReusableAssetRecord[];
  selectedFont?: ReusableAssetRecord;
  onBack: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  updateForm: <Key extends keyof FormState>(key: Key, value: FormState[Key]) => void;
  updateCaptionPosition: (position: CaptionPosition) => void;
  updateCaptionPlacement: (
    aspectRatio: AspectRatio,
    placement: CaptionPlacement
  ) => void;
}) {
  const [openSection, setOpenSection] = useState('brand-info');
  const toggleAspectRatio = (aspectRatio: FormState['aspectRatio']) => {
    const isEnabled = form.enabledAspectRatios.includes(aspectRatio);
    const nextAspectRatios = isEnabled
      ? form.enabledAspectRatios.filter((item) => item !== aspectRatio)
      : [...form.enabledAspectRatios, aspectRatio];

    if (nextAspectRatios.length === 0) {
      return;
    }

    updateForm('enabledAspectRatios', nextAspectRatios);
    updateForm(
      'aspectRatio',
      isEnabled
        ? form.aspectRatio === aspectRatio
          ? nextAspectRatios[0]
          : form.aspectRatio
        : aspectRatio
    );
  };
  const toggleLayout = (layout: RenderedClipLayout) => {
    const isEnabled = form.enabledLayouts.includes(layout);
    const nextLayouts = isSplitLayout(layout)
      ? isEnabled
        ? form.enabledLayouts.filter((item) => item !== layout)
        : [
            ...form.enabledLayouts.filter((item) => !isSplitLayout(item)),
            layout,
          ]
      : isEnabled
        ? form.enabledLayouts.filter((item) => item !== layout)
        : [...form.enabledLayouts, layout];

    if (nextLayouts.length === 0) {
      return;
    }

    updateForm('enabledLayouts', nextLayouts);
    updateForm(
      'defaultLayout',
      isEnabled
        ? form.defaultLayout === layout
          ? nextLayouts[0]
          : form.defaultLayout
        : layout
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onBack} className="px-0">
          <ArrowLeft className="h-4 w-4" />
          Back to templates
        </Button>
      </div>

      <form
        onSubmit={onSubmit}
        className="grid gap-6 lg:grid-cols-[24rem_minmax(0,1fr)] lg:gap-16 xl:grid-cols-[26rem_minmax(0,1fr)] xl:gap-20"
      >
        <aside className="order-2 lg:order-1">
          <div>
            <div className="space-y-1">
              <EditorAccordion
                id="brand-info"
                title="Brand Info"
                description="Template name"
                icon={<WholeWord className="h-4 w-4" />}
                isOpen={openSection === 'brand-info'}
                onToggle={(id) =>
                  setOpenSection((current) => (current === id ? '' : id))
                }
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
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion
                id="video-layout"
                title="Video Layout"
                description="Aspect ratio and clip framing"
                icon={<Clapperboard className="h-4 w-4" />}
                isOpen={openSection === 'video-layout'}
                onToggle={(id) =>
                  setOpenSection((current) => (current === id ? '' : id))
                }
              >
                <FieldGroup>
                  <div className="space-y-2">
                    <Label className={labelClassName}>Aspect ratio</Label>
                    <div className="flex flex-wrap gap-2">
                      {(['9_16', '1_1', '16_9'] as const).map((aspectRatio) => (
                        <Button
                          key={aspectRatio}
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleAspectRatio(aspectRatio)}
                          className={cn(
                            'h-auto gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors',
                            form.enabledAspectRatios.includes(aspectRatio)
                              ? 'border-foreground bg-foreground text-background hover:bg-foreground hover:text-background'
                              : 'border-border/60 bg-background/40 hover:border-border hover:bg-background/60'
                          )}
                        >
                          {aspectRatioIcon(aspectRatio)}
                          {aspectRatioLabel(aspectRatio)}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className={labelClassName}>Split layout</Label>
                    <div className="flex flex-wrap gap-2">
                      {layoutOptions.map((layout) => {
                        const isActive = form.enabledLayouts.includes(layout.value);

                        return (
                          <Button
                            key={layout.value}
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleLayout(layout.value)}
                            className={cn(
                              'h-auto gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors',
                              isActive
                                ? 'border-foreground bg-foreground text-background hover:bg-foreground hover:text-background'
                                : 'border-border/60 bg-background/40 hover:border-border hover:bg-background/60'
                            )}
                          >
                            {layout.label}
                            {isActive ? (
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-black" />
                            ) : null}
                          </Button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className={labelClassName}>Source crop</Label>
                    <div className="flex flex-wrap gap-2">
                      {cropOptions.map((crop) => (
                        <Button
                          key={crop.value}
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => updateForm('sourceCrop', crop.value)}
                          className={cn(
                            'h-auto rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors',
                            form.sourceCrop === crop.value
                              ? 'border-foreground bg-foreground text-background hover:bg-foreground hover:text-background'
                              : 'border-border/60 bg-background/40 hover:border-border hover:bg-background/60'
                          )}
                        >
                          {crop.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion
                id="captions"
                title="Captions"
                description="Position and animation"
                icon={<WrapText className="h-4 w-4" />}
                isOpen={openSection === 'captions'}
                onToggle={(id) =>
                  setOpenSection((current) => (current === id ? '' : id))
                }
              >
                <FieldGroup>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className={labelClassName}>Caption position</Label>
                      <SingleSelectPicker
                        value={form.captionPosition}
                        onValueChange={(value) =>
                          updateCaptionPosition(value as CaptionPosition)
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
                  {form.captionPosition === 'manual' ? (
                    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm text-muted-foreground">
                      Drag the preview caption to place it for the active{' '}
                      {aspectRatioLabel(form.aspectRatio)} frame. It now snaps to
                      guide axes while dragging.
                    </div>
                  ) : null}
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion
                id="colors"
                title="Colors"
                description="Caption palette"
                icon={<Palette className="h-4 w-4" />}
                isOpen={openSection === 'colors'}
                onToggle={(id) =>
                  setOpenSection((current) => (current === id ? '' : id))
                }
              >
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

              <EditorAccordion
                id="fonts"
                title="Fonts"
                description="Typeface and assets"
                icon={<Type className="h-4 w-4" />}
                isOpen={openSection === 'fonts'}
                onToggle={(id) =>
                  setOpenSection((current) => (current === id ? '' : id))
                }
              >
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
                id="logo-watermark"
                title="Logo / Watermark"
                description="Reusable visual overlay"
                icon={<Image className="h-4 w-4" />}
                isOpen={openSection === 'logo-watermark'}
                onToggle={(id) =>
                  setOpenSection((current) => (current === id ? '' : id))
                }
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

              <EditorAccordion
                id="cta-outro"
                title="CTA / Outro"
                description="Intro, outro, and CTA"
                icon={<Link2 className="h-4 w-4" />}
                isOpen={openSection === 'cta-outro'}
                onToggle={(id) =>
                  setOpenSection((current) => (current === id ? '' : id))
                }
              >
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
                    <Label className={labelClassName}>Cta url</Label>
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

        <section className="order-1 lg:order-2 lg:min-h-[44rem] lg:pl-10 xl:pl-14">
          <div className="flex w-full flex-col items-start gap-3">
            {form.enabledAspectRatios.length > 1 ? (
              <div className="flex w-full flex-wrap justify-center gap-2 lg:justify-start">
                {form.enabledAspectRatios.map((aspectRatio) => (
                  <Button
                    key={aspectRatio}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => updateForm('aspectRatio', aspectRatio)}
                    className={cn(
                      'h-auto gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors',
                      form.aspectRatio === aspectRatio
                        ? 'border-foreground bg-foreground text-background hover:bg-foreground hover:text-background'
                        : 'border-border/60 bg-background/40 hover:border-foreground/50 hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {aspectRatioIcon(aspectRatio)}
                    {aspectRatioLabel(aspectRatio)}
                  </Button>
                ))}
              </div>
            ) : null}
            <div className="flex w-full justify-center lg:justify-start">
              <BrandTemplateLivePreview
                form={form}
                reusableAssets={reusableAssets}
                updateCaptionPlacement={updateCaptionPlacement}
              />
            </div>
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

  function updateCaptionPlacement(
    aspectRatio: AspectRatio,
    placement: CaptionPlacement
  ) {
    setForm((current) => ({
      ...current,
      captionPlacements: {
        ...current.captionPlacements,
        [aspectRatio]: {
          x: clampUnit(placement.x),
          y: clampUnit(placement.y),
        },
      },
    }));
    setClientError(null);
  }

  function updateCaptionPosition(position: CaptionPosition) {
    setForm((current) => {
      if (position !== 'manual') {
        return { ...current, captionPosition: position };
      }

      const seededForm = ensureManualCaptionPlacement(
        current,
        current.captionPosition === 'manual' ? 'bottom' : current.captionPosition
      );

      return {
        ...seededForm,
        captionPosition: 'manual',
      };
    });
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
            cropSettings: {
              sourceCrop: form.sourceCrop,
              captionPlacements: form.captionPlacements,
            },
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
        <h1 className="text-3xl font-semibold text-foreground">
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
          updateForm={updateForm}
          updateCaptionPosition={updateCaptionPosition}
          updateCaptionPlacement={updateCaptionPlacement}
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
