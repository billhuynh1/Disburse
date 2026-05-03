import crypto from 'node:crypto';
import 'server-only';

type S3UploadConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string | null;
  pathStyle: boolean;
};

type PresignedUploadParams = {
  storageKey: string;
  mimeType: string;
  expiresInSeconds?: number;
};

type PresignedDownloadParams = {
  storageKey: string;
  expiresInSeconds?: number;
};

type PresignedDeleteParams = {
  storageKey: string;
  expiresInSeconds?: number;
};

function getRequiredEnvVar(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} environment variable is not set`);
  }

  return value;
}

function getBucketNameEnvVar(name: string) {
  const value = getRequiredEnvVar(name);

  if (value.includes('/')) {
    throw new Error(
      `${name} must be the bucket name only and cannot contain "/".`
    );
  }

  return value;
}

function parseBooleanEnvVar(name: string) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function getS3UploadConfig(): S3UploadConfig {
  return {
    accessKeyId: getRequiredEnvVar('S3_UPLOAD_ACCESS_KEY_ID'),
    secretAccessKey: getRequiredEnvVar('S3_UPLOAD_SECRET_ACCESS_KEY'),
    bucket: getBucketNameEnvVar('S3_UPLOAD_BUCKET'),
    region: getRequiredEnvVar('S3_UPLOAD_REGION'),
    endpoint: process.env.S3_UPLOAD_ENDPOINT?.trim() || null,
    pathStyle: parseBooleanEnvVar('S3_UPLOAD_PATH_STYLE'),
  };
}

function encodeRfc3986(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodePathSegment(value: string) {
  return encodeRfc3986(value).replace(/%2F/g, '/');
}

function createSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string
) {
  const kDate = crypto
    .createHmac('sha256', `AWS4${secretAccessKey}`)
    .update(dateStamp)
    .digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto
    .createHmac('sha256', kRegion)
    .update('s3')
    .digest();

  return crypto.createHmac('sha256', kService).update('aws4_request').digest();
}

function createCanonicalQueryString(query: Record<string, string>) {
  return Object.entries(query)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(
      ([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`
    )
    .join('&');
}

function resolveEndpoint(config: S3UploadConfig) {
  if (!config.endpoint) {
    const host = `${config.bucket}.s3.${config.region}.amazonaws.com`;

    return {
      origin: `https://${host}`,
      host,
      pathPrefix: '',
    };
  }

  const endpoint = new URL(config.endpoint);
  const pathPrefix = endpoint.pathname === '/' ? '' : endpoint.pathname;

  if (config.pathStyle) {
    return {
      origin: `${endpoint.protocol}//${endpoint.host}`,
      host: endpoint.host,
      pathPrefix,
    };
  }

  const host = `${config.bucket}.${endpoint.host}`;

  return {
    origin: `${endpoint.protocol}//${host}`,
    host,
    pathPrefix,
  };
}

export function createStorageKey(userId: number, projectId: number, filename: string) {
  const extension = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.')).toLowerCase()
    : '';

  return `uploads/source-assets/${userId}/${projectId}/${crypto.randomUUID()}${extension}`;
}

export function createSourceAssetThumbnailStorageKey(params: {
  userId: number;
  projectId: number;
  sourceAssetId: number;
  mimeType: string;
}) {
  const extension = params.mimeType === 'image/webp' ? '.webp' : '.jpg';

  return `uploads/source-asset-thumbnails/${params.userId}/${params.projectId}/${params.sourceAssetId}/${crypto.randomUUID()}${extension}`;
}

export function createRenderedClipStorageKey(
  userId: number,
  projectId: number,
  clipCandidateId: number,
  variant: string,
  layout = 'default'
) {
  const layoutSuffix = layout === 'default' ? '' : `-${layout}`;
  return `uploads/rendered-clips/${userId}/${projectId}/clip-${clipCandidateId}-${variant}${layoutSuffix}.mp4`;
}

export function buildStorageUrl(storageKey: string) {
  const { bucket } = getS3UploadConfig();
  return `s3://${bucket}/${storageKey}`;
}

