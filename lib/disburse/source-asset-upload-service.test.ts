import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_MULTIPART_PARTS,
  MIN_MULTIPART_PART_SIZE_BYTES,
} from './source-asset-upload-config.ts';
import {
  createSourceAssetUploadService,
  type SourceAssetUploadServiceDeps,
} from './source-asset-upload-service-core.ts';
import {
  MediaRetentionStatus,
  SourceAssetStatus,
  SourceAssetType,
  SourceUploadPartStatus,
  SourceUploadSessionStatus,
  type SourceAsset,
  type SourceUploadPart,
  type SourceUploadSession,
  type User,
} from '../db/schema.ts';

const BASE_NOW = new Date('2026-06-29T12:00:00.000Z');

type TestHarness = ReturnType<typeof createHarness>;

function createUser(id: number) {
  return { id } as User;
}

function createHarness() {
  const now = new Date(BASE_NOW);
  const projects = new Map<string, { id: number; expiresAt: Date | null; isSaved: boolean }>();
  const sessions: SourceUploadSession[] = [];
  const parts: SourceUploadPart[] = [];
  const sourceAssets: SourceAsset[] = [];
  const uploadIdToParts = new Map<string, Array<{ partNumber: number; etag: string }>>();
  const createMultipartUploadCalls: Array<{ storageKey: string; mimeType: string }> = [];
  const completeMultipartUploadCalls: Array<{
    storageKey: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }> = [];
  const abortMultipartUploadCalls: Array<{ storageKey: string; uploadId: string }> = [];
  const uploadPartUrlCalls: Array<{ storageKey: string; uploadId: string; partNumber: number }> =
    [];
  const thumbnailJobCalls: number[] = [];
  const notificationCalls: number[] = [];
  let sessionIdCounter = 1;
  let partIdCounter = 1;
  let sourceAssetIdCounter = 1;
  let uploadIdCounter = 1;
  let storageKeyCounter = 1;

  const deps: SourceAssetUploadServiceDeps = {
    now: () => new Date(now),
    async assertProjectOwnership(projectId, userId) {
      const project = projects.get(`${userId}:${projectId}`);
      if (!project) {
        throw new Error('Project not found.');
      }

      return project;
    },
    async getAuthorizedSession(uploadSessionId, userId) {
      const session =
        sessions.find((candidate) => candidate.id === uploadSessionId && candidate.userId === userId) ||
        null;

      if (!session) {
        throw new Error('Upload session not found.');
      }

      return { ...session };
    },
    async findExistingSessionWithParts(userId, projectId, idempotencyKey) {
      const session =
        sessions.find(
          (candidate) =>
            candidate.userId === userId &&
            candidate.projectId === projectId &&
            candidate.idempotencyKey === idempotencyKey
        ) || null;

      if (!session) {
        return null;
      }

      return {
        ...session,
        parts: parts
          .filter((part) => part.uploadSessionId === session.id)
          .sort((left, right) => left.partNumber - right.partNumber)
          .map((part) => ({
            partNumber: part.partNumber,
            etag: part.etag,
          })),
      };
    },
    async insertUploadSession(input) {
      const existing = sessions.find(
        (candidate) =>
          candidate.userId === input.userId &&
          candidate.projectId === input.projectId &&
          candidate.idempotencyKey === input.idempotencyKey
      );

      if (existing) {
        return null;
      }

      const session: SourceUploadSession = {
        id: sessionIdCounter += 1,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        completedAt: null,
        abortedAt: null,
        failureReason: null,
        sourceAssetId: null,
        ...input,
      };
      sessions.push(session);
      return { ...session };
    },
    async findUploadParts(uploadSessionId) {
      return parts
        .filter((part) => part.uploadSessionId === uploadSessionId)
        .sort((left, right) => left.partNumber - right.partNumber)
        .map((part) => ({ ...part }));
    },
    async findUploadPart(uploadSessionId, partNumber) {
      const part =
        parts.find(
          (candidate) =>
            candidate.uploadSessionId === uploadSessionId &&
            candidate.partNumber === partNumber
        ) || null;
      return part ? { ...part } : null;
    },
    async insertUploadPart(input) {
      const existing = parts.find(
        (candidate) =>
          candidate.uploadSessionId === input.uploadSessionId &&
          candidate.partNumber === input.partNumber
      );

      if (existing) {
        return null;
      }

      const part: SourceUploadPart = {
        id: partIdCounter += 1,
        createdAt: new Date(now),
        ...input,
        checksumSha256: input.checksumSha256 ?? null,
      };
      parts.push(part);
      return { ...part };
    },
    async findSourceAssetByIdForUser(sourceAssetId, userId) {
      const sourceAsset =
        sourceAssets.find(
          (candidate) => candidate.id === sourceAssetId && candidate.userId === userId
        ) || null;
      return sourceAsset ? { ...sourceAsset } : null;
    },
    async claimUploadSessionForCompletion(uploadSessionId, userId, claimNow) {
      const session = sessions.find(
        (candidate) => candidate.id === uploadSessionId && candidate.userId === userId
      );

      if (
        !session ||
        ![
          SourceUploadSessionStatus.UPLOADING,
          SourceUploadSessionStatus.FAILED,
        ].includes(session.status)
      ) {
        return null;
      }

      session.status = SourceUploadSessionStatus.COMPLETING;
      session.failureReason = null;
      session.updatedAt = claimNow;
      return { ...session };
    },
    async markUploadSessionFailed(uploadSessionId, failureReason, failedAt) {
      const session = sessions.find((candidate) => candidate.id === uploadSessionId);
      if (!session) {
        return;
      }

      session.status = SourceUploadSessionStatus.FAILED;
      session.failureReason = failureReason;
      session.updatedAt = failedAt;
    },
    async markUploadSessionAborted(uploadSessionId, userId, abortedAt) {
      const session =
        sessions.find((candidate) => candidate.id === uploadSessionId && candidate.userId === userId) ||
        null;

      if (!session) {
        return null;
      }

      session.status = SourceUploadSessionStatus.ABORTED;
      session.abortedAt = abortedAt;
      session.updatedAt = abortedAt;
      return { ...session };
    },
    async completeUploadSessionWithSourceAsset(input) {
      const session = sessions.find(
        (candidate) =>
          candidate.id === input.uploadSessionId &&
          candidate.userId === input.userId &&
          candidate.projectId === input.projectId &&
          candidate.storageKey === input.storageKey
      );
      if (!session || session.status !== SourceUploadSessionStatus.COMPLETING) return null;
      const project = projects.get(`${input.userId}:${input.projectId}`);
      if (!project) throw new Error('Project not found.');
      let sourceAsset = sourceAssets.find(
        (candidate) =>
          candidate.userId === input.userId &&
          candidate.projectId === input.projectId &&
          candidate.storageKey === input.storageKey
      );

      if (!sourceAsset) {
        sourceAsset = {
          id: sourceAssetIdCounter += 1,
          userId: input.userId,
          projectId: input.projectId,
          title: input.title,
          assetType: SourceAssetType.UPLOADED_FILE,
          originalFilename: input.originalFilename,
          mimeType: input.mimeType,
          storageKey: input.storageKey,
          storageUrl: `s3://bucket/${input.storageKey}`,
          fileSizeBytes: input.fileSizeBytes,
          thumbnailStorageKey: null,
          thumbnailMimeType: null,
          thumbnailWidth: null,
          thumbnailHeight: null,
          status: SourceAssetStatus.UPLOADED,
          retentionStatus: project.isSaved
            ? MediaRetentionStatus.SAVED
            : MediaRetentionStatus.TEMPORARY,
          expiresAt: project.isSaved ? null : project.expiresAt,
          savedAt: project.isSaved ? input.now : null,
          deletedAt: null,
          storageDeletedAt: null,
          deletionRequestedAt: null,
          deletionReason: null,
          failureReason: null,
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        };
        sourceAssets.push(sourceAsset);
      }
      session.status = SourceUploadSessionStatus.COMPLETED;
      session.sourceAssetId = sourceAsset.id;
      session.completedAt = input.now;
      session.updatedAt = input.now;
      session.failureReason = null;
      return { ...sourceAsset };
    },
    async findStaleSessions(staleBefore) {
      return sessions
        .filter(
          (session) =>
            [SourceUploadSessionStatus.UPLOADING, SourceUploadSessionStatus.COMPLETING, SourceUploadSessionStatus.FAILED].includes(
              session.status
            ) && session.updatedAt < staleBefore
        )
        .map((session) => ({ ...session }));
    },
    async markStaleSessionAborted(uploadSessionId, abortedAt) {
      const session = sessions.find((candidate) => candidate.id === uploadSessionId);
      if (!session) {
        return;
      }

      session.status = SourceUploadSessionStatus.ABORTED;
      session.abortedAt = abortedAt;
      session.updatedAt = abortedAt;
    },
    createStorageKey(userId, projectId, filename) {
      const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
      const storageKey = `uploads/source-assets/${userId}/${projectId}/key-${storageKeyCounter}${extension}`;
      storageKeyCounter += 1;
      return storageKey;
    },
    async createMultipartUpload(params) {
      createMultipartUploadCalls.push(params);
      const uploadId = `upload-${uploadIdCounter}`;
      uploadIdCounter += 1;
      return { uploadId };
    },
    createPresignedUploadPart(params) {
      uploadPartUrlCalls.push(params);
      return {
        method: 'PUT',
        uploadUrl: `https://storage.test/${params.uploadId}/${params.partNumber}`,
        headers: {},
      };
    },
    async listMultipartUploadParts({ uploadId }) {
      return (uploadIdToParts.get(uploadId) || []).map((part) => ({ ...part }));
    },
    async completeMultipartUpload(params) {
      completeMultipartUploadCalls.push({
        storageKey: params.storageKey,
        uploadId: params.uploadId,
        parts: params.parts.map((part) => ({ ...part })),
      });
    },
    async abortMultipartUpload(params) {
      abortMultipartUploadCalls.push(params);
    },
    buildStorageUrl(storageKey) {
      return `s3://bucket/${storageKey}`;
    },
    getTemporaryProjectExpiresAt() {
      return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    },
    async createUploadCompletedNotification(sourceAssetId) {
      notificationCalls.push(sourceAssetId);
    },
    async enqueueThumbnailJob(sourceAssetId) {
      thumbnailJobCalls.push(sourceAssetId);
      return null;
    },
  };

  return {
    deps,
    service: createSourceAssetUploadService(deps),
    projects,
    sessions,
    parts,
    sourceAssets,
    uploadIdToParts,
    createMultipartUploadCalls,
    completeMultipartUploadCalls,
    abortMultipartUploadCalls,
    uploadPartUrlCalls,
    thumbnailJobCalls,
    notificationCalls,
    now,
  };
}

