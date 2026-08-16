import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidates,
  clipPublications,
  ClipPublicationStatus,
  linkedAccounts,
  renderedClips,
  RenderedClipStatus,
  type ClipPublication,
  type LinkedAccount,
} from '@/lib/db/schema';
import {
  createPresignedDownload,
} from '@/lib/disburse/s3-storage';
import { isMediaUnavailable } from '@/lib/disburse/media-retention-service';
import {
  formatPlatformLabel,
  getLinkedAccountPublishBlockedReason,
  isSupportedPublishPlatform,
  type SupportedPublishPlatform,
} from '@/lib/disburse/linked-account-service';
import {
  createClipPublicationFailedNotification,
  createClipPublicationPublishedNotification,
} from '@/lib/disburse/notification-service';
import {
  assertJobExecutionAuthorized,
  type JobExecutionAuthority,
  withAuthorizedJobTransaction,
} from '@/lib/disburse/job-execution-authorization';
import { getJobOperationSignal } from '@/lib/disburse/pipeline-operation-deadline';
import { assertDirectPublishingProhibited } from '@/lib/disburse/publishing-prohibition';
import { classifyShortFormGenerationMode } from '@/lib/disburse/short-form-generation-mode-service';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DbTransaction;

function normalizeFailureReason(reason: string) {
  const normalized = reason.trim();
  return normalized.length > 0
    ? normalized.slice(0, 5000)
    : 'Clip publishing failed.';
}

