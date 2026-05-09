'use client';

import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type RefObject,
  useMemo,
  useRef,
  useState,
} from 'react';
import useSWR from 'swr';
import {
  Download,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DashboardPageShell,
  EmptyState,
  FormMessage,
} from '@/components/dashboard/dashboard-ui';
import { cn } from '@/lib/utils';
import { ReusableAssetKind } from '@/lib/db/schema';
import {
  formatUploadEta,
  readJsonResponse,
  uploadToStorageWithProgress,
} from '../upload-client';

type ReusableAssetRecord = {
  id: number;
  kind: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

type ReusableAssetsResponse = {
  assets?: ReusableAssetRecord[];
};

type MediaFilter =
  | 'all'
  | ReusableAssetKind.IMAGE
  | ReusableAssetKind.VIDEO
  | ReusableAssetKind.AUDIO;

const assetKinds: {
  value: ReusableAssetKind;
  label: string;
  accept: string;
  icon: typeof FileImage;
}[] = [
  {
    value: ReusableAssetKind.IMAGE,
    label: 'Image',
    accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml',
    icon: FileImage,
  },
  {
    value: ReusableAssetKind.VIDEO,
    label: 'Video',
    accept: 'video/mp4,video/quicktime,video/webm,video/x-matroska',
    icon: FileVideo,
  },
  {
    value: ReusableAssetKind.AUDIO,
    label: 'Audio',
    accept: 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/webm',
    icon: FileAudio,
  },
  {
    value: ReusableAssetKind.FONT,
    label: 'Font',
    accept: '.otf,.ttf,.woff,.woff2',
    icon: FileText,
  },
];

const mediaFilters: { value: MediaFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: ReusableAssetKind.IMAGE, label: 'Images' },
  { value: ReusableAssetKind.VIDEO, label: 'Videos' },
  { value: ReusableAssetKind.AUDIO, label: 'Audio' },
];

const mediaAssetKinds = [
  ReusableAssetKind.IMAGE,
  ReusableAssetKind.VIDEO,
  ReusableAssetKind.AUDIO,
] as const;

const mediaAccept = assetKinds
  .filter((kind) =>
    mediaAssetKinds.includes(kind.value as (typeof mediaAssetKinds)[number])
  )
  .map((kind) => kind.accept)
  .join(',');

const fetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Failed to load reusable assets.');
  }

  return (await response.json()) as ReusableAssetsResponse;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function createTitleFromFilename(filename: string) {
  return filename.replace(/\.[^.]+$/, '').trim() || 'Reusable asset';
}

function getAssetKindIcon(kind: string) {
  return (
    assetKinds.find((assetKind) => assetKind.value === kind)?.icon || FileImage
  );
}

function getAssetKindLabel(kind: string) {
  return (
    assetKinds.find((assetKind) => assetKind.value === kind)?.label ||
    kind.replaceAll('_', ' ')
  );
}

function getMediaKindFromFile(file: File | null) {
  if (!file) {
    return ReusableAssetKind.IMAGE;
  }

  const extension = file.name.split('.').pop()?.toLowerCase();

  if (file.type.startsWith('video/')) {
    return ReusableAssetKind.VIDEO;
  }

  if (file.type.startsWith('audio/')) {
    return ReusableAssetKind.AUDIO;
  }

  if (extension && ['mp4', 'mov', 'webm', 'mkv'].includes(extension)) {
    return ReusableAssetKind.VIDEO;
  }

  if (extension && ['mp3', 'wav', 'm4a'].includes(extension)) {
    return ReusableAssetKind.AUDIO;
  }

  return ReusableAssetKind.IMAGE;
}

function AssetThumbnail({ asset }: { asset: ReusableAssetRecord }) {
  if (asset.kind === ReusableAssetKind.IMAGE) {
    return (
      <img
        src={`/api/reusable-assets/${asset.id}/file`}
        alt={asset.title}
        className="h-9 w-9 rounded-md border border-border/60 object-cover"
      />
    );
  }

  const AssetIcon = getAssetKindIcon(asset.kind);

  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
      <AssetIcon className="h-3.5 w-3.5" />
    </div>
  );
}

function UploadDropzone({
  inputRef,
  inputId,
  accept,
  onChange,
  onDrop,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  inputId: string;
  accept: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLLabelElement>) => void;
}) {
  return (
    <label
      htmlFor={inputId}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      className="flex h-32 w-full max-w-[18rem] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border/80 bg-background/20 text-muted-foreground transition-colors hover:border-border hover:bg-muted/20"
    >
      <Upload className="mb-3 h-6 w-6" />
      <span className="text-sm font-medium">Add or drag file here</span>
      <Input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        onChange={onChange}
        className="sr-only"
      />
    </label>
  );
}

