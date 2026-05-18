import { z } from 'zod';

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
        hook: z.string().max(280).transform((value) => value.trim()),
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

function normalizeEscapedJsonObject(content: string) {
  return content
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function parseJsonCandidatePayload(content: string) {
  const rawJson = extractJsonObject(content);
  const attempts = [rawJson];
  const normalizedEscapedJson = normalizeEscapedJsonObject(rawJson);

  if (normalizedEscapedJson !== rawJson) {
    attempts.push(normalizedEscapedJson);
  }

  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);

      if (typeof parsed === 'string') {
        return JSON.parse(extractJsonObject(parsed));
      }

      return parsed;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('OpenAI short-form generation returned invalid JSON.');
}

export function parseRankedClipCandidatesContent(content: string) {
  const parsed = responseSchema.safeParse(parseJsonCandidatePayload(content));

  if (!parsed.success) {
    throw new Error('OpenAI short-form generation returned invalid structured data.');
  }

  return parsed.data.candidates satisfies RankedClipCandidate[];
}
