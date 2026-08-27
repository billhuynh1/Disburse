import type { CaptionStyle } from './caption-style.ts';

export type CaptionPreviewAspectRatio = '9_16' | '1_1' | '16_9';
export type CaptionPreviewPosition = 'top' | 'middle' | 'bottom' | 'manual';
export type CaptionPreviewPlacement = { x: number; y: number };

const ASS_PLAY_RES_X = 1080;
const ASS_CAPTION_FONT_SIZE = 58;
const ASS_CAPTION_OUTLINE_SIZE = 4;
const ASS_CAPTION_MARGIN_HORIZONTAL = 72;

const defaultCaptionPlacements: Record<
  CaptionPreviewAspectRatio,
  Record<'top' | 'middle' | 'bottom', CaptionPreviewPlacement>
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

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

function normalizeCaptionText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

export function getAssCaptionPreviewText(params: {
  captionStyle: CaptionStyle;
  text: string;
}) {
  const text = normalizeCaptionText(params.text);

  return params.captionStyle === 'single_word' ? text.split(' ')[0] || text : text;
}

export function getAssCaptionPreviewPlacement(params: {
  aspectRatio: CaptionPreviewAspectRatio;
  position: CaptionPreviewPosition;
  placements?: Partial<Record<CaptionPreviewAspectRatio, CaptionPreviewPlacement>>;
}) {
  if (params.position === 'manual') {
    const placement =
      params.placements?.[params.aspectRatio] ||
      defaultCaptionPlacements[params.aspectRatio].bottom;

    return { x: clampUnit(placement.x), y: clampUnit(placement.y) };
  }

  return defaultCaptionPlacements[params.aspectRatio][params.position];
}

export function getAssCaptionPreviewSemantics(params: {
  aspectRatio: CaptionPreviewAspectRatio;
  position: CaptionPreviewPosition;
  placements?: Partial<Record<CaptionPreviewAspectRatio, CaptionPreviewPlacement>>;
  captionStyle: CaptionStyle;
  captionText: string;
  captionFontColor: string;
  captionHighlightEnabled: boolean;
  captionHighlightColor: string;
  frameWidthPx: number;
}) {
  const scale = params.frameWidthPx / ASS_PLAY_RES_X;
  const position = params.position === 'manual' ? 'middle' : params.position;

  return {
    placement: getAssCaptionPreviewPlacement(params),
    text: getAssCaptionPreviewText({
      captionStyle: params.captionStyle,
      text: params.captionText,
    }),
    transform:
      position === 'top'
        ? 'translate(-50%, -100%)'
        : position === 'bottom'
          ? 'translate(-50%, 0)'
          : 'translate(-50%, -50%)',
    fontSizePx: ASS_CAPTION_FONT_SIZE * scale,
    boxPaddingPx: ASS_CAPTION_OUTLINE_SIZE * scale,
    maxWidthPercent:
      ((ASS_PLAY_RES_X - ASS_CAPTION_MARGIN_HORIZONTAL * 2) / ASS_PLAY_RES_X) *
      100,
    backgroundColor: params.captionHighlightEnabled
      ? params.captionHighlightColor
      : undefined,
    fontColor: params.captionFontColor,
    borderRadiusPx: 0,
  };
}
