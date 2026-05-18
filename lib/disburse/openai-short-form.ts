import 'server-only';

import { type ShortFormClipLengthValue } from '@/lib/disburse/short-form-setup-config';
import {
  parseRankedClipCandidatesContent,
  type RankedClipCandidate,
} from '@/lib/disburse/openai-short-form-parser';

export type { RankedClipCandidate } from '@/lib/disburse/openai-short-form-parser';

export const DEFAULT_OPENAI_SHORT_FORM_MODEL = 'gpt-4.1-mini';

export type ClipCandidateWindow = {
  id: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  transcriptExcerpt: string;
};

function getRequiredEnvVar(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} environment variable is not set.`);
  }

  return value;
}

export function getOpenAiShortFormModel() {
  return process.env.OPENAI_SHORT_FORM_MODEL?.trim() || DEFAULT_OPENAI_SHORT_FORM_MODEL;
}
async function requestShortFormRankingContent(params: {
  sourceTitle: string;
  generationInstructions?: string | null;
  clipLength: ShortFormClipLengthValue;
  targetClipDurationMs: {
    min: number;
    max: number;
  };
  autoHookEnabled: boolean;
  windows: ClipCandidateWindow[];
  targetCandidateRange: {
    min: number;
    max: number;
  };
  retryMode?: 'strict_json';
}) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getRequiredEnvVar('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: getOpenAiShortFormModel(),
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content:
            params.retryMode === 'strict_json'
              ? 'You are ranking short-form clip candidates for creators. Select strong and solid usable self-contained moments for short-form distribution. Ground every output in the provided transcript windows. Return one unescaped JSON object only. Do not wrap the JSON in markdown. Do not escape the entire object as a string.'
              : 'You are ranking short-form clip candidates for creators. Select strong and solid usable self-contained moments for short-form distribution. Ground every output in the provided transcript windows. Do not invent quotes, facts, or context outside the text. Return valid JSON only.',
        },
        {
          role: 'user',
          content: [
            `Source title: ${params.sourceTitle}`,
            `Choose ${params.targetCandidateRange.min} to ${params.targetCandidateRange.max} clip windows for TikTok, YouTube Shorts, and Reels when enough usable moments exist.`,
            `Selected clip length preset: ${params.clipLength}.`,
            `Prefer windows between ${Math.round(params.targetClipDurationMs.min / 1000)} and ${Math.round(params.targetClipDurationMs.max / 1000)} seconds.`,
            params.autoHookEnabled
              ? 'Prioritize moments with a strong opening hook, a self-contained idea, a clear payoff, and high likelihood of watch retention. Write a short text hook for each candidate.'
              : 'Prioritize moments with a self-contained idea, a clear payoff, and high likelihood of watch retention. Set "hook" to an empty string for every candidate.',
            params.generationInstructions
              ? `Creator setup preferences:\n${params.generationInstructions}`
              : null,
            params.retryMode === 'strict_json'
              ? 'Your last response was not parseable. Return only one raw JSON object matching the required shape.'
              : null,
            'Include solid B+ candidates too; the creator will review and reject weaker options later.',
            'Avoid windows that need outside context, housekeeping, dead air, or incomplete setups.',
            'Return candidates ranked from strongest to weakest.',
            'Return JSON with this shape:',
            '{"candidates":[{"windowId":"window-1","hook":"...","title":"...","captionCopy":"...","summary":"...","whyItWorks":"...","platformFit":"...","confidence":82}]}',
            'Windows:',
            JSON.stringify(params.windows),
          ].filter(Boolean).join('\n'),
        },
      ],
    }),
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
      apiMessage || `OpenAI short-form generation failed with status ${response.status}.`
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
    throw new Error('OpenAI short-form generation returned an unexpected response.');
  }

  return content;
}

export async function rankShortFormClipWindows(params: {
  sourceTitle: string;
  generationInstructions?: string | null;
  clipLength: ShortFormClipLengthValue;
  targetClipDurationMs: {
    min: number;
    max: number;
  };
  autoHookEnabled: boolean;
  windows: ClipCandidateWindow[];
  targetCandidateRange: {
    min: number;
    max: number;
  };
}) {
  const content = await requestShortFormRankingContent(params);

  try {
    return parseRankedClipCandidatesContent(content);
  } catch (error) {
    console.warn('short_form_generation.retry_strict_json', {
      error: error instanceof Error ? error.message : 'Unknown parse error.',
      model: getOpenAiShortFormModel(),
    });
  }

  const retryContent = await requestShortFormRankingContent({
    ...params,
    retryMode: 'strict_json',
  });

  return parseRankedClipCandidatesContent(retryContent);
}