function getRequiredEnvVar(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} environment variable is not set.`);
  }

  return value;
}

function buildPublicationTitle(params: {
  renderedClipTitle: string;
  clipCandidateTitle?: string | null;
}) {
  const title =
    params.renderedClipTitle.trim() ||
    params.clipCandidateTitle?.trim() ||
    'Short-form clip';

  return title.slice(0, 100);
}

function buildPublicationDescription(params: {
  clipCandidateCaptionCopy?: string | null;
  clipCandidateSummary?: string | null;
}) {
  const parts = [
    params.clipCandidateCaptionCopy?.trim(),
    params.clipCandidateSummary?.trim(),
  ].filter(Boolean);

  return parts.join('\n\n').slice(0, 5000);
}

async function getRenderableClipForPublication(
  renderedClipId: number,
  userId: number
) {
  return await db.query.renderedClips.findFirst({
    where: and(
      eq(renderedClips.id, renderedClipId),
      eq(renderedClips.userId, userId)
    ),
    with: {
      clipCandidate: true,
      contentPack: true,
      clipPublications: true,
    },
  });
}

export async function assertRenderedClipPublicationAuthority(params: {
  renderedClipId: number;
  userId: number;
}) {
  const renderedClip = await getRenderableClipForPublication(
    params.renderedClipId,
    params.userId
  );
  if (!renderedClip) {
    throw new Error('Rendered clip not found.');
  }

  const mode = await classifyShortFormGenerationMode({
    generationRunId: renderedClip.generationRunId,
    contentPackId: renderedClip.contentPackId,
  });
  if (mode.kind === 'invalid_snapshot_reference') {
    throw new Error(mode.code);
  }
  if (
    mode.kind === 'snapshot' &&
    (
      renderedClip.clipCandidate.currentRenderConfigId === null ||
      renderedClip.clipCandidate.currentRenderConfigId !== renderedClip.clipRenderConfigId
    )
  ) {
    throw new Error('Rendered clip is not the current snapshot output.');
  }

  return renderedClip;
}

export async function getPublishableLinkedAccountForUser(params: {
  userId: number;
  platform: SupportedPublishPlatform;
}) {
  const account = await db.query.linkedAccounts.findFirst({
    where: and(
      eq(linkedAccounts.userId, params.userId),
      eq(linkedAccounts.platform, params.platform)
    ),
    orderBy: (table, { desc }) => [desc(table.updatedAt)],
  });

  if (!account) {
    throw new Error(`Connect a ${formatPlatformLabel(params.platform)} account before publishing.`);
  }

  const blockedReason = getLinkedAccountPublishBlockedReason(account);

  if (blockedReason) {
    throw new Error(blockedReason);
  }

  return account;
}

export async function ensureClipPublicationPending(params: {
  renderedClipId: number;
  linkedAccountId: number;
  platform: SupportedPublishPlatform;
  userId: number;
}) {
  const existingPublication = await db.query.clipPublications.findFirst({
    where: and(
      eq(clipPublications.renderedClipId, params.renderedClipId),
      eq(clipPublications.linkedAccountId, params.linkedAccountId)
    ),
  });

  if (existingPublication?.status === ClipPublicationStatus.PUBLISHED) {
    return {
      publication: existingPublication,
      status: 'already_published' as const,
    };
  }

  if (
    existingPublication?.status === ClipPublicationStatus.PENDING ||
    existingPublication?.status === ClipPublicationStatus.PUBLISHING
  ) {
    return {
      publication: existingPublication,
      status: 'already_pending' as const,
    };
  }

  if (existingPublication) {
    const [updatedPublication] = await db
      .update(clipPublications)
      .set({
        status: ClipPublicationStatus.PENDING,
        failureReason: null,
        platformPostId: null,
        platformUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(clipPublications.id, existingPublication.id))
      .returning();

    return {
      publication: updatedPublication,
      status: 'requeued' as const,
    };
  }

  const [publication] = await db
    .insert(clipPublications)
    .values({
      userId: params.userId,
      renderedClipId: params.renderedClipId,
      linkedAccountId: params.linkedAccountId,
      platform: params.platform,
      status: ClipPublicationStatus.PENDING,
    })
    .returning();

  return {
    publication,
    status: 'created' as const,
  };
}

export async function prepareRenderedClipPublication(params: {
  projectId: number;
  renderedClipId: number;
  platform: string;
  userId: number;
}) {
  if (!isSupportedPublishPlatform(params.platform)) {
    throw new Error('This publishing platform is not supported.');
  }

  const renderedClip = await assertRenderedClipPublicationAuthority({
    renderedClipId: params.renderedClipId,
    userId: params.userId,
  });

  if (renderedClip.status !== RenderedClipStatus.READY) {
    throw new Error('Rendered clip is not ready to publish yet.');
  }

  if (renderedClip.contentPack.projectId !== params.projectId) {
    throw new Error('Rendered clip not found for this project.');
  }

  if (isMediaUnavailable(renderedClip)) {
    throw new Error('Rendered clip media expired and is no longer available.');
  }

  const account = await getPublishableLinkedAccountForUser({
    userId: params.userId,
    platform: params.platform,
  });

  const publicationResult = await ensureClipPublicationPending({
    renderedClipId: renderedClip.id,
    linkedAccountId: account.id,
    platform: params.platform,
    userId: params.userId,
  });

  return {
    renderedClip,
    account,
    publication: publicationResult.publication,
    publicationStatus: publicationResult.status,
  };
}

async function markClipPublicationPublishing(
  clipPublicationId: number,
  executor: DbLike = db
) {
  const [publication] = await executor
    .update(clipPublications)
    .set({
      status: ClipPublicationStatus.PUBLISHING,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(clipPublications.id, clipPublicationId))
    .returning();

  return publication;
}

export async function markClipPublicationFailed(
  clipPublicationId: number,
  reason: string,
  executor: DbLike = db
) {
  const [publication] = await executor
    .update(clipPublications)
    .set({
      status: ClipPublicationStatus.FAILED,
      failureReason: normalizeFailureReason(reason),
      updatedAt: new Date(),
    })
    .where(eq(clipPublications.id, clipPublicationId))
    .returning();

  if (publication) {
    await createClipPublicationFailedNotification(publication.id, executor);
  }

  return publication;
}

export async function markClipPublicationPublished(params: {
  clipPublicationId: number;
  platformPostId: string;
  platformUrl: string | null;
}, executor: DbLike = db) {
  const [publication] = await executor
    .update(clipPublications)
    .set({
      status: ClipPublicationStatus.PUBLISHED,
      failureReason: null,
      platformPostId: params.platformPostId,
      platformUrl: params.platformUrl,
      updatedAt: new Date(),
    })
    .where(eq(clipPublications.id, params.clipPublicationId))
    .returning();

  if (publication) {
    await createClipPublicationPublishedNotification(publication.id, executor);
  }

  return publication;
}

export async function downloadRenderedClipFile(storageKey: string, signal?: AbortSignal) {
  const download = createPresignedDownload({
    storageKey,
    expiresInSeconds: 3600,
  });
  const response = await fetch(download.downloadUrl, {
    method: download.method,
    signal,
  });

  if (!response.ok) {
    throw new Error(`Storage download failed with status ${response.status}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function startYoutubeResumableUpload(params: {
  accessToken: string;
  mimeType: string;
  fileSizeBytes: number;
  title: string;
  description: string;
  signal?: AbortSignal;
}) {
  assertDirectPublishingProhibited();
  const response = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(params.fileSizeBytes),
        'X-Upload-Content-Type': params.mimeType,
      },
      body: JSON.stringify({
        snippet: {
          title: params.title,
          description: params.description,
          categoryId: '22',
        },
        status: {
          privacyStatus: 'private',
        },
      }),
      signal: params.signal,
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `YouTube upload session failed with status ${response.status}: ${body || 'Unknown error.'}`
    );
  }

  const uploadUrl = response.headers.get('location');

  if (!uploadUrl) {
    throw new Error('YouTube upload session did not return an upload URL.');
  }

  return uploadUrl;
}

