'use client';

import { useEffect, useMemo, useState } from 'react';
import { extractVideoThumbnail } from '@/lib/disburse/video-thumbnail-client';
import {
  canExtractSourceAssetThumbnail,
  getSourceAssetAspectRatio,
  getSourceAssetMediaUrl,
  getStaticSourceAssetThumbnail,
  type SourceAssetThumbnailAsset,
} from '@/lib/disburse/source-asset-thumbnail';

type ResolvedThumbnail = {
  src: string;
  width: number;
  height: number;
  alt: string;
};

export function useSourceAssetThumbnail(
  asset: SourceAssetThumbnailAsset | null
) {
  const assetKey = useMemo(
    () =>
      asset
        ? [
            asset.id,
            asset.title,
            asset.assetType,
            asset.storageUrl,
            asset.mediaUrl || '',
            asset.mimeType || '',
            asset.thumbnailUrl || '',
            asset.thumbnailWidth || '',
            asset.thumbnailHeight || '',
          ].join('|')
        : 'none',
    [asset]
  );
  const [thumbnail, setThumbnail] = useState<ResolvedThumbnail | null>(() => {
    const staticThumbnail = getStaticSourceAssetThumbnail(asset);

    return staticThumbnail
      ? {
          src: staticThumbnail.src,
          width: staticThumbnail.width,
          height: staticThumbnail.height,
          alt: staticThumbnail.alt,
        }
      : null;
  });

  useEffect(() => {
    let isActive = true;
    let objectUrl: string | null = null;

    const staticThumbnail = getStaticSourceAssetThumbnail(asset);

    if (staticThumbnail) {
      setThumbnail((currentThumbnail) => {
        if (
          currentThumbnail &&
          currentThumbnail.src === staticThumbnail.src &&
          currentThumbnail.width === staticThumbnail.width &&
          currentThumbnail.height === staticThumbnail.height &&
          currentThumbnail.alt === staticThumbnail.alt
        ) {
          return currentThumbnail;
        }

        return {
          src: staticThumbnail.src,
          width: staticThumbnail.width,
          height: staticThumbnail.height,
          alt: staticThumbnail.alt,
        };
      });

      return () => {
        isActive = false;
      };
    }

    setThumbnail((currentThumbnail) => (currentThumbnail ? null : currentThumbnail));

    if (!canExtractSourceAssetThumbnail(asset)) {
      return () => {
        isActive = false;
      };
    }

    const mediaUrl = getSourceAssetMediaUrl(asset);

    if (!mediaUrl) {
      return () => {
        isActive = false;
      };
    }

    extractVideoThumbnail(mediaUrl)
      .then((result) => {
        if (!isActive) {
          return;
        }

        objectUrl = URL.createObjectURL(result.blob);
        setThumbnail({
          src: objectUrl,
          width: result.width,
          height: result.height,
          alt: asset?.title || 'Source thumbnail',
        });
      })
      .catch(() => undefined);

    return () => {
      isActive = false;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [asset, assetKey]);

  return {
    imageSrc: thumbnail?.src || null,
    imageAlt: thumbnail?.alt || asset?.title || 'Source thumbnail',
    aspectRatio: getSourceAssetAspectRatio(asset, thumbnail),
  };
}
