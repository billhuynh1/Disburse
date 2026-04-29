'use client';

import { Clapperboard } from 'lucide-react';

type ProjectThumbnailFrameProps = {
  imageSrc?: string | null;
  imageAlt?: string;
  imageClassName?: string;
};

export function ProjectThumbnailFrame({
  imageSrc,
  imageAlt = 'Project thumbnail',
  imageClassName = 'h-full w-full object-cover'
}: ProjectThumbnailFrameProps) {
  return (
    <div className="relative h-full w-full overflow-hidden rounded-2xl bg-black">
      {imageSrc ? (
        <img src={imageSrc} alt={imageAlt} className={imageClassName} />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))]">
          <div className="flex items-center gap-1.5 rounded-full bg-black/40 px-2.5 py-1 text-[11px] text-white/70">
            <Clapperboard className="h-3.5 w-3.5" />
            Video
          </div>
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/0 to-black/0" />
    </div>
  );
}