export function createPresignedUpload({
  storageKey,
  mimeType,
  expiresInSeconds = 900,
}: PresignedUploadParams) {
  const config = getS3UploadConfig();
  const endpoint = resolveEndpoint(config);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const canonicalUri = config.endpoint && config.pathStyle
    ? `${endpoint.pathPrefix}/${config.bucket}/${encodePathSegment(storageKey)}`
    : `${endpoint.pathPrefix}/${encodePathSegment(storageKey)}`;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'content-type;host',
  };
  const canonicalHeaders = `content-type:${mimeType}\nhost:${endpoint.host}\n`;
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    createCanonicalQueryString(query),
    canonicalHeaders,
    'content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signature = crypto
    .createHmac('sha256', createSigningKey(config.secretAccessKey, dateStamp, config.region))
    .update(stringToSign)
    .digest('hex');
  const signedQuery = createCanonicalQueryString({
    ...query,
    'X-Amz-Signature': signature,
  });

  return {
    method: 'PUT' as const,
    uploadUrl: `${endpoint.origin}${canonicalUri}?${signedQuery}`,
    headers: {
      'Content-Type': mimeType,
    },
  };
}

export function createPresignedDownload({
  storageKey,
  expiresInSeconds = 900,
}: PresignedDownloadParams) {
  const config = getS3UploadConfig();
  const endpoint = resolveEndpoint(config);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const canonicalUri =
    config.endpoint && config.pathStyle
      ? `${endpoint.pathPrefix}/${config.bucket}/${encodePathSegment(storageKey)}`
      : `${endpoint.pathPrefix}/${encodePathSegment(storageKey)}`;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalHeaders = `host:${endpoint.host}\n`;
  const canonicalRequest = [
    'GET',
    canonicalUri,
    createCanonicalQueryString(query),
    canonicalHeaders,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signature = crypto
    .createHmac(
      'sha256',
      createSigningKey(config.secretAccessKey, dateStamp, config.region)
    )
    .update(stringToSign)
    .digest('hex');
  const signedQuery = createCanonicalQueryString({
    ...query,
    'X-Amz-Signature': signature,
  });

  return {
    method: 'GET' as const,
    downloadUrl: `${endpoint.origin}${canonicalUri}?${signedQuery}`,
  };
}

export function createPresignedDelete({
  storageKey,
  expiresInSeconds = 900,
}: PresignedDeleteParams) {
  const config = getS3UploadConfig();
  const endpoint = resolveEndpoint(config);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const canonicalUri =
    config.endpoint && config.pathStyle
      ? `${endpoint.pathPrefix}/${config.bucket}/${encodePathSegment(storageKey)}`
      : `${endpoint.pathPrefix}/${encodePathSegment(storageKey)}`;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalHeaders = `host:${endpoint.host}\n`;
  const canonicalRequest = [
    'DELETE',
    canonicalUri,
    createCanonicalQueryString(query),
    canonicalHeaders,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signature = crypto
    .createHmac(
      'sha256',
      createSigningKey(config.secretAccessKey, dateStamp, config.region)
    )
    .update(stringToSign)
    .digest('hex');
  const signedQuery = createCanonicalQueryString({
    ...query,
    'X-Amz-Signature': signature,
  });

  return {
    method: 'DELETE' as const,
    deleteUrl: `${endpoint.origin}${canonicalUri}?${signedQuery}`,
  };
}

export async function deleteStorageObject(storageKey: string) {
  const deletion = createPresignedDelete({ storageKey });
  const response = await fetch(deletion.deleteUrl, {
    method: deletion.method,
  });

  if (response.ok || response.status === 404) {
    return;
  }

  throw new Error(
    `Storage deletion failed with status ${response.status}.`
  );
}

export async function uploadStorageObject(params: {
  storageKey: string;
  mimeType: string;
  body: BodyInit;
}) {
  const upload = createPresignedUpload({
    storageKey: params.storageKey,
    mimeType: params.mimeType,
  });
  const response = await fetch(upload.uploadUrl, {
    method: upload.method,
    headers: upload.headers,
    body: params.body,
  });

  if (!response.ok) {
    throw new Error(`Storage upload failed with status ${response.status}.`);
  }

  return buildStorageUrl(params.storageKey);
}
