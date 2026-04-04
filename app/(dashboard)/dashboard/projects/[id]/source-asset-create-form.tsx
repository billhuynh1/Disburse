'use client';

import { type FormEvent, useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { successToastIcon } from '@/components/ui/toaster';
import { useToast } from '@/hooks/use-toast';
import { createSourceAsset } from '@/lib/disburse/actions';
import { SourceAssetType } from '@/lib/db/schema';
import { TRANSCRIPT_TRACKING_REFRESH_EVENT } from '@/components/dashboard/transcript-toast-watcher';
import {
  createSourceAssetTitleFromFilename,
  MAX_SOURCE_ASSET_FILE_SIZE_BYTES,
  SOURCE_ASSET_ALLOWED_FORMAT_LABEL,
  SOURCE_ASSET_UPLOAD_ACCEPT_ATTRIBUTE,
  isSupportedSourceAssetUpload
} from '@/lib/disburse/source-asset-upload-config';

type CreateSourceAssetState = {
  error?: string;
  success?: string;
};

const assetTypeOptions = [
  {
    value: SourceAssetType.UPLOADED_FILE,
    label: 'Upload audio or video',
    description: 'Upload a source media file directly to storage and attach it to this project.'
  },
  {
    value: SourceAssetType.YOUTUBE_URL,
    label: 'YouTube URL',
    description: 'Store a YouTube link now for future ingestion and processing.'
  },
  {
    value: SourceAssetType.PASTED_TRANSCRIPT,
    label: 'Pasted transcript',
    description: 'Save transcript text now and mark it ready immediately.'
  }
] as const;

function getUploadHelpText() {
  return `${SOURCE_ASSET_ALLOWED_FORMAT_LABEL} up to 500 MB.`;
}

async function readJsonResponse(response: Response) {
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error || 'Request failed.');
  }

  return body;
}

async function uploadSourceAssetViaServer(params: {
  file: File;
  projectId: number;
  title: string;
}) {
  const formData = new FormData();
  formData.append('projectId', String(params.projectId));
  formData.append('title', params.title);
  formData.append('file', params.file);

  return await readJsonResponse(
    await fetch('/api/source-assets/uploads/file', {
      method: 'POST',
      body: formData,
    })
  );
}