function addProject(harness: TestHarness, userId: number, projectId: number, isSaved = false) {
  harness.projects.set(`${userId}:${projectId}`, {
    id: projectId,
    expiresAt: new Date(BASE_NOW.getTime() + 60 * 60 * 1000),
    isSaved,
  });
}

function pushSession(
  harness: TestHarness,
  overrides: Partial<SourceUploadSession> = {}
) {
  const session: SourceUploadSession = {
    id: harness.sessions.length + 1,
    userId: 1,
    projectId: 10,
    idempotencyKey: `idempotency-${harness.sessions.length + 1}`,
    originalFilename: 'video.mp4',
    mimeType: 'video/mp4',
    fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES * 2 + 25,
    storageKey: `uploads/source-assets/1/10/key-${harness.sessions.length + 1}.mp4`,
    uploadId: `upload-session-${harness.sessions.length + 1}`,
    partSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES,
    totalParts: 3,
    status: SourceUploadSessionStatus.UPLOADING,
    sourceAssetId: null,
    failureReason: null,
    completedAt: null,
    abortedAt: null,
    expiresAt: new Date(BASE_NOW.getTime() + 24 * 60 * 60 * 1000),
    createdAt: new Date(BASE_NOW),
    updatedAt: new Date(BASE_NOW),
    ...overrides,
  };
  harness.sessions.push(session);
  return session;
}