export async function uploadVideoToYoutube(params: {
  accessToken: string;
  uploadUrl: string;
  mimeType: string;
  body: Buffer;
  signal?: AbortSignal;
}) {
  assertDirectPublishingProhibited();
  const response = await fetch(params.uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': params.mimeType,
      'Content-Length': String(params.body.byteLength),
    },
    body: params.body,
    signal: params.signal,
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `YouTube upload failed with status ${response.status}.`
    );
  }

  const videoId =
    typeof body?.id === 'string' && body.id.trim().length > 0 ? body.id.trim() : null;

  if (!videoId) {
    throw new Error('YouTube upload completed without a video id.');
  }

  return {
    platformPostId: videoId,
    platformUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

async function publishRenderedClipToYoutube(params: {
  publication: ClipPublication;
  account: LinkedAccount;
  renderedClip: {
    title: string;
    mimeType: string | null;
    storageKey: string | null;
    clipCandidate: {
      title: string;
      captionCopy: string;
      summary: string;
    };
  };
  authority: JobExecutionAuthority;
}) {
  const renderedClip = params.renderedClip;
  const operationSignal = getJobOperationSignal(params.authority);

  if (!renderedClip?.storageKey) {
    throw new Error('Rendered clip storage metadata is missing.');
  }

  const mimeType = renderedClip.mimeType || 'video/mp4';
  await assertJobExecutionAuthorized(params.authority);
  const videoBody = await downloadRenderedClipFile(
    renderedClip.storageKey,
    operationSignal
  );
  const title = buildPublicationTitle({
    renderedClipTitle: renderedClip.title,
    clipCandidateTitle: renderedClip.clipCandidate.title,
  });
  const description = buildPublicationDescription({
    clipCandidateCaptionCopy: renderedClip.clipCandidate.captionCopy,
    clipCandidateSummary: renderedClip.clipCandidate.summary,
  });
  await assertJobExecutionAuthorized(params.authority);
  const uploadUrl = await startYoutubeResumableUpload({
    accessToken: params.account.accessToken,
    mimeType,
    fileSizeBytes: videoBody.byteLength,
    title,
    description,
    signal: operationSignal,
  });

  await assertJobExecutionAuthorized(params.authority);
  return await uploadVideoToYoutube({
    accessToken: params.account.accessToken,
    uploadUrl,
    mimeType,
    body: videoBody,
    signal: operationSignal,
  });
}

async function publishRenderedClipToTiktok(): Promise<{
  platformPostId: string;
  platformUrl: string | null;
}> {
  getRequiredEnvVar('ENABLE_TIKTOK_PUBLISH');
  throw new Error('TikTok publishing is not enabled in this environment yet.');
}

export async function publishRenderedClipPublication(
  clipPublicationId: number,
  authority: JobExecutionAuthority
) {
  assertDirectPublishingProhibited();
  const publication = await db.query.clipPublications.findFirst({
    where: eq(clipPublications.id, clipPublicationId),
    with: {
      linkedAccount: true,
      renderedClip: {
        with: {
          clipCandidate: true,
        },
      },
    },
  });

  if (!publication) {
    throw new Error('Clip publication not found.');
  }

  const blockedReason = getLinkedAccountPublishBlockedReason(publication.linkedAccount);

  if (blockedReason) {
    throw new Error(blockedReason);
  }

  if (
    publication.renderedClip.status !== RenderedClipStatus.READY ||
    !publication.renderedClip.storageKey
  ) {
    throw new Error('Rendered clip is not ready to publish yet.');
  }

  if (isMediaUnavailable(publication.renderedClip)) {
    throw new Error('Rendered clip media expired and is no longer available.');
  }

  await withAuthorizedJobTransaction(authority, async (tx) => {
    await markClipPublicationPublishing(publication.id, tx);
  });

  await assertJobExecutionAuthorized(authority);
  const result =
    publication.platform === 'youtube'
      ? await publishRenderedClipToYoutube({
          publication,
          account: publication.linkedAccount,
          renderedClip: publication.renderedClip,
          authority,
        })
      : await publishRenderedClipToTiktok();

  return { publication, result };
}