export function SourceAssetCreateForm({ projectId }: { projectId: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastToastKeyRef = useRef<string | null>(null);
  const [assetType, setAssetType] = useState<
    SourceAssetType.UPLOADED_FILE |
      SourceAssetType.YOUTUBE_URL |
      SourceAssetType.PASTED_TRANSCRIPT
  >(SourceAssetType.UPLOADED_FILE);
  const [title, setTitle] = useState('');
  const [hasEditedTitle, setHasEditedTitle] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [clientSuccess, setClientSuccess] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [state, formAction, isPending] = useActionState<
    CreateSourceAssetState,
    FormData
  >(createSourceAsset, {});

  const isFileUpload = assetType === SourceAssetType.UPLOADED_FILE;
  const isSubmitting = isFileUpload ? isUploading : isPending;

  useEffect(() => {
    if (!state.success) {
      return;
    }

    const toastKey = `success:${state.success}`;

    if (lastToastKeyRef.current !== toastKey) {
      toast({
        title: 'Source asset added',
        description: state.success,
        icon: successToastIcon,
      });
      lastToastKeyRef.current = toastKey;
    }

    formRef.current?.reset();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setAssetType(SourceAssetType.UPLOADED_FILE);
    setTitle('');
    setHasEditedTitle(false);
    setSelectedFile(null);
    setClientError(null);
    setClientSuccess(null);
    router.refresh();
  }, [router, state.success, toast]);

  useEffect(() => {
    if (!state.error) {
      return;
    }

    const toastKey = `error:${state.error}`;

    if (lastToastKeyRef.current !== toastKey) {
      toast({
        title: 'Unable to add source asset',
        description: state.error,
        variant: 'destructive',
      });
      lastToastKeyRef.current = toastKey;
    }
  }, [state.error, toast]);

  async function handleUploadSubmit(event: FormEvent<HTMLFormElement>) {
    if (!isFileUpload) {
      return;
    }

    event.preventDefault();
    setClientError(null);
    setClientSuccess(null);

    const file = selectedFile;
    const normalizedTitle = title.trim();

    if (!file) {
      setClientError('Select an audio or video file to upload.');
      return;
    }

    if (!normalizedTitle) {
      setClientError('Title is required.');
      return;
    }

    if (!isSupportedSourceAssetUpload(file.name, file.type)) {
      setClientError(
        `Unsupported file type. Upload ${SOURCE_ASSET_ALLOWED_FORMAT_LABEL}.`
      );
      return;
    }

    if (file.size > MAX_SOURCE_ASSET_FILE_SIZE_BYTES) {
      setClientError('File exceeds the 500 MB upload limit.');
      return;
    }

    try {
      setIsUploading(true);

      const initiatedUpload = await readJsonResponse(
        await fetch('/api/source-assets/uploads/initiate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            projectId,
            filename: file.name,
            mimeType: file.type,
            fileSizeBytes: file.size
          })
        })
      );

      const storageResponse = await fetch(initiatedUpload.uploadUrl, {
        method: initiatedUpload.method,
        headers: initiatedUpload.headers,
        body: file
      });

      if (!storageResponse.ok) {
        throw new Error('File upload failed before it could be attached.');
      }

      await readJsonResponse(
        await fetch('/api/source-assets/uploads/complete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            uploadToken: initiatedUpload.uploadToken,
            title: normalizedTitle
          })
        })
      );
    } catch (error) {
      const shouldRetryViaServer =
        error instanceof TypeError ||
        (error instanceof Error &&
          error.message.toLowerCase().includes('failed to fetch'));

      if (!shouldRetryViaServer) {
        const message = error instanceof Error ? error.message : 'Upload failed.';
        setClientError(message);
        return;
      }

      try {
        await uploadSourceAssetViaServer({
          file,
          projectId,
          title: normalizedTitle
        });
      } catch (fallbackError) {
        const message =
          fallbackError instanceof Error ? fallbackError.message : 'Upload failed.';
        setClientError(message);
        return;
      }
    } finally {
      setIsUploading(false);
    }

    formRef.current?.reset();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setAssetType(SourceAssetType.UPLOADED_FILE);
    setTitle('');
    setHasEditedTitle(false);
    setSelectedFile(null);
    setClientSuccess('Source asset uploaded successfully.');
    window.dispatchEvent(new Event(TRANSCRIPT_TRACKING_REFRESH_EVENT));
    router.refresh();
  }

  useEffect(() => {
    if (!clientSuccess) {
      return;
    }

    const toastKey = `success:${clientSuccess}`;

    if (lastToastKeyRef.current !== toastKey) {
      toast({
        title: 'Upload complete',
        description: clientSuccess,
        icon: successToastIcon,
      });
      lastToastKeyRef.current = toastKey;
    }
  }, [clientSuccess, toast]);

  useEffect(() => {
    if (!clientError) {
      return;
    }

    const toastKey = `error:${clientError}`;

    if (lastToastKeyRef.current !== toastKey) {
      toast({
        title: isFileUpload ? 'Upload failed' : 'Unable to add source asset',
        description: clientError,
        variant: 'destructive',
      });
      lastToastKeyRef.current = toastKey;
    }
  }, [clientError, isFileUpload, toast]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Source Asset</CardTitle>
        <CardDescription>
          Upload source media or attach an alternate input to this project.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          action={formAction}
          onSubmit={handleUploadSubmit}
          className="space-y-5"
        >
          <input type="hidden" name="projectId" value={projectId} />

          <div>
            <Label className="mb-3">Source Type</Label>
            <RadioGroup
              name="assetType"
              value={assetType}
              onValueChange={(value) =>
                setAssetType(
                  value as
                    | SourceAssetType.UPLOADED_FILE
                    | SourceAssetType.YOUTUBE_URL
                    | SourceAssetType.PASTED_TRANSCRIPT
                )
              }
              className="space-y-3"
            >
              {assetTypeOptions.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-surface-1 p-3 transition-colors hover:border-primary/35"
                >
                  <RadioGroupItem value={option.value} id={option.value} />
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {option.label}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {option.description}
                    </p>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>

          <div>
            <Label htmlFor="title" className="mb-2">
              Title
            </Label>
            <Input
              id="title"
              name="title"
              placeholder="title"
              maxLength={150}
              required={!isFileUpload}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setHasEditedTitle(true);
                setClientError(null);
                setClientSuccess(null);
              }}
            />
          </div>

          {assetType === SourceAssetType.UPLOADED_FILE ? (
            <>
              <div>
                <Label htmlFor="file" className="mb-2">
                  Media File
                </Label>
                <Input
                  ref={fileInputRef}
                  id="file"
                  name="file"
                  type="file"
                  accept={SOURCE_ASSET_UPLOAD_ACCEPT_ATTRIBUTE}
                  required
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    setSelectedFile(file);
                    setClientError(null);
                    setClientSuccess(null);

                    if (file && (!hasEditedTitle || !title.trim())) {
                      setTitle(createSourceAssetTitleFromFilename(file.name));
                    }
                  }}
                />
                <p className="mt-2 text-sm text-muted-foreground">
                  {getUploadHelpText()}
                </p>
              </div>

              {selectedFile ? (
                <p className="text-sm text-muted-foreground">
                  {selectedFile.name} • {selectedFile.type || 'Unknown type'} •{' '}
                  {Math.ceil(selectedFile.size / (1024 * 1024))} MB
                </p>
              ) : null}
            </>
          ) : null}

          {assetType === SourceAssetType.YOUTUBE_URL ? (
            <div>
              <Label htmlFor="sourceUrl" className="mb-2">
                YouTube URL
              </Label>
              <Input
                id="sourceUrl"
                name="sourceUrl"
                type="url"
                placeholder="youtube url"
                maxLength={5000}
                required
              />
            </div>
          ) : null}

          {assetType === SourceAssetType.PASTED_TRANSCRIPT ? (
            <>
              <div>
                <Label htmlFor="transcriptLanguage" className="mb-2">
                  Transcript Language
                </Label>
                <Input
                  id="transcriptLanguage"
                  name="transcriptLanguage"
                  placeholder="transcript language"
                  maxLength={20}
                />
              </div>

              <div>
                <Label htmlFor="transcriptContent" className="mb-2">
                  Transcript Text
                </Label>
                <Textarea
                  id="transcriptContent"
                  name="transcriptContent"
                  rows={8}
                  maxLength={20000}
                  required
                  className="min-h-40"
                />
              </div>
            </>
          ) : null}

          <Button
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isFileUpload ? 'Uploading...' : 'Saving...'}
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                {isFileUpload ? 'Upload Source Asset' : 'Add Source Asset'}
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