function pushPart(
  harness: TestHarness,
  session: SourceUploadSession,
  partNumber: number,
  etag = `"etag-${partNumber}"`
) {
  const byteStart = (partNumber - 1) * session.partSizeBytes;
  const byteEnd = Math.min(byteStart + session.partSizeBytes, session.fileSizeBytes) - 1;
  const part: SourceUploadPart = {
    id: harness.parts.length + 1,
    uploadSessionId: session.id,
    partNumber,
    byteStart,
    byteEnd,
    sizeBytes: byteEnd - byteStart + 1,
    etag,
    checksumSha256: null,
    status: SourceUploadPartStatus.UPLOADED,
    createdAt: new Date(BASE_NOW),
    updatedAt: new Date(BASE_NOW),
  };
  harness.parts.push(part);
  return part;
}

function pushSourceAsset(
  harness: TestHarness,
  overrides: Partial<SourceAsset> = {}
) {
  const sourceAsset: SourceAsset = {
    id: harness.sourceAssets.length + 1,
    userId: 1,
    projectId: 10,
    title: 'Uploaded source',
    assetType: SourceAssetType.UPLOADED_FILE,
    originalFilename: 'video.mp4',
    mimeType: 'video/mp4',
    storageKey: `uploads/source-assets/1/10/source-${harness.sourceAssets.length + 1}.mp4`,
    storageUrl: `s3://bucket/uploads/source-assets/1/10/source-${harness.sourceAssets.length + 1}.mp4`,
    fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES,
    thumbnailStorageKey: null,
    thumbnailMimeType: null,
    thumbnailWidth: null,
    thumbnailHeight: null,
    status: SourceAssetStatus.UPLOADED,
    retentionStatus: MediaRetentionStatus.TEMPORARY,
    expiresAt: new Date(BASE_NOW.getTime() + 60 * 60 * 1000),
    savedAt: null,
    deletedAt: null,
    storageDeletedAt: null,
    deletionReason: null,
    failureReason: null,
    createdAt: new Date(BASE_NOW),
    updatedAt: new Date(BASE_NOW),
    ...overrides,
  };
  harness.sourceAssets.push(sourceAsset);
  return sourceAsset;
}

