import crypto from 'node:crypto';
import {
  afterExternalEffectSendBoundary,
  afterExternalEffectSuccessBoundary,
  beginExternalEffectBoundary,
} from '@/lib/disburse/job-effect-checkpoint-service';
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

type SignedS3RequestParams = {
  method: 'GET' | 'POST' | 'DELETE';
  storageKey: string;
  query: Record<string, string>;
  headers?: Record<string, string>;
  bodyHash?: string;
};

export type S3MultipartPart = {
  partNumber: number;
  etag: string;
  sizeBytes?: number;
};

type PresignedUploadPartParams = {
  storageKey: string;
  uploadId: string;
  partNumber: number;
  expiresInSeconds?: number;
};

const emptyPayloadHash = crypto.createHash('sha256').update('').digest('hex');

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
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) {
        return leftKey < rightKey ? -1 : 1;
      }

      if (leftValue === rightValue) {
        return 0;
      }

      return leftValue < rightValue ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
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

function resolveCanonicalUri(
  config: S3UploadConfig,
  endpoint: ReturnType<typeof resolveEndpoint>,
  storageKey: string
) {
  return config.endpoint && config.pathStyle
    ? `${endpoint.pathPrefix}/${config.bucket}/${encodePathSegment(storageKey)}`
    : `${endpoint.pathPrefix}/${encodePathSegment(storageKey)}`;
}

