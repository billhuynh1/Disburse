export const captionStyles = ['default', 'single_word'] as const;

export type CaptionStyle = (typeof captionStyles)[number];

export const DEFAULT_CAPTION_STYLE: CaptionStyle = 'default';

export const captionStyleLabels: Record<CaptionStyle, string> = {
  default: 'Default',
  single_word: 'Single word',
};