test('initiate returns an existing active session for the same user, project, and idempotency key', async () => {
  const harness = createHarness();
  addProject(harness, 1, 10);
  const session = pushSession(harness, { idempotencyKey: 'repeatable-key' });
  pushPart(harness, session, 1, '"etag-1"');

  const result = await harness.service.initiateSourceAssetUpload(
    {
      projectId: 10,
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: session.fileSizeBytes,
      idempotencyKey: 'repeatable-key',
    },
    createUser(1)
  );

  assert.equal(result.session.id, session.id);
  assert.deepEqual(result.uploadedParts, [{ partNumber: 1, etag: '"etag-1"' }]);
  assert.equal(harness.createMultipartUploadCalls.length, 0);
});

test('initiate scopes idempotency to user and project', async () => {
  const harness = createHarness();
  addProject(harness, 1, 10);
  addProject(harness, 1, 11);
  addProject(harness, 2, 10);

  const first = await harness.service.initiateSourceAssetUpload(
    {
      projectId: 10,
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES,
      idempotencyKey: 'shared-key',
    },
    createUser(1)
  );
  const second = await harness.service.initiateSourceAssetUpload(
    {
      projectId: 11,
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES,
      idempotencyKey: 'shared-key',
    },
    createUser(1)
  );
  const third = await harness.service.initiateSourceAssetUpload(
    {
      projectId: 10,
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES,
      idempotencyKey: 'shared-key',
    },
    createUser(2)
  );

  assert.notEqual(first.session.id, second.session.id);
  assert.notEqual(first.session.id, third.session.id);
  assert.equal(harness.sessions.length, 3);
});

test('acknowledging a part is idempotent for the same etag and conflicts for a different etag', async () => {
  const harness = createHarness();
  const session = pushSession(harness);

  const first = await harness.service.acknowledgeSourceAssetUploadPart(
    {
      uploadSessionId: session.id,
      partNumber: 1,
      etag: '"etag-1"',
    },
    createUser(1)
  );
  const second = await harness.service.acknowledgeSourceAssetUploadPart(
    {
      uploadSessionId: session.id,
      partNumber: 1,
      etag: '"etag-1"',
    },
    createUser(1)
  );

  assert.deepEqual(first, second);
  assert.equal(harness.parts.length, 1);

  await assert.rejects(
    () =>
      harness.service.acknowledgeSourceAssetUploadPart(
        {
          uploadSessionId: session.id,
          partNumber: 1,
          etag: '"etag-conflict"',
        },
        createUser(1)
      ),
    /conflicts/
  );
});

