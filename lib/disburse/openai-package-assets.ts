import 'server-only';

import { z } from 'zod';
import {
  getPackageGeneratedAssetCounts,
  LINKEDIN_POST_ASSET_TYPE,
  X_POST_ASSET_TYPE,
  type ContentPackageValue
} from '@/lib/disburse/content-package-config';
import { getOpenAiShortFormModel } from '@/lib/disburse/openai-short-form';

export type PackageAssetSourceCandidate = {
  rank: number;
  hook: string;
  title: string;
  captionCopy: string;
  summary: string;
  transcriptExcerpt: string;
  whyItWorks: string;
  platformFit: string;
};

export type GeneratedPackageAsset = {
  assetType: typeof X_POST_ASSET_TYPE | typeof LINKEDIN_POST_ASSET_TYPE;
  title: string;
  content: string;
};

const responseSchema = z.object({
  assets: z
    .array(
      z.object({
        assetType: z.enum([X_POST_ASSET_TYPE, LINKEDIN_POST_ASSET_TYPE]),
        title: z.string().trim().min(1).max(150),
        content: z.string().trim().min(1).max(4000)
      })
    )
    .min(1)
});

function getRequiredEnvVar(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} environment variable is not set.`);
  }

  return value;
}

function extractJsonObject(content: string) {
  const trimmed = content.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```json\s*([\s\S]+?)```/i);

  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const objectMatch = trimmed.match(/\{[\s\S]+\}/);

  if (objectMatch?.[0]) {
    return objectMatch[0];
  }

  throw new Error('OpenAI package asset generation did not return JSON.');
}

export function validateGeneratedPackageAssetsResponse(content: string) {
  const parsed = responseSchema.safeParse(JSON.parse(extractJsonObject(content)));

  if (!parsed.success) {
    throw new Error('OpenAI package asset generation returned invalid structured data.');
  }

  return parsed.data.assets satisfies GeneratedPackageAsset[];
}

function assertRequestedAssetCounts(
  assets: GeneratedPackageAsset[],
  contentPackage: ContentPackageValue
) {
  const counts = getPackageGeneratedAssetCounts(contentPackage);
  const xPostCount = assets.filter(
    (asset) => asset.assetType === X_POST_ASSET_TYPE
  ).length;
  const linkedInPostCount = assets.filter(
    (asset) => asset.assetType === LINKEDIN_POST_ASSET_TYPE
  ).length;

  if (
    xPostCount !== counts[X_POST_ASSET_TYPE] ||
    linkedInPostCount !== counts[LINKEDIN_POST_ASSET_TYPE]
  ) {
    throw new Error('OpenAI package asset generation returned the wrong asset count.');
  }
}

export async function generatePackageAssets(params: {
  sourceTitle: string;
  contentPackage: ContentPackageValue;
  candidates: PackageAssetSourceCandidate[];
}) {
  const counts = getPackageGeneratedAssetCounts(params.contentPackage);
  const requestedAssets = [
    counts[X_POST_ASSET_TYPE] > 0
      ? `${counts[X_POST_ASSET_TYPE]} X posts (${X_POST_ASSET_TYPE})`
      : null,
    counts[LINKEDIN_POST_ASSET_TYPE] > 0
      ? `${counts[LINKEDIN_POST_ASSET_TYPE]} LinkedIn posts (${LINKEDIN_POST_ASSET_TYPE})`
      : null
  ].filter(Boolean);

  if (requestedAssets.length === 0) {
    return [];
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getRequiredEnvVar('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: getOpenAiShortFormModel(),
      temperature: 0.35,
      messages: [
        {
          role: 'system',
          content:
            'You create source-grounded social post drafts from ranked clip candidates. Use only the supplied candidate text. Do not invent quotes, stories, statistics, dates, claims, or examples. Return valid JSON only.'
        },
        {
          role: 'user',
          content: [
            `Source title: ${params.sourceTitle}`,
            `Create exactly: ${requestedAssets.join(', ')}.`,
            'Each asset must be grounded in one or more supplied clip candidates.',
            'X posts should be concise and native to X. LinkedIn posts should be clear, professional, and skimmable.',
            'Return JSON with this shape:',
            '{"assets":[{"assetType":"x_post","title":"...","content":"..."}]}',
            'Ranked clip candidates:',
            JSON.stringify(params.candidates)
          ].join('\n')
        }
      ]
    })
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const apiMessage =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      'message' in body.error &&
      typeof body.error.message === 'string'
        ? body.error.message
        : null;

    throw new Error(
      apiMessage || `OpenAI package asset generation failed with status ${response.status}.`
    );
  }

  const content =
    typeof body === 'object' &&
    body !== null &&
    'choices' in body &&
    Array.isArray(body.choices) &&
    body.choices[0] &&
    typeof body.choices[0] === 'object' &&
    body.choices[0] !== null &&
    'message' in body.choices[0] &&
    typeof body.choices[0].message === 'object' &&
    body.choices[0].message !== null &&
    'content' in body.choices[0].message &&
    typeof body.choices[0].message.content === 'string'
      ? body.choices[0].message.content
      : null;

  if (!content) {
    throw new Error('OpenAI package asset generation returned an unexpected response.');
  }

  const assets = validateGeneratedPackageAssetsResponse(content);
  assertRequestedAssetCounts(assets, params.contentPackage);

  return assets;
}
