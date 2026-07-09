'use client';

import { type FormEvent, useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Play, Upload, X } from 'lucide-react';
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
import { uploadSourceAssetThumbnail } from '@/lib/disburse/video-thumbnail-client';
import { TRANSCRIPT_TRACKING_REFRESH_EVENT } from '@/components/dashboard/transcript-toast-watcher';
import {
  createSourceAssetTitleFromFilename,
  MAX_SOURCE_ASSET_FILE_SIZE_BYTES,
  SOURCE_ASSET_ALLOWED_FORMAT_LABEL,
  SOURCE_ASSET_UPLOAD_ACCEPT_ATTRIBUTE,
  isSupportedSourceAssetUpload
} from '@/lib/disburse/source-asset-upload-config';
import {
  clearSourceUploadLocalRecord,
  discardSourceUpload,
  fileMatchesSourceUploadRecord,
  getSourceUploadLocalRecordForFile,
  getSourceUploadLocalRecords,
  isUploadInterruptedError,
  isUploadPausedError,
  saveSourceUploadLocalRecord,
  uploadSourceAssetMultipart,
  type SourceUploadLocalRecord,
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
  const abortControllerRef = useRef<AbortController | null>(null);
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
  const [resumableUpload, setResumableUpload] =
    useState<SourceUploadLocalRecord | null>(null);
  const [state, formAction, isPending] = useActionState<
    CreateSourceAssetState,
    FormData
  >(createSourceAsset, {});

  const isFileUpload = assetType === SourceAssetType.UPLOADED_FILE;
  const isSubmitting = isFileUpload ? isUploading : isPending;
  const selectedFileMatchesResumableUpload =
    Boolean(selectedFile && resumableUpload) &&
    fileMatchesSourceUploadRecord(selectedFile!, resumableUpload!);
  const isEditor = variant === 'editor';
  const editorInputClass = isEditor
    ? 'border-slate-200 bg-white text-slate-950 shadow-none placeholder:text-slate-400'
    : undefined;
  const editorLabelClass = isEditor ? 'text-slate-700' : undefined;
  const inlineUploadError =
    isFileUpload &&
    ((clientError === 'Upload failed.' && selectedFile) ||
      (resumableUpload?.status === 'failed' && resumableUpload))
      ? 'Upload failed.'
      : null;
  const formError =
    clientError && clientError !== inlineUploadError
      ? clientError
      : state.error || null;

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

  useEffect(() => {
    const [record] = getSourceUploadLocalRecords(projectId).filter(
      (candidate) =>
        candidate.status === 'uploading' ||
        candidate.status === 'paused' ||
        candidate.status === 'failed'
    );

    if (!record) {
      return;
    }

    const restoredRecord = {
      ...record,
      status: record.status === 'uploading' ? 'paused' : record.status,
    } as SourceUploadLocalRecord;

    if (restoredRecord.status !== record.status) {
      saveSourceUploadLocalRecord(restoredRecord);
    }

    setResumableUpload(restoredRecord);
    setUploadPercent(restoredRecord.percent);
    setTitle(restoredRecord.title);
    setHasEditedTitle(true);
    setClientError('Choose the same local file to resume this upload.');
  }, [projectId]);

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
      setClientError(
        resumableUpload
          ? 'Choose the same local file to resume this upload.'
          : 'Select a video or audio file to upload.'
      );
      return;
    }

    if (
      resumableUpload &&
      !fileMatchesSourceUploadRecord(file, resumableUpload)
    ) {
      setClientError('Cancel the saved upload before choosing a different file.');
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
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const uploadResult = await uploadSourceAssetMultipart({
        file,
        projectId,
        title: normalizedTitle,
        localRecord: resumableUpload,
        signal: abortController.signal,
        onProgress: (progress) => setUploadPercent(progress.percent)
      });

      const sourceAssetId = uploadResult?.sourceAsset?.id;

      if (typeof sourceAssetId === 'number') {
        await uploadSourceAssetThumbnail({
          sourceAssetId,
          file,
        }).catch((thumbnailError) => {
          console.warn('Setup thumbnail upload failed.', thumbnailError);
        });
      }
    } catch (error) {
      if (isUploadPausedError(error) || isUploadInterruptedError(error)) {
        const record = getSourceUploadLocalRecordForFile(projectId, file);

        if (record) {
          setResumableUpload(record);
          setUploadPercent(record.percent);
        }

        if (isUploadInterruptedError(error)) {
          setClientError('Upload failed.');
        } else {
          setClientError(null);
        }
        setClientSuccess(null);
        return;
      }

      console.error('Source asset upload failed.', error);
      setClientError('Upload failed.');
      return;
    } finally {
      abortControllerRef.current = null;
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
    setResumableUpload(null);
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

  function handlePauseUpload() {
    if (resumableUpload) {
      const pausedRecord: SourceUploadLocalRecord = {
        ...resumableUpload,
        percent: uploadPercent,
        status: 'paused',
        updatedAt: new Date().toISOString(),
      };
      saveSourceUploadLocalRecord(pausedRecord);
      setResumableUpload(pausedRecord);
    }

    abortControllerRef.current?.abort();
  }

  async function handleDiscardUpload() {
    if (!resumableUpload) {
      return;
    }

    try {
      await discardSourceUpload(resumableUpload);
      clearSourceUploadLocalRecord(resumableUpload);
      setResumableUpload(null);
      setUploadPercent(0);
      setClientError(null);
      setClientSuccess(null);
      setSelectedFile(null);

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error) {
      setClientError(
        error instanceof Error ? error.message : 'Unable to discard upload.'
      );
    }
  }

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
                  required={!resumableUpload}
                  className={editorInputClass}
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    setSelectedFile(file);
                    setClientError(null);
                    setClientSuccess(null);

                    if (file) {
                      const matchingRecord = getSourceUploadLocalRecordForFile(
                        projectId,
                        file
                      );

                      if (matchingRecord) {
                        setResumableUpload(matchingRecord);
                        setUploadPercent(matchingRecord.percent);
                        setTitle(matchingRecord.title);
                        setHasEditedTitle(true);
                        return;
                      }

                      if (
                        resumableUpload &&
                        !fileMatchesSourceUploadRecord(file, resumableUpload)
                      ) {
                        setClientError(
                          'Cancel the saved upload before choosing a different file.'
                        );
                      }
                    }

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
                <div>
                  <p
                    className={`text-sm ${
                      isEditor ? 'text-slate-500' : 'text-muted-foreground'
                    }`}
                  >
                    {selectedFile.name} • {selectedFile.type || 'Unknown type'} •{' '}
                    {Math.ceil(selectedFile.size / (1024 * 1024))} MB
                  </p>
                  {!resumableUpload && inlineUploadError ? (
                    <p className="mt-1 text-sm text-danger">{inlineUploadError}</p>
                  ) : null}
                </div>
              ) : null}

              {resumableUpload ? (
                <div
                  className={`rounded-lg border p-3 text-sm ${
                    isEditor
                      ? 'border-slate-200 bg-slate-50 text-slate-600'
                      : 'border-border/70 bg-surface-1/70 text-muted-foreground'
                  }`}
                >
                  <p className={isEditor ? 'text-slate-700' : 'text-foreground'}>
                    {resumableUpload.status === 'paused'
                      ? 'Upload canceled'
                      : resumableUpload.status === 'failed'
                        ? 'Upload needs attention'
                        : 'Upload in progress'}
                  </p>
                  <p className="mt-1">
                    {resumableUpload.filename} • {resumableUpload.percent}% saved
                  </p>
                  {inlineUploadError ? (
                    <p className="mt-1 text-danger">{inlineUploadError}</p>
                  ) : null}
                  {!selectedFileMatchesResumableUpload ? (
                    <p className="mt-1">
                      Choose the same local file to resume from the saved parts.
                    </p>
                  ) : null}
                </div>
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

          {formError ? <p className="text-sm text-danger">{formError}</p> : null}

          <div className="flex flex-wrap gap-2">
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
              ) : resumableUpload && isFileUpload ? (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  {selectedFileMatchesResumableUpload
                    ? 'Resume upload'
                    : 'Choose same file'}
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  {isFileUpload ? 'Upload video' : 'Add upload'}
                </>
              )}
            </Button>
            {isUploading ? (
              <Button
                type="button"
                variant="outline"
                onClick={handlePauseUpload}
              >
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            ) : null}
            {resumableUpload && !isUploading ? (
              <Button
                type="button"
                variant="outline"
                onClick={handleDiscardUpload}
              >
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            ) : null}
          </div>
          {isUploading || resumableUpload ? (
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