test('part acknowledgement rejects invalid part numbers, invalid bounds, and unauthorized sessions', async () => {
  const harness = createHarness();
  const session = pushSession(harness, { totalParts: 2, fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES + 10 });
  const invalidBoundsSession = pushSession(harness, {
    id: 99,
    userId: 1,
    partSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES - 1,
    totalParts: 2,
    fileSizeBytes: (MIN_MULTIPART_PART_SIZE_BYTES - 1) * 2,
  });

  await assert.rejects(
    () =>
      harness.service.acknowledgeSourceAssetUploadPart(
        {
          uploadSessionId: session.id,
          partNumber: 3,
          etag: '"etag-3"',
        },
        createUser(1)
      ),
    /Invalid upload part number/
  );

  await assert.rejects(
    () =>
      harness.service.acknowledgeSourceAssetUploadPart(
        {
          uploadSessionId: invalidBoundsSession.id,
          partNumber: 1,
          etag: '"etag-bad"',
        },
        createUser(1)
      ),
    /Invalid upload part size/
  );

  await assert.rejects(
    () =>
      harness.service.acknowledgeSourceAssetUploadPart(
        {
          uploadSessionId: session.id,
          partNumber: 1,
          etag: '"etag-1"',
        },
        createUser(9)
      ),
    /Upload session not found/
  );
});

test('status returns ordered session metadata and acked parts for resume', async () => {
  const harness = createHarness();
  const session = pushSession(harness);
  pushPart(harness, session, 2, '"etag-2"');
  pushPart(harness, session, 1, '"etag-1"');

  const result = await harness.service.getSourceAssetUploadStatus(
    { uploadSessionId: session.id },
    createUser(1)
  );

  assert.equal(result.session.id, session.id);
  assert.deepEqual(result.uploadedParts, [
    { partNumber: 1, etag: '"etag-1"' },
    { partNumber: 2, etag: '"etag-2"' },
  ]);
});

test('part upload url skips already acked parts', async () => {
  const harness = createHarness();
  const session = pushSession(harness);
  pushPart(harness, session, 1, '"etag-1"');

  const existing = await harness.service.createSourceAssetUploadPartUrl(
    { uploadSessionId: session.id, partNumber: 1 },
    createUser(1)
  );
  const fresh = await harness.service.createSourceAssetUploadPartUrl(
    { uploadSessionId: session.id, partNumber: 2 },
    createUser(1)
  );

  assert.deepEqual(existing, {
    alreadyUploaded: true,
    partNumber: 1,
    etag: '"etag-1"',
  });
  assert.equal(fresh.alreadyUploaded, false);
  assert.equal(harness.uploadPartUrlCalls.length, 1);
});

test('completion fails when expected parts are missing and marks the session failed', async () => {
  const harness = createHarness();
  addProject(harness, 1, 10);
  const session = pushSession(harness, { totalParts: 2, fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES * 2 });
  pushPart(harness, session, 1, '"etag-1"');
  harness.uploadIdToParts.set(session.uploadId, [{ partNumber: 1, etag: '"etag-1"' }]);

  await assert.rejects(
    () =>
      harness.service.completeSourceAssetUpload(
        { uploadSessionId: session.id, title: 'Uploaded source' },
        createUser(1)
      ),
    /missing one or more parts/
  );

  assert.equal(harness.sessions[0]?.status, SourceUploadSessionStatus.FAILED);
});

test('completion rejects when storage parts do not match acknowledged parts', async () => {
  const harness = createHarness();
  addProject(harness, 1, 10);
  const session = pushSession(harness, { totalParts: 2, fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES * 2 });
  pushPart(harness, session, 1, '"etag-1"');
  pushPart(harness, session, 2, '"etag-2"');
  harness.uploadIdToParts.set(session.uploadId, [
    { partNumber: 1, etag: '"etag-1"' },
    { partNumber: 2, etag: '"etag-conflict"' },
  ]);

  await assert.rejects(
    () =>
      harness.service.completeSourceAssetUpload(
        { uploadSessionId: session.id, title: 'Uploaded source' },
        createUser(1)
      ),
    /do not match storage state/
  );
});

