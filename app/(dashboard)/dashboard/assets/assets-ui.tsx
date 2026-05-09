'use client';

import { type FormEvent, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DashboardPageHeader,
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

type AssetFilter = 'all' | ReusableAssetKind;

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

const filters: { value: AssetFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: ReusableAssetKind.IMAGE, label: 'Images' },
  { value: ReusableAssetKind.VIDEO, label: 'Videos' },
  { value: ReusableAssetKind.AUDIO, label: 'Audio' },
  { value: ReusableAssetKind.FONT, label: 'Fonts' },
];

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

export function AssetsPage() {
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedKind, setSelectedKind] = useState<ReusableAssetKind>(
    ReusableAssetKind.IMAGE
  );
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filter, setFilter] = useState<AssetFilter>('all');
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
  const filteredAssets = useMemo(
    () =>
      filter === 'all'
        ? assets
        : assets.filter((asset) => asset.kind === filter),
    [assets, filter]
  );
  const currentAccept =
    assetKinds.find((kind) => kind.value === selectedKind)?.accept || '*/*';

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
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
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
      <DashboardPageHeader
        title="Assets"
        description="Upload reusable fonts, images, videos, and audio files for future clip workflows."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Upload asset</CardTitle>
            <CardDescription>
              Store reusable files in one place. Assets are uploadable now, but
              they are not yet injected into clip rendering automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form ref={formRef} onSubmit={handleUpload} className="space-y-4">
              <div className="grid gap-2">
                <Label>Asset type</Label>
                <div className="grid grid-cols-2 gap-2">
                  {assetKinds.map((kind) => (
                    <button
                      key={kind.value}
                      type="button"
                      onClick={() => {
                        setSelectedKind(kind.value);
                        setSelectedFile(null);
                        if (fileInputRef.current) {
                          fileInputRef.current.value = '';
                        }
                      }}
                      className={cn(
                        'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                        selectedKind === kind.value
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border/70 bg-background text-muted-foreground'
                      )}
                    >
                      <kind.icon className="h-4 w-4" />
                      {kind.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="asset-file">File</Label>
                <Input
                  id="asset-file"
                  ref={fileInputRef}
                  type="file"
                  accept={currentAccept}
                  onChange={(event) => {
                    const nextFile = event.target.files?.[0] || null;
                    setSelectedFile(nextFile);
                    setClientError(null);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Up to 500 MB per asset.
                </p>
              </div>

              {selectedFile ? (
                <div className="rounded-lg border border-border/70 bg-background/50 p-3 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">
                    {createTitleFromFilename(selectedFile.name)}
                  </p>
                  <p className="mt-1">
                    {selectedFile.name} • {formatBytes(selectedFile.size)}
                  </p>
                </div>
              ) : null}

              {isUploading ? (
                <div className="rounded-lg border border-border/70 bg-background/50 p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-foreground">Uploading…</span>
                    <span className="text-muted-foreground">{uploadPercent}%</span>
                  </div>
                  <div className="mt-3 h-2 rounded-full bg-muted">
                    <div
                      className="h-2 rounded-full bg-primary transition-[width]"
                      style={{ width: `${uploadPercent}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {formatUploadEta(uploadEtaSeconds)}
                  </p>
                </div>
              ) : null}

              {clientError ? <FormMessage tone="error">{clientError}</FormMessage> : null}
              {error ? (
                <FormMessage tone="error">
                  Unable to load reusable assets right now.
                </FormMessage>
              ) : null}

              <Button type="submit" disabled={isUploading}>
                {isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                Upload asset
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Library</CardTitle>
            <CardDescription>
              Browse and manage reusable files by type.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {filters.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setFilter(item.value)}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm',
                    filter === item.value
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/70 bg-background text-muted-foreground'
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {filteredAssets.length === 0 ? (
              <EmptyState
                title="No assets yet"
                description="Upload reusable files here to build your asset library."
              />
            ) : (
              <div className="space-y-3">
                {filteredAssets.map((asset) => {
                  const AssetIcon = getAssetKindIcon(asset.kind);

                  return (
                    <div
                      key={asset.id}
                      className="rounded-xl border border-border/70 bg-background/40 p-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 gap-3">
                          <div className="rounded-lg bg-secondary/20 p-2 text-primary">
                            <AssetIcon className="h-5 w-5" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">
                              {asset.title}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {getAssetKindLabel(asset.kind)} • {asset.originalFilename} •{' '}
                              {formatBytes(asset.fileSizeBytes)}
                            </p>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={deletingAssetId === asset.id}
                          onClick={() => handleDelete(asset.id)}
                          aria-label="Delete asset"
                        >
                          {deletingAssetId === asset.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </div>

                      {asset.kind === ReusableAssetKind.IMAGE ? (
                        <img
                          src={`/api/reusable-assets/${asset.id}/file`}
                          alt={asset.title}
                          className="mt-4 max-h-56 rounded-lg border border-border/70 object-contain"
                        />
                      ) : asset.kind === ReusableAssetKind.VIDEO ? (
                        <video
                          className="mt-4 max-h-56 w-full rounded-lg border border-border/70"
                          controls
                          preload="metadata"
                          src={`/api/reusable-assets/${asset.id}/file`}
                        />
                      ) : asset.kind === ReusableAssetKind.AUDIO ? (
                        <audio
                          className="mt-4 w-full"
                          controls
                          preload="metadata"
                          src={`/api/reusable-assets/${asset.id}/file`}
                        />
                      ) : null}

                      <div className="mt-4 flex gap-2">
                        <Button asChild variant="outline" size="sm">
                          <a href={`/api/reusable-assets/${asset.id}/file?download=1`}>
                            Download
                          </a>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardPageShell>
  );
}
