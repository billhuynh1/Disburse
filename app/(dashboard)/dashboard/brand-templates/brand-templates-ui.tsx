'use client';

import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  Square,
  Smartphone,
  Type,
  Trash2,
  Upload,
  WholeWord,
  WrapText,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  SingleSelectPicker,
  type SingleSelectPickerOption,
} from '@/components/ui/single-select-picker';
import {
  DashboardPageShell,
  FormMessage,
} from '@/components/dashboard/dashboard-ui';
import {
  captionStyleLabels,
  captionStyles,
  type CaptionStyle,
} from '@/lib/disburse/caption-style';
import { RenderedClipLayout, ReusableAssetKind } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import {
  formatUploadEta,
  readJsonResponse,
  uploadToStorageWithProgress,
} from '../upload-client';

export type ReusableAssetRecord = {
  id: number;
  kind: string;
  title: string;
  originalFilename: string;
};

type ReusableAssetsResponse = {
  assets?: ReusableAssetRecord[];
};

export type BrandTemplateRecord = {
  id: number;
  name: string;
  captions: {
    style: CaptionStyle | string;
    fontFamily: string;
    fontColor: string;
    highlightColor: string;
    position: 'top' | 'middle' | 'bottom' | 'manual' | string;
    animation: 'none' | 'pop' | 'fade' | string;
    captionFontAssetId: number | null;
    shadow?: {
      enabled: boolean;
      color: string;
      size: 'small' | 'medium' | 'large';
      style: 'soft' | 'solid';
    };
  };
  layout: {
    aspectRatio: '9_16' | '1_1' | '16_9' | string;
    enabledAspectRatios: ('9_16' | '1_1' | '16_9' | string)[];
    defaultLayout: RenderedClipLayout | string;
    enabledLayouts: (RenderedClipLayout | string)[];
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
type CaptionShadowSize = 'small' | 'medium' | 'large';
type CaptionShadowStyle = 'soft' | 'solid';
type CaptionShadow = {
  enabled: boolean;
  color: string;
  size: CaptionShadowSize;
  style: CaptionShadowStyle;
};

type BrandTemplatesResponse = {
  templates?: BrandTemplateRecord[];
};

type FormState = {
  name: string;
  captionsEnabled: boolean;
  captionText: string;
  captionFontFamily: string;
  captionFontColor: string;
  captionHighlightColor: string;
  captionHighlightEnabled: boolean;
  captionShadowEnabled: boolean;
  captionShadowColor: string;
  captionShadowSize: CaptionShadowSize;
  captionShadowStyle: CaptionShadowStyle;
  captionFontSize: number;
  captionStyle: CaptionStyle;
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
  captionsEnabled: true,
  captionText: 'Turn one episode into a week of clips',
  captionFontFamily: '',
  captionFontColor: '#ffffff',
  captionHighlightColor: '#facc15',
  captionHighlightEnabled: true,
  captionShadowEnabled: false,
  captionShadowColor: '#000000',
  captionShadowSize: 'medium',
  captionShadowStyle: 'solid',
  captionFontSize: 18,
  captionStyle: 'default',
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

const captionStyleOptions: SingleSelectPickerOption[] = captionStyles.map((value) => ({
  value,
  label: captionStyleLabels[value],
}));

const captionFontSizeOptions: SingleSelectPickerOption[] = [
  { value: '14', label: 'Small' },
  { value: '18', label: 'Medium' },
  { value: '24', label: 'Large' },
];

const captionShadowSizeOptions: SingleSelectPickerOption[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

const captionShadowStyleOptions: SingleSelectPickerOption[] = [
  { value: 'soft', label: 'Soft' },
  { value: 'solid', label: 'Stroke' },
];

const commonFontOptions: SingleSelectPickerOption[] = [
  { value: 'Arial', label: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Verdana', label: 'Verdana' },
  { value: 'Trebuchet MS', label: 'Trebuchet MS' },
  { value: 'Tahoma', label: 'Tahoma' },
  { value: 'Courier New', label: 'Courier New' },
];

const fontUploadAccept = '.otf,.ttf,.woff,.woff2';

const fieldBackgroundClassName =
  'input-autofill-transparent border-border/60 bg-transparent shadow-none focus-visible:border-ring/50 focus-visible:ring-ring/20';
const labelClassName =
  'text-sm font-medium tracking-normal text-muted-foreground';
const fieldGroupClassName = 'space-y-4';
const previewCaptionInsetPx = 16;
const previewCaptionSnapThresholdPx = 14;
const previewSplitGuideRatios = [0.3, 0.4, 0.5] as const;
const defaultPreviewCaptionText = 'Turn one episode into a week of clips';
const defaultCaptionShadow: CaptionShadow = {
  enabled: false,
  color: '#000000',
  size: 'medium',
  style: 'solid',
};

function normalizeCaptionShadow(value: unknown): CaptionShadow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultCaptionShadow;
  }

  const enabled =
    typeof (value as { enabled?: unknown }).enabled === 'boolean'
      ? (value as { enabled: boolean }).enabled
      : defaultCaptionShadow.enabled;
  const color =
    typeof (value as { color?: unknown }).color === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test((value as { color: string }).color)
      ? (value as { color: string }).color
      : defaultCaptionShadow.color;
  const size = (value as { size?: unknown }).size;
  const style = (value as { style?: unknown }).style;

  return {
    enabled,
    color,
    size:
      size === 'small' || size === 'medium' || size === 'large'
        ? size
        : defaultCaptionShadow.size,
    style:
      style === 'soft' || style === 'solid'
        ? style
        : defaultCaptionShadow.style,
  };
}

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

function aspectRatioPreviewWidthPx(value: FormState['aspectRatio']) {
  if (value === '16_9') {
    return 34 * 16;
  }

  if (value === '1_1') {
    return 26 * 16;
  }

  return 20 * 16;
}

function getCanonicalPreviewFrame(value: FormState['aspectRatio']) {
  const width = aspectRatioPreviewWidthPx(value);

  if (value === '1_1') {
    return {
      width,
      height: width,
    };
  }

  if (value === '16_9') {
    return {
      width,
      height: (width * 9) / 16,
    };
  }

  return {
    width,
    height: (width * 16) / 9,
  };
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

function getStoredCaptionHighlightEnabled(cropSettings: Record<string, unknown>) {
  return cropSettings.captionHighlightEnabled === false ? false : true;
}

function getStoredCaptionShadow(cropSettings: Record<string, unknown>): CaptionShadow {
  return normalizeCaptionShadow(cropSettings.captionShadow);
}

function getStoredCaptionsEnabled(cropSettings: Record<string, unknown>) {
  return cropSettings.captionsEnabled === false ? false : true;
}

function getStoredCaptionFontSize(cropSettings: Record<string, unknown>) {
  const value = cropSettings.captionFontSize;

  return typeof value === 'number' && Number.isFinite(value) ? value : 18;
}

function getStoredCaptionText(cropSettings: Record<string, unknown>) {
  const value = cropSettings.previewCaptionText;

  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : defaultPreviewCaptionText;
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

function uploadedFontFamilyName(assetId: string) {
  return `brand-template-font-${assetId}`;
}

function uploadedFontUrl(assetId: string) {
  return `/api/reusable-assets/${assetId}/file`;
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

function normalizeTemplateCaptionStyle(value: string | undefined): CaptionStyle {
  return captionStyles.includes(value as CaptionStyle)
    ? (value as CaptionStyle)
    : 'default';
}

function normalizeTemplateAspectRatio(value: string | undefined): AspectRatio {
  return value === '1_1' || value === '16_9' ? value : '9_16';
}

function normalizeTemplateLayout(value: string | undefined): RenderedClipLayout {
  return layoutOptions.some((option) => option.value === value)
    ? (value as RenderedClipLayout)
    : RenderedClipLayout.DEFAULT;
}

function normalizeTemplateCaptionPosition(
  value: string | undefined
): CaptionPosition {
  return value === 'top' || value === 'middle' || value === 'manual'
    ? value
    : 'bottom';
}

function normalizeTemplateCaptionAnimation(
  value: string | undefined
): 'none' | 'pop' | 'fade' {
  return value === 'pop' || value === 'fade' ? value : 'none';
}

function toFormState(template: BrandTemplateRecord): FormState {
  const captionShadow = template.captions.shadow
    ? normalizeCaptionShadow(template.captions.shadow)
    : getStoredCaptionShadow(template.cropSettings);
  const aspectRatio = normalizeTemplateAspectRatio(template.layout.aspectRatio);
  const defaultLayout = normalizeTemplateLayout(template.layout.defaultLayout);
  const enabledAspectRatios = template.layout.enabledAspectRatios?.length
    ? template.layout.enabledAspectRatios
        .map((value) => normalizeTemplateAspectRatio(value))
    : [aspectRatio];
  const enabledLayouts = template.layout.enabledLayouts?.length
    ? template.layout.enabledLayouts
        .map((value) => normalizeTemplateLayout(value))
    : [defaultLayout];

  return {
    name: template.name,
    captionsEnabled: getStoredCaptionsEnabled(template.cropSettings),
    captionText: getStoredCaptionText(template.cropSettings),
    captionStyle: normalizeTemplateCaptionStyle(template.captions.style),
    captionFontFamily: template.captions.fontFamily,
    captionFontColor: template.captions.fontColor,
    captionHighlightColor: template.captions.highlightColor,
    captionHighlightEnabled: getStoredCaptionHighlightEnabled(
      template.cropSettings
    ),
    captionShadowEnabled: captionShadow.enabled,
    captionShadowColor: captionShadow.color,
    captionShadowSize: captionShadow.size,
    captionShadowStyle: captionShadow.style,
    captionFontSize: getStoredCaptionFontSize(template.cropSettings),
    captionPosition: normalizeTemplateCaptionPosition(template.captions.position),
    captionAnimation: normalizeTemplateCaptionAnimation(template.captions.animation),
    captionFontAssetId: template.captions.captionFontAssetId?.toString() || '',
    aspectRatio,
    enabledAspectRatios,
    defaultLayout,
    enabledLayouts,
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

function getCaptionTextShadow(form: FormState) {
  if (!form.captionShadowEnabled) {
    return undefined;
  }

  const strength =
    form.captionShadowSize === 'small'
      ? 1
      : form.captionShadowSize === 'large'
        ? 6
        : 2;

  if (form.captionShadowStyle === 'solid') {
    return undefined;
  }

  const blurRadius = strength * 2;

  return `0 ${strength}px ${blurRadius}px ${form.captionShadowColor}`;
}

function getCaptionTextStrokeWidth(form: FormState) {
  if (!form.captionShadowEnabled || form.captionShadowStyle !== 'solid') {
    return undefined;
  }

  if (form.captionShadowSize === 'small') {
    return '1px';
  }

  if (form.captionShadowSize === 'large') {
    return '4px';
  }

  return '2px';
}

function compactLabel(
  options: readonly { value: string; label: string }[],
  value: string
) {
  return summaryLabel(options, value) || value;
}

function compactUrl(value: string) {
  return value
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

function normalizePreviewCaptionText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function getSingleWordPreviewText(text: string) {
  return normalizePreviewCaptionText(text).split(' ')[0] || text;
}

function uniqueValues(values: Array<string | null | undefined>) {
  return [...new Set(values.filter(Boolean) as string[])];
}

function TemplateCardHoverPreview({
  form,
  reusableAssets,
  compact = false,
}: {
  form: FormState;
  reusableAssets: ReusableAssetRecord[];
  compact?: boolean;
}) {
  const activeFontTitle = form.captionFontAssetId
    ? assetTitle(reusableAssets, form.captionFontAssetId)
    : null;
  const activeFontLabel =
    activeFontTitle || form.captionFontFamily || 'System default';
  const layoutValues = uniqueValues([
    aspectRatioLabel(form.aspectRatio),
    ...form.enabledAspectRatios.map((ratio) => aspectRatioLabel(ratio)),
    getLayoutLabel(form.defaultLayout),
    ...form.enabledLayouts.map((layout) => getLayoutLabel(layout)),
    form.sourceCrop !== 'original'
      ? compactLabel(cropOptions, form.sourceCrop)
      : null,
  ]);
  const captionValues = [
    captionStyleLabels[form.captionStyle],
    activeFontLabel,
    compactLabel(captionPositionOptions, form.captionPosition),
    compactLabel(captionFontSizeOptions, form.captionFontSize.toString()),
    form.captionAnimation !== 'none'
      ? compactLabel(captionAnimationOptions, form.captionAnimation)
      : null,
  ].filter(Boolean) as string[];
  const featureValues = [
    form.logoAssetId ? 'Logo' : null,
    form.introVideoAssetId ? 'Intro' : null,
    form.outroVideoAssetId ? 'Outro' : null,
    form.ctaUrl ? `CTA ${compactUrl(form.ctaUrl)}` : null,
  ].filter(Boolean) as string[];
  const colorValues = [
    form.captionFontColor,
    form.captionHighlightEnabled ? form.captionHighlightColor : null,
    form.captionShadowEnabled ? form.captionShadowColor : null,
  ].filter(Boolean) as string[];
  const rows = [
    { label: 'Font', value: activeFontLabel },
    { label: 'Auto Layout', value: layoutValues.join(',') },
    { label: 'Caption', value: captionValues.join(', ') },
    form.captionShadowEnabled
      ? {
          label: 'Shadow',
          value: [
            compactLabel(captionShadowStyleOptions, form.captionShadowStyle),
            compactLabel(captionShadowSizeOptions, form.captionShadowSize),
          ].join(', '),
        }
      : null,
    featureValues.length > 0
      ? { label: 'Extras', value: featureValues.join(', ') }
      : null,
  ].filter(Boolean) as Array<{
    label: string;
    value: string;
  }>;

  return (
    <div
      className={[
        'pointer-events-none absolute inset-0 z-10 overflow-hidden px-3 py-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100 peer-focus-visible:opacity-100',
        compact
          ? 'bg-transparent'
          : 'rounded-[1.5rem] border border-white/10 bg-[#05080a]',
      ].join(' ')}
    >
      <div className="flex h-full flex-col gap-3">
        {colorValues.length ? (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-semibold text-white/58">
              Colors:
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {colorValues.map((color) => (
                <ColorSwatch
                  key={color}
                  color={color}
                  className="h-3.5 w-3.5 shrink-0 border-white/20"
                />
              ))}
            </div>
          </div>
        ) : null}
        <ul className="space-y-2 overflow-hidden">
          {rows.map((row) => (
            <li key={row.label} className="text-[12px] leading-[1.45] sm:text-[13px]">
              <span className="font-semibold text-white/58">{row.label}:</span>{' '}
              <span className="font-semibold text-white">{row.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
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

export function TemplateCard({
  template,
  reusableAssets,
  deletingTemplateId,
  onDelete,
  onSelect,
  selected = false,
  hideDelete = false,
  actionLabel,
  compact = false,
  showHoverPreview = true,
}: {
  template: BrandTemplateRecord;
  reusableAssets: ReusableAssetRecord[];
  deletingTemplateId?: number | null;
  onDelete?: (templateId: number) => void;
  onSelect: (template: BrandTemplateRecord) => void;
  selected?: boolean;
  hideDelete?: boolean;
  actionLabel?: string;
  compact?: boolean;
  showHoverPreview?: boolean;
}) {
  const previewForm = toFormState(template);
  return (
    <Card
      className={[
        'group relative w-full cursor-pointer justify-self-start gap-0 bg-transparent py-0 shadow-none',
        compact ? 'w-[12.5rem] max-w-[12.5rem]' : 'max-w-[18rem]',
        'border-transparent',
      ].join(' ')}
    >
      <Button
        type="button"
        variant="ghost"
        onClick={() => onSelect(template)}
        className={[
          'peer absolute inset-0 z-0 w-full cursor-pointer p-0 hover:bg-transparent',
          compact ? 'h-[12.5rem] rounded-[1.2rem]' : 'h-[18rem] rounded-[1.5rem]',
        ].join(' ')}
        aria-label={actionLabel || `Edit ${template.name}`}
      />
      <CardContent
        className={[
          'pointer-events-none relative z-10 px-0 py-0 sm:px-0',
          compact ? 'space-y-2' : 'space-y-3',
        ].join(' ')}
      >
        <div className="relative aspect-square">
          <div
            className={[
              'pointer-events-none flex h-full items-center justify-center overflow-hidden border bg-[#080b0d] transition-all duration-200 group-hover:border-white/70 group-hover:shadow-[0_0_0_1px_rgba(255,255,255,0.08)] peer-focus-visible:border-white/70 peer-focus-visible:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]',
              compact ? 'rounded-[1.2rem] py-1.5' : 'rounded-[1.5rem] py-2',
              selected ? 'border-white' : 'border-white/8',
            ].join(' ')}
          >
            <div className="relative h-full w-full">
              <BrandTemplateLivePreview
                form={previewForm}
                reusableAssets={reusableAssets}
                updateCaptionPlacement={() => {}}
                captionText={
                  previewForm.captionStyle === 'single_word'
                    ? getSingleWordPreviewText(previewForm.captionText)
                    : previewForm.captionText
                }
                showContentLabels={false}
                interactive={false}
                className={[
                  'h-full w-full',
                  showHoverPreview
                    ? 'transition-opacity duration-200 group-hover:opacity-0 peer-focus-visible:opacity-0'
                    : null,
                ].filter(Boolean).join(' ')}
                frameClassName="rounded-none p-0"
                contentClassName="rounded-none"
                previewMode="fill"
              />
              {showHoverPreview ? (
                <TemplateCardHoverPreview
                  form={previewForm}
                  reusableAssets={reusableAssets}
                  compact={compact}
                />
              ) : null}
            </div>
          </div>
          {!hideDelete && onDelete ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={deletingTemplateId === template.id}
              className="pointer-events-auto absolute right-3 top-3 z-20 bg-black/88 text-white opacity-0 shadow-lg transition-opacity duration-200 hover:bg-black hover:text-white group-hover:opacity-100 group-focus-within:opacity-100"
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
              Delete
            </Button>
          ) : null}
        </div>
        <div className={compact ? 'px-0.5' : 'px-1'}>
          <div className={['min-w-0', compact ? 'text-center' : ''].join(' ')}>
            <p
              className={[
                'truncate font-semibold leading-none text-foreground',
                compact ? 'text-sm' : 'text-base',
              ].join(' ')}
            >
              {template.name}
            </p>
            {template.isDefault ? (
              <p
                className={[
                  'font-medium text-muted-foreground',
                  compact ? 'mt-0.5 text-[11px]' : 'mt-1 text-xs',
                ].join(' ')}
              >
                Default template
              </p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
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
  summary,
  description,
  icon,
  isOpen,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  summary?: ReactNode;
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
            {summary ? (
              <span className="mt-1 block text-sm text-foreground/80">
                {summary}
              </span>
            ) : null}
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

function sanitizeHexColorInput(value: string) {
  const uppercase = value.toUpperCase().replace(/[^#0-9A-F]/g, '');

  if (!uppercase) {
    return '';
  }

  const withoutHashes = uppercase.replace(/#/g, '');

  return `#${withoutHashes.slice(0, 6)}`;
}

function isValidHexColor(value: string) {
  return /^#([0-9A-F]{3}|[0-9A-F]{6})$/.test(value);
}

function resolveHexColor(value: string, fallback: string) {
  const sanitizedValue = sanitizeHexColorInput(value);
  const sanitizedFallback = sanitizeHexColorInput(fallback);

  return isValidHexColor(sanitizedValue) ? sanitizedValue : sanitizedFallback;
}

function ColorField({
  label,
  value,
  fallbackValue,
  onChange,
}: {
  label?: string;
  value: string;
  fallbackValue: string;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(sanitizeHexColorInput(value));

  useEffect(() => {
    setDraftValue(sanitizeHexColorInput(value));
  }, [value]);

  return (
    <div className="space-y-1.5">
      {label ? <Label className={labelClassName}>{label}</Label> : null}
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-transparent px-2 py-1 shadow-none">
        <Input
          type="color"
          value={resolveHexColor(value, fallbackValue)}
          onChange={(event) => onChange(sanitizeHexColorInput(event.target.value))}
          className="h-8 w-8 min-w-8 flex-none cursor-pointer appearance-none rounded-full border border-border/60 bg-transparent p-0 shadow-none [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0 [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-0"
        />
        <Input
          value={draftValue}
          onChange={(event) => {
            const nextValue = sanitizeHexColorInput(event.target.value);

            setDraftValue(nextValue);

            if (isValidHexColor(nextValue)) {
              onChange(nextValue);
            }
          }}
          onBlur={() => {
            setDraftValue(sanitizeHexColorInput(value));
          }}
          maxLength={7}
          spellCheck={false}
          className="h-8 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-0"
        />
      </div>
    </div>
  );
}

function assetTitle(assets: ReusableAssetRecord[], value: string) {
  return assets.find((asset) => asset.id.toString() === value)?.title;
}

function summaryLabel(
  options: readonly { value: string; label: string }[],
  value: string
) {
  return options.find((option) => option.value === value)?.label;
}

function summarizeItems(items: Array<string | null | undefined>, fallback: string) {
  const values = items.filter(Boolean) as string[];

  return values.length > 0 ? values.join(' • ') : fallback;
}

function createTitleFromFilename(filename: string) {
  return filename.replace(/\.[^.]+$/, '').trim() || 'Reusable asset';
}

function ColorSwatch({
  color,
  className,
}: {
  color: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full border border-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]',
        className
      )}
      style={{ backgroundColor: color }}
    />
  );
}

function FontPreviewText({
  assetId,
  className,
  fontFamily,
  fontUrl,
  sampleText = 'The quick brown fox jumps over the lazy dog',
}: {
  assetId?: string;
  className?: string;
  fontFamily?: string;
  fontUrl?: string;
  sampleText?: string;
}) {
  const resolvedFontFamily =
    fontFamily || (assetId ? uploadedFontFamilyName(assetId) : undefined);
  const resolvedFontUrl = fontUrl || (assetId ? uploadedFontUrl(assetId) : null);

  return (
    <span
      className={cn('block truncate', className)}
      style={{ fontFamily: resolvedFontFamily }}
    >
      {resolvedFontFamily && resolvedFontUrl ? (
        <style>{`@font-face { font-family: "${resolvedFontFamily}"; src: url("${resolvedFontUrl}"); }`}</style>
      ) : null}
      {sampleText}
    </span>
  );
}

function FontUploadDialog({
  onOpenChange,
  onUploaded,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  onUploaded: (asset: ReusableAssetRecord) => Promise<void>;
  open: boolean;
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadEtaSeconds, setUploadEtaSeconds] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl((currentUrl) => {
        if (currentUrl) {
          URL.revokeObjectURL(currentUrl);
        }

        return null;
      });
      return;
    }

    const objectUrl = URL.createObjectURL(selectedFile);
    setPreviewUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [selectedFile]);

  function resetState() {
    setSelectedFile(null);
    setPreviewUrl(null);
    setError(null);
    setIsUploading(false);
    setUploadPercent(0);
    setUploadEtaSeconds(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }

  async function handleUpload() {
    if (!selectedFile) {
      setError('Select a font file to upload.');
      return;
    }

    setError(null);
    setIsUploading(true);
    setUploadPercent(0);
    setUploadEtaSeconds(null);

    try {
      const initiatedUpload = await readJsonResponse(
        await fetch('/api/reusable-assets/uploads/initiate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            kind: ReusableAssetKind.FONT,
            filename: selectedFile.name,
            mimeType: selectedFile.type || 'application/octet-stream',
            fileSizeBytes: selectedFile.size,
          }),
        })
      );

      await uploadToStorageWithProgress({
        uploadUrl: initiatedUpload.uploadUrl,
        method: initiatedUpload.method,
        headers: initiatedUpload.headers,
        file: selectedFile,
        onProgress: (progress) => {
          setUploadPercent(progress.percent);
          setUploadEtaSeconds(progress.etaSeconds);
        },
      });

      const completedUpload = await readJsonResponse(
        await fetch('/api/reusable-assets/uploads/complete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            uploadToken: initiatedUpload.uploadToken,
          }),
        })
      );

      await onUploaded(completedUpload.asset as ReusableAssetRecord);
      resetState();
      onOpenChange(false);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          resetState();
        }

        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload font</DialogTitle>
          <DialogDescription>
            Add a font file and use it in this brand template.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="brand-template-font-upload" className={labelClassName}>
              Font file
            </Label>
            <Input
              ref={inputRef}
              id="brand-template-font-upload"
              type="file"
              accept={fontUploadAccept}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setSelectedFile(event.target.files?.[0] || null);
                setError(null);
              }}
              className={fieldBackgroundClassName}
            />
          </div>

          {selectedFile ? (
            <div className="rounded-lg border border-border/60 bg-background/30 p-3">
              <p className="truncate text-sm font-medium text-foreground">
                {createTitleFromFilename(selectedFile.name)}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {selectedFile.name}
              </p>
              {previewUrl ? (
                <FontPreviewText
                  className="mt-2 text-sm text-foreground"
                  fontFamily="brand-template-upload-preview"
                  fontUrl={previewUrl}
                  sampleText="The quick brown fox jumps over the lazy dog"
                />
              ) : null}
            </div>
          ) : null}

          {isUploading ? (
            <div className="rounded-lg border border-border/60 bg-background/30 p-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-foreground">Uploading</span>
                <span className="text-muted-foreground">{uploadPercent}%</span>
              </div>
              <div className="mt-2 h-1 rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground transition-[width]"
                  style={{ width: `${uploadPercent}%` }}
                />
              </div>
              <p className="mt-2 text-muted-foreground">
                {formatUploadEta(uploadEtaSeconds)}
              </p>
            </div>
          ) : null}

          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!selectedFile || isUploading}
            onClick={() => void handleUpload()}
          >
            {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Upload font
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
  captionText = defaultPreviewCaptionText,
  showContentLabels = true,
  interactive = true,
  className,
  frameClassName,
  contentClassName,
  previewMode = 'editor',
}: {
  form: FormState;
  reusableAssets: ReusableAssetRecord[];
  updateCaptionPlacement: (aspectRatio: AspectRatio, placement: CaptionPlacement) => void;
  captionText?: string;
  showContentLabels?: boolean;
  interactive?: boolean;
  className?: string;
  frameClassName?: string;
  contentClassName?: string;
  previewMode?: 'editor' | 'fill';
}) {
  const [facecam, content] = getLayoutRatio(form.defaultLayout);
  const logoTitle = assetTitle(reusableAssets, form.logoAssetId);
  const introTitle = assetTitle(reusableAssets, form.introVideoAssetId);
  const outroTitle = assetTitle(reusableAssets, form.outroVideoAssetId);
  const activeFontFamily = form.captionFontAssetId
    ? uploadedFontFamilyName(form.captionFontAssetId)
    : form.captionFontFamily || undefined;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const canonicalFrame = getCanonicalPreviewFrame(form.aspectRatio);
  const [viewportSize, setViewportSize] = useState(() => canonicalFrame);
  const [dragState, setDragState] = useState<{
    pointerId: number;
    originPlacement: CaptionPlacement;
    snappedX: number | null;
    snappedY: number | null;
  } | null>(null);
  const previewPlacement = getPreviewCaptionPlacement(form);
  const isManual = interactive && form.captionPosition === 'manual';
  const showDragGuides = isManual && dragState !== null;
  const previewScale = Math.min(
    viewportSize.width / canonicalFrame.width,
    viewportSize.height / canonicalFrame.height
  );
  const scaledFrameWidth = canonicalFrame.width * previewScale;
  const scaledFrameHeight = canonicalFrame.height * previewScale;
  const frameOffsetX = (viewportSize.width - scaledFrameWidth) / 2;
  const frameOffsetY = (viewportSize.height - scaledFrameHeight) / 2;

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const updateViewportSize = () => {
      const nextWidth = viewport.clientWidth;
      const nextHeight = viewport.clientHeight;

      if (nextWidth <= 0 || nextHeight <= 0) {
        return;
      }

      setViewportSize({
        width: nextWidth,
        height: nextHeight,
      });
    };

    updateViewportSize();

    const observer = new ResizeObserver(() => {
      updateViewportSize();
    });

    observer.observe(viewport);

    return () => {
      observer.disconnect();
    };
  }, [form.aspectRatio, previewMode]);

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
      ref={viewportRef}
      className={cn(
        previewMode === 'fill'
          ? 'relative mx-auto h-full w-full'
          : 'relative mx-auto w-full lg:mx-0',
        className,
        previewMode === 'fill' ? null : aspectRatioPreviewWidthClassName(form.aspectRatio),
        previewMode === 'fill' ? null : aspectRatioPreviewClassName(form.aspectRatio)
      )}
    >
      <div
        ref={previewFrameRef}
        className={cn(
          'absolute left-0 top-0 overflow-hidden rounded-[1.75rem] bg-zinc-950 p-3',
          frameClassName,
        )}
        style={{
          width: canonicalFrame.width,
          height: canonicalFrame.height,
          transform: `translate(${frameOffsetX}px, ${frameOffsetY}px) scale(${previewScale})`,
          transformOrigin: 'top left',
        }}
      >
          {form.captionFontAssetId ? (
            <style>{`@font-face { font-family: "${activeFontFamily}"; src: url("${uploadedFontUrl(form.captionFontAssetId)}"); }`}</style>
          ) : null}
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

          <div
            className={cn(
              'flex h-full flex-col gap-2 overflow-hidden rounded-[1.25rem] bg-background',
              contentClassName
            )}
          >
            {facecam > 0 ? (
              <div
                className="relative flex items-center justify-center bg-muted text-xs font-medium text-muted-foreground"
                style={{ flex: facecam }}
              >
                {showContentLabels ? 'Speaker' : null}
              </div>
            ) : null}
            <div
              className="relative flex min-h-0 items-center justify-center overflow-hidden bg-zinc-100 text-foreground dark:bg-zinc-700"
              style={{ flex: content }}
            >
              {showContentLabels ? (
                <div className="relative text-center text-xs font-medium">
                  Main content
                </div>
              ) : null}
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

          {form.captionsEnabled ? (
            <p
              ref={captionRef}
              className={cn(
                'absolute z-30 -translate-x-1/2 -translate-y-1/2 rounded-md px-3 py-2 text-center text-sm font-bold leading-snug',
                form.captionAnimation === 'pop' ? 'scale-105' : null,
                form.captionAnimation === 'fade' ? 'opacity-80' : null,
                isManual ? 'cursor-grab touch-none active:cursor-grabbing' : null
              )}
              style={{
                left: `${previewPlacement.x * 100}%`,
                top: `${previewPlacement.y * 100}%`,
                backgroundColor: form.captionHighlightEnabled
                  ? form.captionHighlightColor
                  : 'transparent',
                fontFamily: activeFontFamily,
                fontSize: `${form.captionFontSize}px`,
                maxWidth: `calc(100% - ${previewCaptionInsetPx * 2}px)`,
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
              <span className="grid">
                {form.captionShadowEnabled && form.captionShadowStyle === 'solid' ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none col-start-1 row-start-1 text-transparent"
                    style={{
                      WebkitTextFillColor: 'transparent',
                      WebkitTextStrokeWidth: getCaptionTextStrokeWidth(form),
                      WebkitTextStrokeColor: form.captionShadowColor,
                    }}
                  >
                    {captionText}
                  </span>
                ) : null}
                <span
                  className="col-start-1 row-start-1"
                  style={{
                    color: form.captionFontColor,
                    textShadow: getCaptionTextShadow(form),
                  }}
                >
                  {captionText}
                </span>
              </span>
            </p>
          ) : null}

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
  refreshReusableAssets,
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
  refreshReusableAssets: () => Promise<unknown>;
  updateForm: <Key extends keyof FormState>(key: Key, value: FormState[Key]) => void;
  updateCaptionPosition: (position: CaptionPosition) => void;
  updateCaptionPlacement: (
    aspectRatio: AspectRatio,
    placement: CaptionPlacement
  ) => void;
}) {
  const [openSection, setOpenSection] = useState('brand-info');
  const [isFontUploadDialogOpen, setIsFontUploadDialogOpen] = useState(false);
  const fontAssets = useMemo(
    () =>
      reusableAssets.filter((asset) => asset.kind === ReusableAssetKind.FONT),
    [reusableAssets]
  );
  const brandInfoSummary = (
    <span className="block truncate">{form.name.trim() || 'No template name'}</span>
  );
  const videoLayoutSummary = summarizeItems(
    [
      form.enabledAspectRatios
        .map((aspectRatio) => aspectRatioLabel(aspectRatio))
        .join(', '),
      getLayoutLabel(form.defaultLayout),
      cropOptions.find((option) => option.value === form.sourceCrop)?.label,
    ],
    'No layout selected'
  );
  const videoLayoutSummaryNode = (
    <span className="block truncate">{videoLayoutSummary}</span>
  );
  const captionsSummary = form.captionsEnabled
    ? summarizeItems(
        [
          captionStyleLabels[form.captionStyle],
          form.captionText.trim() || null,
          summaryLabel(captionPositionOptions, form.captionPosition),
          summaryLabel(captionAnimationOptions, form.captionAnimation),
          summaryLabel(captionFontSizeOptions, String(form.captionFontSize)),
        ],
        'No caption settings selected'
      )
    : 'Captions off';
  const captionsSummaryNode = (
    <span className="block truncate">{captionsSummary}</span>
  );
  const colorsSummary = (
    <span className="flex items-center gap-3">
      <span className="flex min-w-0 items-center gap-1.5">
        <ColorSwatch className="size-3.5 shrink-0" color={form.captionFontColor} />
        <span className="truncate">{form.captionFontColor.toUpperCase()}</span>
      </span>
      {form.captionHighlightEnabled ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <ColorSwatch
            className="size-3.5 shrink-0"
            color={form.captionHighlightColor}
          />
          <span className="truncate">
            {form.captionHighlightColor.toUpperCase()}
          </span>
        </span>
      ) : null}
      {form.captionShadowEnabled ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <ColorSwatch
            className="size-3.5 shrink-0"
            color={form.captionShadowColor || defaultCaptionShadow.color}
          />
          <span className="truncate">
            {(form.captionShadowColor || defaultCaptionShadow.color).toUpperCase()}
          </span>
        </span>
      ) : null}
    </span>
  );
  const fontsSummary = selectedFont ? (
    <span className="block min-w-0">
      <span className="block truncate">{selectedFont.title}</span>
      <FontPreviewText
        assetId={selectedFont.id.toString()}
        className="mt-0.5 text-xs text-muted-foreground"
        sampleText="The quick brown fox"
      />
    </span>
  ) : form.captionFontFamily.trim() ? (
    <span className="block min-w-0">
      <span className="block truncate">{form.captionFontFamily.trim()}</span>
      <FontPreviewText
        className="mt-0.5 text-xs text-muted-foreground"
        fontFamily={form.captionFontFamily.trim()}
        sampleText="The quick brown fox"
      />
    </span>
  ) : (
    <span className="block truncate">No font selected</span>
  );
  const logoSummary = (
    <span className="block truncate">
      {assetTitle(reusableAssets, form.logoAssetId) || 'No logo selected'}
    </span>
  );
  const introTitle = assetTitle(reusableAssets, form.introVideoAssetId);
  const outroTitle = assetTitle(reusableAssets, form.outroVideoAssetId);
  const ctaSummaryText = summarizeItems(
    [
      introTitle ? `Intro: ${introTitle}` : null,
      outroTitle ? `Outro: ${outroTitle}` : null,
      form.ctaUrl.trim() ? `CTA: ${form.ctaUrl.trim()}` : null,
    ],
    'No intro, outro, or CTA'
  );
  const ctaSummary = <span className="block truncate">{ctaSummaryText}</span>;
  const uploadedFontOptions: SingleSelectPickerOption[] = useMemo(
    () => [
      { value: '', label: 'None' },
      ...fontAssets.map((asset) => ({
        value: asset.id.toString(),
        label: asset.title,
        preview: (
          <FontPreviewText
            assetId={asset.id.toString()}
            sampleText="The quick brown fox"
          />
        ),
        triggerPreview: (
          <FontPreviewText
            assetId={asset.id.toString()}
            sampleText="The quick brown fox"
          />
        ),
      })),
    ],
    [fontAssets]
  );

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
                summary={brandInfoSummary}
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
                summary={videoLayoutSummaryNode}
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
                summary={captionsSummaryNode}
                icon={<WrapText className="h-4 w-4" />}
                isOpen={openSection === 'captions'}
                onToggle={(id) =>
                  setOpenSection((current) => (current === id ? '' : id))
                }
              >
                <FieldGroup>
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="captions-enabled" className={labelClassName}>
                      Show captions
                    </Label>
                    <Switch
                      id="captions-enabled"
                      checked={form.captionsEnabled}
                      onCheckedChange={(checked) =>
                        updateForm('captionsEnabled', checked === true)
                      }
                    />
                  </div>
                  <div
                    className={cn(
                      fieldGroupClassName,
                      form.captionsEnabled ? null : 'pointer-events-none opacity-50'
                    )}
                    aria-hidden={!form.captionsEnabled}
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="caption-text" className={labelClassName}>
                        Preview caption text
                      </Label>
                      <Input
                        id="caption-text"
                        value={form.captionText}
                        onChange={(event) =>
                          updateForm('captionText', event.target.value)
                        }
                        placeholder={defaultPreviewCaptionText}
                        maxLength={160}
                        disabled={!form.captionsEnabled}
                        className={fieldBackgroundClassName}
                      />
                    </div>
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className={labelClassName}>Style</Label>
                          <SingleSelectPicker
                            value={form.captionStyle}
                            onValueChange={(value) =>
                              updateForm('captionStyle', value as CaptionStyle)
                            }
                            options={captionStyleOptions}
                            placeholder="Select style"
                            triggerClassName={fieldBackgroundClassName}
                            disabled={!form.captionsEnabled}
                          />
                        </div>
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
                            disabled={!form.captionsEnabled}
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
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
                            disabled={!form.captionsEnabled}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className={labelClassName}>Font size</Label>
                          <SingleSelectPicker
                            value={String(form.captionFontSize)}
                            onValueChange={(value) =>
                              updateForm('captionFontSize', Number(value))
                            }
                            options={captionFontSizeOptions}
                            placeholder="Select size"
                            triggerClassName={fieldBackgroundClassName}
                            disabled={!form.captionsEnabled}
                          />
                        </div>
                      </div>
                    </div>
                    {form.captionsEnabled && form.captionPosition === 'manual' ? (
                      <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm text-muted-foreground">
                        Drag the preview caption to place it.
                      </div>
                    ) : null}
                  </div>
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion
                id="colors"
                title="Colors"
                summary={colorsSummary}
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
                      fallbackValue={emptyForm.captionFontColor}
                      onChange={(value) => updateForm('captionFontColor', value)}
                    />
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <Label htmlFor="caption-highlight-enabled" className={labelClassName}>
                          Highlight
                        </Label>
                        <Switch
                          id="caption-highlight-enabled"
                          checked={form.captionHighlightEnabled}
                          onCheckedChange={(checked) =>
                            updateForm('captionHighlightEnabled', checked === true)
                          }
                        />
                      </div>
                      {form.captionHighlightEnabled ? (
                        <ColorField
                          label=""
                          value={form.captionHighlightColor}
                          fallbackValue={emptyForm.captionHighlightColor}
                          onChange={(value) =>
                            updateForm('captionHighlightColor', value)
                          }
                        />
                      ) : null}
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="caption-shadow-enabled" className={labelClassName}>
                        Shadow
                      </Label>
                      <Switch
                        id="caption-shadow-enabled"
                        checked={form.captionShadowEnabled}
                        onCheckedChange={(checked) =>
                          updateForm('captionShadowEnabled', checked === true)
                        }
                      />
                    </div>
                    {form.captionShadowEnabled ? (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <ColorField
                          label="Shadow color"
                          value={form.captionShadowColor}
                          fallbackValue={defaultCaptionShadow.color}
                          onChange={(value) => updateForm('captionShadowColor', value)}
                        />
                        <div className="space-y-1.5">
                          <Label className={labelClassName}>Shadow size</Label>
                          <SingleSelectPicker
                            value={form.captionShadowSize}
                            onValueChange={(value) =>
                              updateForm(
                                'captionShadowSize',
                                value as FormState['captionShadowSize']
                              )
                            }
                            options={captionShadowSizeOptions}
                            placeholder="Select size"
                            triggerClassName={fieldBackgroundClassName}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className={labelClassName}>Shadow style</Label>
                          <SingleSelectPicker
                            value={form.captionShadowStyle}
                            onValueChange={(value) =>
                              updateForm(
                                'captionShadowStyle',
                                value as FormState['captionShadowStyle']
                              )
                            }
                            options={captionShadowStyleOptions}
                            placeholder="Select style"
                            triggerClassName={fieldBackgroundClassName}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion
                id="fonts"
                title="Fonts"
                summary={fontsSummary}
                icon={<Type className="h-4 w-4" />}
                isOpen={openSection === 'fonts'}
                onToggle={(id) =>
                  setOpenSection((current) => (current === id ? '' : id))
                }
              >
                <FieldGroup>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <div className="space-y-1.5">
                      <Label className={labelClassName}>Uploaded font</Label>
                      <SingleSelectPicker
                        value={form.captionFontAssetId}
                        onValueChange={(value) =>
                          updateForm('captionFontAssetId', value)
                        }
                        options={uploadedFontOptions}
                        placeholder="None"
                        triggerClassName={cn(fieldBackgroundClassName, 'h-auto')}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setIsFontUploadDialogOpen(true)}
                    >
                      <Upload className="h-4 w-4" />
                      Upload font
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    <Label className={labelClassName}>Default fonts</Label>
                    <SingleSelectPicker
                      value={form.captionFontFamily}
                      onValueChange={(value) =>
                        updateForm('captionFontFamily', value)
                      }
                      options={commonFontOptions}
                      placeholder="Select a default font"
                      triggerClassName={fieldBackgroundClassName}
                    />
                  </div>
                </FieldGroup>
              </EditorAccordion>

              <EditorAccordion
                id="logo-watermark"
                title="Logo / Watermark"
                summary={logoSummary}
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
                summary={ctaSummary}
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
                <Button
                  type="submit"
                  variant="default"
                  size="lg"
                  disabled={isSaving}
                  className="flex-1"
                >
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

        <FontUploadDialog
          open={isFontUploadDialogOpen}
          onOpenChange={setIsFontUploadDialogOpen}
          onUploaded={async (asset) => {
            await refreshReusableAssets();
            updateForm('captionFontAssetId', asset.id.toString());
          }}
        />

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
                captionText={
                  form.captionStyle === 'single_word'
                    ? getSingleWordPreviewText(form.captionText)
                    : form.captionText
                }
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
  const { data: reusableAssetsData, mutate: mutateReusableAssets } =
    useSWR<ReusableAssetsResponse>(
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
              captionsEnabled: form.captionsEnabled,
              captionStyle: form.captionStyle,
              captionPlacements: form.captionPlacements,
              captionHighlightEnabled: form.captionHighlightEnabled,
              captionShadow: {
                enabled: form.captionShadowEnabled,
                color: form.captionShadowColor,
                size: form.captionShadowSize,
                style: form.captionShadowStyle,
              },
              captionFontSize: form.captionFontSize,
              previewCaptionText: form.captionText,
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
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-3xl">
          <h1 className="text-3xl font-semibold text-foreground">
            Brand Templates
          </h1>
        </div>
        {pageMode === 'browse' ? (
          <Button
            type="button"
            onClick={startCreate}
            className="w-full sm:w-auto"
          >
            Create template
          </Button>
        ) : null}
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
          refreshReusableAssets={async () => await mutateReusableAssets()}
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

          {!error && templates.length === 0 ? (
            <Card className="border-0 bg-transparent shadow-none">
              <CardContent className="flex flex-col items-center px-6 py-12 text-center">
                <div className="space-y-1">
                  <h2 className="text-lg font-medium text-foreground">
                    No brand templates yet
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Create a template to reuse your clip layout, captions, and branding.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {!error && templates.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  reusableAssets={reusableAssets}
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