test('completion can retry a failed finishing session without reuploading parts', async () => {
  const harness = createHarness();
  addProject(harness, 1, 10);
  const session = pushSession(harness, {
    status: SourceUploadSessionStatus.FAILED,
    failureReason: 'Uploaded parts do not match storage state.',
    totalParts: 2,
    fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES * 2,
  });
  pushPart(harness, session, 1, '"etag-1"');
  pushPart(harness, session, 2, '"etag-2"');
  harness.uploadIdToParts.set(session.uploadId, [
    { partNumber: 1, etag: '"etag-1"' },
    { partNumber: 2, etag: '"etag-2"' },
  ]);

  const result = await harness.service.completeSourceAssetUpload(
    { uploadSessionId: session.id, title: 'Uploaded source' },
    createUser(1)
  );

  assert.equal(result.sourceAsset.title, 'Uploaded source');
  assert.equal(harness.sessions[0]?.status, SourceUploadSessionStatus.COMPLETED);
  assert.equal(harness.sessions[0]?.failureReason, null);
  assert.equal(harness.completeMultipartUploadCalls.length, 1);
});

test('completion handles more than 1,000 parts and sends them to storage in ascending order', async () => {
  const harness = createHarness();
  addProject(harness, 1, 10);
  const totalParts = 1_001;
  const session = pushSession(harness, {
    totalParts,
    fileSizeBytes: totalParts * MIN_MULTIPART_PART_SIZE_BYTES,
  });

  for (let partNumber = totalParts; partNumber >= 1; partNumber -= 1) {
    pushPart(harness, session, partNumber, `"etag-${partNumber}"`);
  }
  harness.uploadIdToParts.set(
    session.uploadId,
    Array.from({ length: totalParts }, (_, index) => ({
      partNumber: index + 1,
      etag: `"etag-${index + 1}"`,
    }))
  );

  const result = await harness.service.completeSourceAssetUpload(
    { uploadSessionId: session.id, title: 'Uploaded source' },
    createUser(1)
  );

  assert.equal(result.sourceAsset.storageKey, session.storageKey);
  assert.equal(harness.completeMultipartUploadCalls.length, 1);
  assert.equal(harness.completeMultipartUploadCalls[0]?.parts.length, totalParts);
  assert.deepEqual(
    harness.completeMultipartUploadCalls[0]?.parts.slice(0, 3).map((part) => part.partNumber),
    [1, 2, 3]
  );
  assert.deepEqual(
    harness.completeMultipartUploadCalls[0]?.parts.slice(-3).map((part) => part.partNumber),
    [999, 1000, 1001]
  );
});

test('repeated complete returns the existing source asset without duplicate downstream jobs', async () => {
  const harness = createHarness();
  const sourceAsset = pushSourceAsset(harness);
  pushSession(harness, {
    status: SourceUploadSessionStatus.COMPLETED,
    sourceAssetId: sourceAsset.id,
    storageKey: sourceAsset.storageKey,
  });

  const result = await harness.service.completeSourceAssetUpload(
    { uploadSessionId: 1, title: 'Uploaded source' },
    createUser(1)
  );

  assert.equal(result.sourceAsset.id, sourceAsset.id);
  assert.equal(harness.notificationCalls.length, 0);
  assert.equal(harness.thumbnailJobCalls.length, 0);
});

test('completion reuses an existing source asset by storage key and queues non-transcription post-upload work once', async () => {
  const harness = createHarness();
  addProject(harness, 1, 10);
  const session = pushSession(harness, { totalParts: 2, fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES * 2 });
  pushPart(harness, session, 1, '"etag-1"');
  pushPart(harness, session, 2, '"etag-2"');
  harness.uploadIdToParts.set(session.uploadId, [
    { partNumber: 1, etag: '"etag-1"' },
    { partNumber: 2, etag: '"etag-2"' },
  ]);
  const sourceAsset = pushSourceAsset(harness, { storageKey: session.storageKey });

  const result = await harness.service.completeSourceAssetUpload(
    { uploadSessionId: session.id, title: 'Uploaded source' },
    createUser(1)
  );

  assert.equal(result.sourceAsset.id, sourceAsset.id);
  assert.equal(harness.sourceAssets.length, 1);
  assert.deepEqual(harness.notificationCalls, [sourceAsset.id]);
  assert.deepEqual(harness.thumbnailJobCalls, [sourceAsset.id]);
});