function createSignedS3Request({
  method,
  storageKey,
  query,
  headers = {},
  bodyHash = 'UNSIGNED-PAYLOAD',
}: SignedS3RequestParams) {
  const config = getS3UploadConfig();
  const endpoint = resolveEndpoint(config);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const canonicalUri = resolveCanonicalUri(config, endpoint, storageKey);
  const normalizedHeaders = Object.fromEntries(
    Object.entries({
      host: endpoint.host,
      'x-amz-content-sha256': bodyHash,
      'x-amz-date': amzDate,
      ...headers,
    }).map(([key, value]) => [key.toLowerCase(), value.trim()])
  );
  const signedHeaders = Object.keys(normalizedHeaders)
    .sort((leftKey, rightKey) =>
      leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1
    )
    .join(';');
  const canonicalHeaders = Object.entries(normalizedHeaders)
    .sort(([leftKey], [rightKey]) =>
      leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1
    )
    .map(([key, value]) => `${key}:${value}\n`)
    .join('');
  const canonicalRequest = [
    method,
    canonicalUri,
    createCanonicalQueryString(query),
    canonicalHeaders,
    signedHeaders,
    bodyHash,
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

  return {
    url: `${endpoint.origin}${canonicalUri}?${createCanonicalQueryString(query)}`,
    headers: {
      ...headers,
      'x-amz-content-sha256': bodyHash,
      'x-amz-date': amzDate,
      Authorization: [
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}`,
        `SignedHeaders=${signedHeaders}`,
        `Signature=${signature}`,
      ].join(', '),
    },
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

  return `uploads/source-asset-thumbnails/${params.userId}/${params.projectId}/${params.sourceAssetId}/default${extension}`;
}

export function getDeterministicSourceAssetThumbnailStorageKeys(params: {
  userId: number;
  projectId: number;
  sourceAssetId: number;
}) {
  return ['image/jpeg', 'image/webp'].map((mimeType) =>
    createSourceAssetThumbnailStorageKey({ ...params, mimeType })
  );
}

export function createRenderedClipStorageKey(
  userId: number,
  projectId: number,
  clipCandidateId: number,
  variant: string,
  layout = 'default',
  renderConfigId?: number | null
) {
  const layoutSuffix = layout === 'default' ? '' : `-${layout}`;
  const renderConfigSuffix = renderConfigId
    ? `-render-config-${renderConfigId}`
    : '';

  return `uploads/rendered-clips/${userId}/${projectId}/clip-${clipCandidateId}-${variant}${layoutSuffix}${renderConfigSuffix}.mp4`;
}

export function createReusableAssetStorageKey(
  userId: number,
  kind: string,
  filename: string
) {
  const extension = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.')).toLowerCase()
    : '';

  return `uploads/reusable-assets/${userId}/${kind}/${crypto.randomUUID()}${extension}`;
}

export function buildStorageUrl(storageKey: string) {
  const { bucket } = getS3UploadConfig();
  return `s3://${bucket}/${storageKey}`;
}

function readXmlText(xml: string, tagName: string) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
  return match ? unescapeXml(match[1]?.trim() || '') : null;
}

function unescapeXml(value: string) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
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
  const canonicalUri = resolveCanonicalUri(config, endpoint, storageKey);
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

export function createPresignedUploadPart({
  storageKey,
  uploadId,
  partNumber,
  expiresInSeconds = 900,
}: PresignedUploadPartParams) {
  const config = getS3UploadConfig();
  const endpoint = resolveEndpoint(config);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const canonicalUri = resolveCanonicalUri(config, endpoint, storageKey);
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
    partNumber: String(partNumber),
    uploadId,
  };
  const canonicalHeaders = `host:${endpoint.host}\n`;
  const canonicalRequest = [
    'PUT',
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

  return {
    method: 'PUT' as const,
    uploadUrl: `${endpoint.origin}${canonicalUri}?${createCanonicalQueryString({
      ...query,
      'X-Amz-Signature': signature,
    })}`,
    headers: {},
  };
}

export async function createMultipartUpload(params: {
  storageKey: string;
  mimeType: string;
}) {
  const signedRequest = createSignedS3Request({
    method: 'POST',
    storageKey: params.storageKey,
    query: { uploads: '' },
    headers: { 'content-type': params.mimeType },
    bodyHash: emptyPayloadHash,
  });
  const response = await fetch(signedRequest.url, {
    method: 'POST',
    headers: signedRequest.headers,
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Multipart upload initiation failed with status ${response.status}.`);
  }

  const uploadId = readXmlText(body, 'UploadId');

  if (!uploadId) {
    throw new Error('Multipart upload initiation did not return an upload id.');
  }

  return { uploadId };
}

export async function listMultipartUploadParts(params: {
  storageKey: string;
  uploadId: string;
}) {
  const parts: S3MultipartPart[] = [];
  let partNumberMarker: string | null = null;

  while (true) {
    const query: Record<string, string> = {
      uploadId: params.uploadId,
      'max-parts': '1000',
    };

    if (partNumberMarker) {
      query['part-number-marker'] = partNumberMarker;
    }

    const signedRequest = createSignedS3Request({
      method: 'GET',
      storageKey: params.storageKey,
      query,
    });
    const response = await fetch(signedRequest.url, {
      method: 'GET',
      headers: signedRequest.headers,
    });
    const body = await response.text();

    if (!response.ok) {
      throw new Error(`Multipart part listing failed with status ${response.status}.`);
    }

    for (const partMatch of body.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const partXml = partMatch[1] || '';
      const partNumber = Number(readXmlText(partXml, 'PartNumber'));
      const etag = readXmlText(partXml, 'ETag');
      const sizeBytes = Number(readXmlText(partXml, 'Size'));

      if (Number.isInteger(partNumber) && partNumber > 0 && etag) {
        parts.push({
          partNumber,
          etag,
          sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
        });
      }
    }

    const isTruncated = readXmlText(body, 'IsTruncated') === 'true';
    const nextMarker = readXmlText(body, 'NextPartNumberMarker');

    if (!isTruncated || !nextMarker) {
      return parts;
    }

    partNumberMarker = nextMarker;
  }
}

export async function completeMultipartUpload(params: {
  storageKey: string;
  uploadId: string;
  parts: S3MultipartPart[];
}) {
  const body = [
    '<CompleteMultipartUpload>',
    ...params.parts
      .sort((left, right) => left.partNumber - right.partNumber)
      .map(
        (part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(
            part.etag
          )}</ETag></Part>`
      ),
    '</CompleteMultipartUpload>',
  ].join('');
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const signedRequest = createSignedS3Request({
    method: 'POST',
    storageKey: params.storageKey,
    query: { uploadId: params.uploadId },
    headers: { 'content-type': 'application/xml' },
    bodyHash,
  });
  const response = await fetch(signedRequest.url, {
    method: 'POST',
    headers: signedRequest.headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`Multipart upload completion failed with status ${response.status}.`);
  }
}

export async function abortMultipartUpload(params: {
  storageKey: string;
  uploadId: string;
}) {
  const signedRequest = createSignedS3Request({
    method: 'DELETE',
    storageKey: params.storageKey,
    query: { uploadId: params.uploadId },
  });
  const response = await fetch(signedRequest.url, {
    method: 'DELETE',
    headers: signedRequest.headers,
  });

  if (response.ok || response.status === 404 || response.status === 204) {
    return;
  }

  throw new Error(`Multipart upload abort failed with status ${response.status}.`);
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
  const canonicalUri = resolveCanonicalUri(config, endpoint, storageKey);
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
  const canonicalUri = resolveCanonicalUri(config, endpoint, storageKey);
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
  signal?: AbortSignal;
}) {
  const upload = createPresignedUpload({
    storageKey: params.storageKey,
    mimeType: params.mimeType,
  });
  await beginExternalEffectBoundary();
  const responsePromise = fetch(upload.uploadUrl, {
    method: upload.method,
    headers: upload.headers,
    body: params.body,
    signal: params.signal,
  });
  await afterExternalEffectSendBoundary();
  const response = await responsePromise;

  if (!response.ok) {
    throw new Error(`Storage upload failed with status ${response.status}.`);
  }
  await afterExternalEffectSuccessBoundary();

  return buildStorageUrl(params.storageKey);
}
