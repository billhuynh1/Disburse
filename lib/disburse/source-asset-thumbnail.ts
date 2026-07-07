import { SourceAssetType } from '../db/schema.ts';

export type SourceAssetThumbnailAsset = {
  id: number;
  title: string;
  assetType: string;
  storageUrl: string;
  mimeType?: string | null;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  thumbnailWidth?: number | null;
  thumbnailHeight?: number | null;
};

export function parseYouTubeVideoId(url: string) {
  try {
    const parsed = new URL(url);

    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.replace(/\//g, '').trim() || null;
    }

    if (
      parsed.hostname === 'www.youtube.com' ||
      parsed.hostname === 'youtube.com' ||
      parsed.hostname === 'm.youtube.com'
    ) {
      return parsed.searchParams.get('v')?.trim() || null;
    }

    return null;
  } catch {
    return null;
  }
}

export function getStaticSourceAssetThumbnail(
  asset: SourceAssetThumbnailAsset | null
) {
  if (!asset) {
    return null;
  }

  if (asset.thumbnailUrl && asset.thumbnailWidth && asset.thumbnailHeight) {
    return {
      kind: 'image' as const,
      src: asset.thumbnailUrl,
      width: asset.thumbnailWidth,
      height: asset.thumbnailHeight,
      alt: asset.title || 'Source thumbnail',
    };
  }

  if (asset.assetType === SourceAssetType.YOUTUBE_URL) {
    const videoId = parseYouTubeVideoId(asset.storageUrl);

    if (videoId) {
      return {
        kind: 'image' as const,
        src: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        width: 480,
        height: 360,
        alt: asset.title || 'YouTube thumbnail',
      };
    }
  }

  return null;
}

export function getSourceAssetMediaUrl(asset: SourceAssetThumbnailAsset | null) {
  if (!asset) {
    return null;
  }

  if (asset.assetType === SourceAssetType.UPLOADED_FILE) {
    return asset.mediaUrl || `/api/source-assets/${asset.id}/media`;
  }

  return asset.storageUrl;
}

export function canExtractSourceAssetThumbnail(
  asset: SourceAssetThumbnailAsset | null
) {
  if (!asset || asset.assetType !== SourceAssetType.UPLOADED_FILE) {
    return false;
  }

  if (asset.mimeType && !asset.mimeType.startsWith('video/')) {
    return false;
  }

  return Boolean(getSourceAssetMediaUrl(asset));
}

export function getSourceAssetAspectRatio(
  asset: SourceAssetThumbnailAsset | null,
  thumbnail?: { width: number; height: number } | null
) {
  if (thumbnail && thumbnail.width > 0 && thumbnail.height > 0) {
    return `${thumbnail.width} / ${thumbnail.height}`;
  }

  if (!asset) {
    return '16 / 9';
  }

  if (asset.assetType === SourceAssetType.PASTED_TRANSCRIPT) {
    return '4 / 3';
  }

  return '16 / 9';
}