test('concurrent completion contention only creates one source asset and one set of downstream jobs', async () => {
  const harness = createHarness();
  addProject(harness, 1, 10);
  const session = pushSession(harness, { totalParts: 2, fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES * 2 });
  pushPart(harness, session, 1, '"etag-1"');
  pushPart(harness, session, 2, '"etag-2"');
  harness.uploadIdToParts.set(session.uploadId, [
    { partNumber: 1, etag: '"etag-1"' },
    { partNumber: 2, etag: '"etag-2"' },
  ]);

  let getAuthorizedSessionCallCount = 0;
  let claimCallCount = 0;
  let releaseFirstCompletion: (() => void) | null = null;
  const firstCompletionReleased = new Promise<void>((resolve) => {
    releaseFirstCompletion = resolve;
  });
  let completeFirstCall: (() => void) | null = null;
  const firstCallCompleted = new Promise<void>((resolve) => {
    completeFirstCall = resolve;
  });

  const concurrentService = createSourceAssetUploadService({
    ...harness.deps,
    async getAuthorizedSession(uploadSessionId, userId) {
      getAuthorizedSessionCallCount += 1;

      if (getAuthorizedSessionCallCount <= 2) {
        const sessionRecord = harness.sessions.find(
          (candidate) => candidate.id === uploadSessionId && candidate.userId === userId
        );

        if (!sessionRecord) {
          throw new Error('Upload session not found.');
        }

        return { ...sessionRecord, status: SourceUploadSessionStatus.UPLOADING };
      }

      return harness.deps.getAuthorizedSession(uploadSessionId, userId);
    },
    async claimUploadSessionForCompletion(uploadSessionId, userId, claimNow) {
      claimCallCount += 1;

      if (claimCallCount === 1) {
        return harness.deps.claimUploadSessionForCompletion(uploadSessionId, userId, claimNow);
      }

      await firstCallCompleted;
      return null;
    },
    async completeMultipartUpload(params) {
      if (harness.completeMultipartUploadCalls.length === 0) {
        await firstCompletionReleased;
      }

      return harness.deps.completeMultipartUpload(params);
    },
    async completeUploadSessionWithSourceAsset(input) {
      const sourceAsset = await harness.deps.completeUploadSessionWithSourceAsset(input);
      completeFirstCall?.();
      return sourceAsset;
    },
  });

  const first = concurrentService.completeSourceAssetUpload(
    { uploadSessionId: session.id, title: 'Uploaded source' },
    createUser(1)
  );
  const second = concurrentService.completeSourceAssetUpload(
    { uploadSessionId: session.id, title: 'Uploaded source' },
    createUser(1)
  );

  releaseFirstCompletion?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.sourceAsset.id, secondResult.sourceAsset.id);
  assert.equal(harness.sourceAssets.length, 1);
  assert.equal(harness.completeMultipartUploadCalls.length, 1);
  assert.equal(harness.notificationCalls.length, 1);
  assert.equal(harness.thumbnailJobCalls.length, 1);
});