function UploadStatus({
  selectedFile,
  isUploading,
  uploadPercent,
  uploadEtaSeconds,
}: {
  selectedFile: File | null;
  isUploading: boolean;
  uploadPercent: number;
  uploadEtaSeconds: number | null;
}) {
  if (!selectedFile && !isUploading) {
    return null;
  }

  return (
    <div className="max-w-[18rem] rounded-md border border-border/60 bg-background/30 p-2.5 text-xs">
      {selectedFile ? (
        <>
          <p className="truncate font-medium text-foreground">
            {createTitleFromFilename(selectedFile.name)}
          </p>
          <p className="mt-1 truncate text-muted-foreground">
            {selectedFile.name} • {formatBytes(selectedFile.size)}
          </p>
        </>
      ) : null}

      {isUploading ? (
        <div className={cn(selectedFile ? 'mt-3' : null)}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-foreground">Uploading</span>
            <span className="text-muted-foreground">{uploadPercent}%</span>
          </div>
          <div className="mt-2 h-1 rounded-full bg-muted">
            <div
              className="h-1 rounded-full bg-foreground transition-[width]"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {formatUploadEta(uploadEtaSeconds)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function AssetList({
  assets,
  deletingAssetId,
  onDelete,
}: {
  assets: ReusableAssetRecord[];
  deletingAssetId: number | null;
  onDelete: (assetId: number) => void;
}) {
  return (
    <div className="max-w-3xl divide-y divide-border/60 border-y border-border/60">
      {assets.map((asset) => (
        <div
          key={asset.id}
          className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <AssetThumbnail asset={asset} />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">
                {asset.title}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {getAssetKindLabel(asset.kind)} • {asset.originalFilename}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {formatBytes(asset.fileSizeBytes)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto">
            <Button asChild variant="ghost" size="sm">
              <a href={`/api/reusable-assets/${asset.id}/file?download=1`}>
                <Download className="h-4 w-4" />
                Download
              </a>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={deletingAssetId === asset.id}
              onClick={() => onDelete(asset.id)}
              aria-label="Delete asset"
            >
              {deletingAssetId === asset.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function AssetsPage() {
  const formRef = useRef<HTMLFormElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const [selectedKind, setSelectedKind] = useState<ReusableAssetKind>(
    ReusableAssetKind.IMAGE
  );
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all');
  const [clientError, setClientError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadEtaSeconds, setUploadEtaSeconds] = useState<number | null>(null);
  const [deletingAssetId, setDeletingAssetId] = useState<number | null>(null);
  const { data, error, mutate } = useSWR<ReusableAssetsResponse>(
    '/api/reusable-assets',
    fetcher
  );

  const assets = data?.assets || [];
  const fontAssets = useMemo(
    () => assets.filter((asset) => asset.kind === ReusableAssetKind.FONT),
    [assets]
  );
  const mediaAssets = useMemo(
    () =>
      assets.filter((asset) =>
        mediaAssetKinds.includes(asset.kind as (typeof mediaAssetKinds)[number])
      ),
    [assets]
  );
  const filteredMediaAssets = useMemo(
    () =>
      mediaFilter === 'all'
        ? mediaAssets
        : mediaAssets.filter((asset) => asset.kind === mediaFilter),
    [mediaAssets, mediaFilter]
  );

  function handleFileSelection(file: File | null, kind: ReusableAssetKind) {
    setSelectedKind(kind);
    setSelectedFile(file);
    setClientError(null);
  }

  function handleFontInputChange(event: ChangeEvent<HTMLInputElement>) {
    handleFileSelection(event.target.files?.[0] || null, ReusableAssetKind.FONT);
  }

  function handleMediaInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] || null;
    const inferredKind = getMediaKindFromFile(file);
    handleFileSelection(file, inferredKind);
  }

  function handleDrop(
    event: DragEvent<HTMLLabelElement>,
    kind: ReusableAssetKind
  ) {
    event.preventDefault();
    handleFileSelection(event.dataTransfer.files?.[0] || null, kind);
  }

  function handleMediaDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0] || null;
    handleFileSelection(file, getMediaKindFromFile(file));
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedFile) {
      setClientError('Select a file to upload.');
      return;
    }

    setClientError(null);
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
            kind: selectedKind,
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

      await readJsonResponse(
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

      formRef.current?.reset();
      if (fontInputRef.current) {
        fontInputRef.current.value = '';
      }
      if (mediaInputRef.current) {
        mediaInputRef.current.value = '';
      }
      setSelectedFile(null);
      setUploadPercent(0);
      setUploadEtaSeconds(null);
      await mutate();
    } catch (uploadError) {
      const message =
        uploadError instanceof Error ? uploadError.message : 'Upload failed.';
      setClientError(message);
    } finally {
      setIsUploading(false);
    }
  }

  async function handleDelete(assetId: number) {
    setDeletingAssetId(assetId);

    try {
      await readJsonResponse(
        await fetch(`/api/reusable-assets?id=${assetId}`, {
          method: 'DELETE',
        })
      );
      await mutate();
    } catch (deleteError) {
      const message =
        deleteError instanceof Error
          ? deleteError.message
          : 'Unable to delete asset.';
      setClientError(message);
    } finally {
      setDeletingAssetId(null);
    }
  }

  return (
    <DashboardPageShell>
      <div className="mb-6 max-w-2xl">
        <h1 className="text-3xl font-semibold text-foreground">Assets</h1>
        <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
          Store reusable fonts, images, videos, and audio files for future clip
          workflows.
        </p>
      </div>

      <form ref={formRef} onSubmit={handleUpload} className="max-w-4xl space-y-10">
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground">
            Fonts ({fontAssets.length}/{fontAssets.length})
          </h2>

          <UploadDropzone
            inputRef={fontInputRef}
            inputId="font-asset-file"
            accept={
              assetKinds.find((kind) => kind.value === ReusableAssetKind.FONT)
                ?.accept || ''
            }
            onChange={handleFontInputChange}
            onDrop={(event) => handleDrop(event, ReusableAssetKind.FONT)}
          />

          {selectedKind === ReusableAssetKind.FONT ? (
            <UploadStatus
              selectedFile={selectedFile}
              isUploading={isUploading}
              uploadPercent={uploadPercent}
              uploadEtaSeconds={uploadEtaSeconds}
            />
          ) : null}

          <Button
            type="submit"
            variant="ghost"
            disabled={
              isUploading ||
              !selectedFile ||
              selectedKind !== ReusableAssetKind.FONT
            }
            className="h-auto px-0 text-base font-semibold text-foreground hover:bg-transparent"
          >
            {isUploading && selectedKind === ReusableAssetKind.FONT ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Upload font
          </Button>

          {fontAssets.length > 0 ? (
            <AssetList
              assets={fontAssets}
              deletingAssetId={deletingAssetId}
              onDelete={handleDelete}
            />
          ) : null}
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground">Media</h2>

          <div className="flex flex-wrap gap-2">
            {mediaFilters.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setMediaFilter(item.value)}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  mediaFilter === item.value
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <UploadDropzone
            inputRef={mediaInputRef}
            inputId="media-asset-file"
            accept={mediaAccept}
            onChange={handleMediaInputChange}
            onDrop={handleMediaDrop}
          />

          {selectedKind !== ReusableAssetKind.FONT ? (
            <UploadStatus
              selectedFile={selectedFile}
              isUploading={isUploading}
              uploadPercent={uploadPercent}
              uploadEtaSeconds={uploadEtaSeconds}
            />
          ) : null}

          <Button
            type="submit"
            variant="ghost"
            disabled={
              isUploading ||
              !selectedFile ||
              selectedKind === ReusableAssetKind.FONT
            }
            className="h-auto px-0 text-base font-semibold text-foreground hover:bg-transparent"
          >
            {isUploading && selectedKind !== ReusableAssetKind.FONT ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Upload video/image/audio
          </Button>

          {filteredMediaAssets.length === 0 ? (
            <EmptyState
              title="No media assets yet"
              description="Upload reusable media files here to build your asset library."
            />
          ) : (
            <AssetList
              assets={filteredMediaAssets}
              deletingAssetId={deletingAssetId}
              onDelete={handleDelete}
            />
          )}
        </section>

        {clientError ? <FormMessage tone="error">{clientError}</FormMessage> : null}
        {error ? (
          <FormMessage tone="error">
            Unable to load reusable assets right now.
          </FormMessage>
        ) : null}
      </form>
    </DashboardPageShell>
  );
}
