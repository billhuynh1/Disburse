import 'server-only';

import { z } from 'zod';

export const DEFAULT_OPENAI_SHORT_FORM_MODEL = 'gpt-4.1-mini';

export type ClipCandidateWindow = {
  id: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  transcriptExcerpt: string;
};

export type RankedClipCandidate = {
  windowId: string;
  hook: string;
  title: string;
  captionCopy: string;
  summary: string;
  whyItWorks: string;
  platformFit: string;
  confidence: number;
};

const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        windowId: z.string().trim().min(1),
        hook: z.string().trim().min(1).max(280),
        title: z.string().trim().min(1).max(150),
        captionCopy: z.string().trim().min(1).max(2000),
        summary: z.string().trim().min(1).max(1000),
        whyItWorks: z.string().trim().min(1).max(1000),
        platformFit: z.string().trim().min(1).max(500),
        confidence: z.number().int().min(0).max(100),
      })
    )
    .min(1),
});

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

  throw new Error('OpenAI short-form generation did not return JSON.');
}

export async function rankShortFormClipWindows(params: {
  sourceTitle: string;
  windows: ClipCandidateWindow[];
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
            'You are ranking short-form clip candidates for creators. Select only the strongest self-contained moments for short-form distribution. Ground every output in the provided transcript windows. Do not invent quotes, facts, or context outside the text. Return valid JSON only.',
        },
        {
          role: 'user',
          content: [
            `Source title: ${params.sourceTitle}`,
            'Choose the best 5 to 8 clip windows for TikTok, YouTube Shorts, and Reels.',
            'Prioritize moments with a strong opening hook, a self-contained idea, a clear payoff, and high likelihood of watch retention.',
            'Avoid windows that need outside context, housekeeping, dead air, or incomplete setups.',
            'Return JSON with this shape:',
            '{"candidates":[{"windowId":"window-1","hook":"...","title":"...","captionCopy":"...","summary":"...","whyItWorks":"...","platformFit":"...","confidence":82}]}',
            'Windows:',
            JSON.stringify(params.windows),
          ].join('\n'),
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

  const parsed = responseSchema.safeParse(JSON.parse(extractJsonObject(content)));

  if (!parsed.success) {
    throw new Error('OpenAI short-form generation returned invalid structured data.');
  }

  return parsed.data.candidates satisfies RankedClipCandidate[];
}