test('abort marks a session aborted and stale cleanup aborts eligible sessions idempotently', async () => {
  const harness = createHarness();
  const activeSession = pushSession(harness, { id: 1, uploadId: 'upload-active' });
  const staleUploading = pushSession(harness, {
    id: 2,
    uploadId: 'upload-stale-1',
    updatedAt: new Date(BASE_NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
  });
  const staleCompleting = pushSession(harness, {
    id: 3,
    uploadId: 'upload-stale-2',
    status: SourceUploadSessionStatus.COMPLETING,
    updatedAt: new Date(BASE_NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
  });
  const staleFailed = pushSession(harness, {
    id: 4,
    uploadId: 'upload-stale-3',
    status: SourceUploadSessionStatus.FAILED,
    updatedAt: new Date(BASE_NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
  });
  pushSession(harness, {
    id: 5,
    uploadId: 'upload-completed',
    status: SourceUploadSessionStatus.COMPLETED,
    sourceAssetId: 77,
    updatedAt: new Date(BASE_NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
  });
  pushSession(harness, {
    id: 6,
    uploadId: 'upload-aborted',
    status: SourceUploadSessionStatus.ABORTED,
    updatedAt: new Date(BASE_NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
  });

  await harness.service.abortSourceAssetUpload(
    { uploadSessionId: activeSession.id },
    createUser(1)
  );

  assert.equal(harness.sessions.find((session) => session.id === activeSession.id)?.status, SourceUploadSessionStatus.ABORTED);

  const cleanupCount = await harness.service.cleanupStaleSourceUploadSessions(new Date(BASE_NOW));

  assert.equal(cleanupCount, 3);
  assert.equal(harness.sessions.find((session) => session.id === staleUploading.id)?.status, SourceUploadSessionStatus.ABORTED);
  assert.equal(harness.sessions.find((session) => session.id === staleCompleting.id)?.status, SourceUploadSessionStatus.ABORTED);
  assert.equal(harness.sessions.find((session) => session.id === staleFailed.id)?.status, SourceUploadSessionStatus.ABORTED);
  assert.equal(harness.sessions.find((session) => session.id === 5)?.status, SourceUploadSessionStatus.COMPLETED);
  assert.equal(harness.sessions.find((session) => session.id === 6)?.status, SourceUploadSessionStatus.ABORTED);
  assert.deepEqual(
    harness.abortMultipartUploadCalls.map((call) => call.uploadId),
    ['upload-active', 'upload-stale-1', 'upload-stale-2', 'upload-stale-3']
  );
});

test('abort is a no-op for already completed or aborted sessions', async () => {
  const harness = createHarness();
  const completed = pushSession(harness, {
    id: 1,
    status: SourceUploadSessionStatus.COMPLETED,
    sourceAssetId: 101,
  });
  const aborted = pushSession(harness, {
    id: 2,
    status: SourceUploadSessionStatus.ABORTED,
  });

  const completedResult = await harness.service.abortSourceAssetUpload(
    { uploadSessionId: completed.id },
    createUser(1)
  );
  const abortedResult = await harness.service.abortSourceAssetUpload(
    { uploadSessionId: aborted.id },
    createUser(1)
  );

  assert.equal(completedResult.session.status, SourceUploadSessionStatus.COMPLETED);
  assert.equal(abortedResult.session.status, SourceUploadSessionStatus.ABORTED);
  assert.equal(harness.abortMultipartUploadCalls.length, 0);
});

test('session initiation can recover from an insert conflict by aborting the orphaned multipart upload', async () => {
  const harness = createHarness();
  addProject(harness, 1, 10);
  let attemptedConflict = false;
  const recoverableService = createSourceAssetUploadService({
    ...harness.deps,
    async insertUploadSession(input) {
      if (!attemptedConflict) {
        attemptedConflict = true;
        pushSession(harness, input);
        return null;
      }

      return harness.deps.insertUploadSession(input);
    },
  });

  const result = await recoverableService.initiateSourceAssetUpload(
    {
      projectId: 10,
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES,
      idempotencyKey: 'recoverable-key',
    },
    createUser(1)
  );

  assert.equal(result.session.id, 1);
  assert.equal(harness.abortMultipartUploadCalls.length, 1);
});

test('session initiation compensates a multipart upload when lifecycle persistence rejects', async () => {
  const harness = createHarness();
  addProject(harness, 1, 10);
  const lifecycleService = createSourceAssetUploadService({
    ...harness.deps,
    async insertUploadSession() {
      throw new Error('Project deletion blocks upload persistence.');
    },
  });

  await assert.rejects(
    lifecycleService.initiateSourceAssetUpload(
      {
        projectId: 10,
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        fileSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES,
        idempotencyKey: 'lifecycle-rejected-key',
      },
      createUser(1)
    ),
    /Project deletion blocks upload persistence/
  );
  assert.equal(harness.sessions.length, 0);
  assert.equal(harness.abortMultipartUploadCalls.length, 1);
});

test('part url schema caps part numbers at the configured multipart maximum', async () => {
  const harness = createHarness();
  const session = pushSession(harness);

  await assert.rejects(
    () =>
      harness.service.createSourceAssetUploadPartUrl(
        {
          uploadSessionId: session.id,
          partNumber: MAX_MULTIPART_PARTS + 1,
        },
        createUser(1)
      ),
    /Invalid upload part number/
  );
});
