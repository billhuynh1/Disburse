import { z } from 'zod';

import { JobRecoveryMode } from '@/lib/db/schema';

export const MAX_RECOVERY_REQUEST_BYTES = 16 * 1024;

export class RecoveryRequestBodyError extends Error {
  constructor(
    public readonly code: 'body_too_large' | 'invalid_json' | 'invalid_body'
  ) {
    super(code === 'body_too_large' ? 'Recovery request body is too large.' : 'Invalid recovery request.');
    this.name = 'RecoveryRequestBodyError';
  }
}

export const recoveryRequestBodySchema = z.object({
  mode: z.nativeEnum(JobRecoveryMode),
  idempotencyKey: z.string().trim().min(1).max(200),
  expectedCurrentGeneration: z.string().trim().min(1).max(200).optional(),
}).strict();

export type RecoveryRequestBody = z.infer<typeof recoveryRequestBodySchema>;

export async function readBoundedJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RECOVERY_REQUEST_BYTES) {
    throw new RecoveryRequestBodyError('body_too_large');
  }
  if (!request.body) throw new RecoveryRequestBodyError('invalid_body');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RECOVERY_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RecoveryRequestBodyError('body_too_large');
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined));
  } catch {
    throw new RecoveryRequestBodyError('invalid_json');
  }
}

export async function parseRecoveryRequestBody(request: Request) {
  const raw = await readBoundedJsonBody(request);
  const parsed = recoveryRequestBodySchema.safeParse(raw);
  if (!parsed.success) throw new RecoveryRequestBodyError('invalid_body');
  return parsed.data;
}

export function buildSafeRecoveryAuditMetadata(
  input: unknown
): Record<string, string | number | boolean | null> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  return {
    hasMode: typeof value.mode === 'string',
    hasIdempotencyKey: typeof value.idempotencyKey === 'string',
    hasExpectedCurrentGeneration:
      typeof value.expectedCurrentGeneration === 'string',
  };
}
