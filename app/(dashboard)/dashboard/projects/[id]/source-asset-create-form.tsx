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
import {
  readJsonResponse,
  uploadSourceAssetViaServer,
  uploadToStorageWithProgress
} from '../../upload-client';

type CreateSourceAssetState = {
  error?: string;
  success?: string;
};

const assetTypeOptions = [
  {
    value: SourceAssetType.UPLOADED_FILE,
    label: 'Upload video',
    description: 'Upload the recording that should become clips. Audio files remain supported.'
  },
  {
    value: SourceAssetType.YOUTUBE_URL,
    label: 'YouTube URL',
    description: 'Import a YouTube video for transcript ingestion and clip generation.'
  },
  {
    value: SourceAssetType.PASTED_TRANSCRIPT,
    label: 'Pasted transcript',
    description: 'Use transcript text when the source video is not available.'
  }
] as const;

function getUploadHelpText() {
  return `${SOURCE_ASSET_ALLOWED_FORMAT_LABEL} up to 500 MB.`;
}

export function SourceAssetCreateForm({
  projectId,
  variant = 'default'
}: {
  projectId: number;
  variant?: 'default' | 'editor';
}) {
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
  const [uploadPercent, setUploadPercent] = useState(0);
  const [state, formAction, isPending] = useActionState<
    CreateSourceAssetState,
    FormData
  >(createSourceAsset, {});

  const isFileUpload = assetType === SourceAssetType.UPLOADED_FILE;
  const isSubmitting = isFileUpload ? isUploading : isPending;
  const isEditor = variant === 'editor';
  const editorInputClass = isEditor
    ? 'border-slate-200 bg-white text-slate-950 shadow-none placeholder:text-slate-400'
    : undefined;
  const editorLabelClass = isEditor ? 'text-slate-700' : undefined;

  useEffect(() => {
    if (!state.success) {
      return;
    }

    const toastKey = `success:${state.success}`;

    if (lastToastKeyRef.current !== toastKey) {
      toast({
        title: 'Upload added',
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
        title: 'Unable to add upload',
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
      setClientError('Select a video or audio file to upload.');
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

      await uploadToStorageWithProgress({
        uploadUrl: initiatedUpload.uploadUrl,
        method: initiatedUpload.method,
        headers: initiatedUpload.headers,
        file,
        onProgress: (progress) => setUploadPercent(progress.percent)
      });

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
    setClientSuccess('Video uploaded successfully.');
    setUploadPercent(0);
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
        title: isFileUpload ? 'Upload failed' : 'Unable to add upload',
        description: clientError,
        variant: 'destructive',
      });
      lastToastKeyRef.current = toastKey;
    }
  }, [clientError, isFileUpload, toast]);

  return (
    <Card
      className={
        isEditor
          ? 'gap-4 rounded-2xl border-slate-200 bg-white py-4 text-slate-950 shadow-none'
          : undefined
      }
    >
      <CardHeader>
        <CardTitle className={isEditor ? 'text-slate-950' : undefined}>
          Upload video
        </CardTitle>
        <CardDescription className={isEditor ? 'text-slate-500' : undefined}>
          Add the recording, YouTube link, or transcript that should drive this
          workspace.
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
            <Label className={`mb-3 ${editorLabelClass || ''}`}>
              Input
            </Label>
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
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                    isEditor
                      ? 'border-slate-200 bg-slate-50 text-slate-950 hover:border-cyan-300'
                      : 'border-border/70 bg-surface-1/80 hover:border-primary/35'
                  }`}
                >
                  <RadioGroupItem value={option.value} id={option.value} />
                  <div>
                    <p
                      className={`text-sm font-medium ${
                        isEditor ? 'text-slate-950' : 'text-foreground'
                      }`}
                    >
                      {option.label}
                    </p>
                    <p
                      className={`text-sm ${
                        isEditor ? 'text-slate-500' : 'text-muted-foreground'
                      }`}
                    >
                      {option.description}
                    </p>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>

          <div>
            <Label htmlFor="title" className={`mb-2 ${editorLabelClass || ''}`}>
              Title
            </Label>
            <Input
              id="title"
              name="title"
              placeholder="title"
              maxLength={150}
              required={!isFileUpload}
              value={title}
              className={editorInputClass}
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
                <Label
                  htmlFor="file"
                  className={`mb-2 ${editorLabelClass || ''}`}
                >
                  Video or audio file
                </Label>
                <Input
                  ref={fileInputRef}
                  id="file"
                  name="file"
                  type="file"
                  accept={SOURCE_ASSET_UPLOAD_ACCEPT_ATTRIBUTE}
                  required
                  className={editorInputClass}
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
                <p
                  className={`mt-2 text-sm ${
                    isEditor ? 'text-slate-500' : 'text-muted-foreground'
                  }`}
                >
                  {getUploadHelpText()}
                </p>
              </div>

              {selectedFile ? (
                <p
                  className={`text-sm ${
                    isEditor ? 'text-slate-500' : 'text-muted-foreground'
                  }`}
                >
                  {selectedFile.name} • {selectedFile.type || 'Unknown type'} •{' '}
                  {Math.ceil(selectedFile.size / (1024 * 1024))} MB
                </p>
              ) : null}
            </>
          ) : null}

          {assetType === SourceAssetType.YOUTUBE_URL ? (
            <div>
              <Label
                htmlFor="sourceUrl"
                className={`mb-2 ${editorLabelClass || ''}`}
              >
                YouTube URL
              </Label>
              <Input
                id="sourceUrl"
                name="sourceUrl"
                type="url"
                placeholder="youtube url"
                maxLength={5000}
                required
                className={editorInputClass}
              />
            </div>
          ) : null}

          {assetType === SourceAssetType.PASTED_TRANSCRIPT ? (
            <>
              <div>
                <Label
                  htmlFor="transcriptLanguage"
                  className={`mb-2 ${editorLabelClass || ''}`}
                >
                  Transcript Language
                </Label>
                <Input
                  id="transcriptLanguage"
                  name="transcriptLanguage"
                  placeholder="transcript language"
                  maxLength={20}
                  className={editorInputClass}
                />
              </div>

              <div>
                <Label
                  htmlFor="transcriptContent"
                  className={`mb-2 ${editorLabelClass || ''}`}
                >
                  Transcript Text
                </Label>
                <Textarea
                  id="transcriptContent"
                  name="transcriptContent"
                  rows={8}
                  maxLength={20000}
                  required
                  className={`min-h-40 ${editorInputClass || ''}`}
                />
              </div>
            </>
          ) : null}

          <Button
            type="submit"
            disabled={isSubmitting}
            className={
              isEditor
                ? 'bg-slate-950 text-white shadow-none hover:bg-slate-800'
                : undefined
            }
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isFileUpload ? 'Uploading...' : 'Saving...'}
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                {isFileUpload ? 'Upload video' : 'Add upload'}
              </>
            )}
          </Button>
          {isUploading ? (
            <div className="h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-cyan-500 transition-all"
                style={{ width: `${uploadPercent}%` }}
              />
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
