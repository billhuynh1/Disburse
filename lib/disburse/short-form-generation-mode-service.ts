import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { contentPacks, generationRuns } from '@/lib/db/schema';
import { parseGenerationSnapshot, type GenerationSnapshotV1 } from '@/lib/disburse/generation-snapshot';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbExecutor = typeof db | DbTransaction;

export type ShortFormGenerationMode =
  | { kind: 'legacy' }
  | { kind: 'snapshot'; snapshot: GenerationSnapshotV1 }
  | { kind: 'invalid_snapshot_reference'; code: string };

/**
 * This is the only compatibility boundary between pre-snapshot generations and
 * snapshot-backed generations. A persisted snapshot marker prevents a deleted
 * or mismatched generation_runs row from silently acquiring legacy semantics.
 */
export async function classifyShortFormGenerationMode(
  params: { generationRunId: string; contentPackId: number },
  executor: DbExecutor = db
): Promise<ShortFormGenerationMode> {
  const [pack] = await executor
    .select({ id: contentPacks.id, generationRunId: contentPacks.generationRunId, mode: contentPacks.shortFormGenerationMode })
    .from(contentPacks)
    .where(eq(contentPacks.id, params.contentPackId))
    .limit(1);

  if (!pack) {
    return { kind: 'invalid_snapshot_reference', code: 'generation_snapshot_ownership_mismatch' };
  }

  if (pack.mode === 'legacy') {
    return { kind: 'legacy' };
  }

  if (pack.generationRunId !== params.generationRunId) {
    return { kind: 'invalid_snapshot_reference', code: 'generation_snapshot_ownership_mismatch' };
  }

  if (pack.mode !== 'snapshot') {
    return { kind: 'invalid_snapshot_reference', code: 'generation_snapshot_mode_invalid' };
  }

  const [exactRun] = await executor
    .select()
    .from(generationRuns)
    .where(and(
      eq(generationRuns.id, params.generationRunId),
      eq(generationRuns.contentPackId, params.contentPackId)
    ))
    .limit(1);

  if (exactRun) {
    try {
      return { kind: 'snapshot', snapshot: parseGenerationSnapshot(exactRun.snapshot) };
    } catch {
      return { kind: 'invalid_snapshot_reference', code: 'generation_snapshot_invalid_requires_regeneration' };
    }
  }

  const [foreignRun] = await executor
    .select({ contentPackId: generationRuns.contentPackId })
    .from(generationRuns)
    .where(eq(generationRuns.id, params.generationRunId))
    .limit(1);
  if (foreignRun) {
    return { kind: 'invalid_snapshot_reference', code: 'generation_snapshot_ownership_mismatch' };
  }

  return { kind: 'invalid_snapshot_reference', code: 'generation_snapshot_missing_requires_regeneration' };
}

export function requireSnapshotGenerationMode(
  mode: ShortFormGenerationMode
): Extract<ShortFormGenerationMode, { kind: 'snapshot' }> {
  if (mode.kind !== 'snapshot') {
    throw new Error(mode.kind === 'legacy'
      ? 'snapshot_render_config_required'
      : mode.code);
  }
  return mode;
}
