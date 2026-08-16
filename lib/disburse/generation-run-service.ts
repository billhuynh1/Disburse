import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { generationRuns } from '@/lib/db/schema';
import {
  parseGenerationSnapshot,
  serializeGenerationSnapshot,
  type GenerationSnapshotV1,
} from '@/lib/disburse/generation-snapshot';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbExecutor = typeof db | DbTransaction;

export class GenerationRunNotFoundError extends Error {
  constructor(generationRunId: string, contentPackId?: number) {
    super(
      contentPackId === undefined
        ? `Generation run ${generationRunId} was not found.`
        : `Generation run ${generationRunId} was not found for content pack ${contentPackId}.`
    );
    this.name = 'GenerationRunNotFoundError';
  }
}

export class GenerationRunSnapshotTemplateMismatchError extends Error {
  constructor(generationRunId: string) {
    super(
      `Generation run ${generationRunId} has conflicting selected brand template provenance.`
    );
    this.name = 'GenerationRunSnapshotTemplateMismatchError';
  }
}

export function createGenerationRunId() {
  return randomUUID();
}

export function isStaleGenerationRun(
  currentGenerationRunId: string | null | undefined,
  expectedGenerationRunId: string | null | undefined
) {
  return Boolean(
    currentGenerationRunId &&
      expectedGenerationRunId &&
      currentGenerationRunId !== expectedGenerationRunId
  );
}

export async function insertGenerationRun(
  params: {
    generationRunId: string;
    contentPackId: number;
    selectedBrandTemplateId: number | null;
    snapshot: GenerationSnapshotV1;
  },
  executor: DbExecutor = db
) {
  const snapshot = serializeGenerationSnapshot(params.snapshot);
  if (snapshot.brandTemplateId !== params.selectedBrandTemplateId) {
    throw new GenerationRunSnapshotTemplateMismatchError(params.generationRunId);
  }

  const [generationRun] = await executor
    .insert(generationRuns)
    .values({
      id: params.generationRunId,
      contentPackId: params.contentPackId,
      selectedBrandTemplateId: params.selectedBrandTemplateId,
      snapshot,
    })
    .returning();

  return generationRun!;
}

export async function loadGenerationRun(
  params: { generationRunId: string; contentPackId?: number },
  executor: DbExecutor = db
) {
  const condition = params.contentPackId === undefined
    ? eq(generationRuns.id, params.generationRunId)
    : and(
        eq(generationRuns.id, params.generationRunId),
        eq(generationRuns.contentPackId, params.contentPackId)
      );
  const [generationRun] = await executor
    .select()
    .from(generationRuns)
    .where(condition)
    .limit(1);

  if (!generationRun) {
    throw new GenerationRunNotFoundError(params.generationRunId, params.contentPackId);
  }

  const snapshot = parseGenerationSnapshot(generationRun.snapshot);
  if (
    generationRun.selectedBrandTemplateId !== null &&
    snapshot.brandTemplateId !== generationRun.selectedBrandTemplateId
  ) {
    throw new GenerationRunSnapshotTemplateMismatchError(params.generationRunId);
  }

  return { ...generationRun, snapshot };
}

export async function loadGenerationSnapshot(
  params: { generationRunId: string; contentPackId?: number },
  executor: DbExecutor = db
) {
  const generationRun = await loadGenerationRun(params, executor);
  return generationRun.snapshot;
}

/**
 * A generation is snapshot-backed only when its immutable run record exists.
 * Legacy generation ids deliberately have no row until the Phase D cutover.
 */
export async function loadGenerationSnapshotIfPresent(
  params: { generationRunId: string; contentPackId: number },
  executor: DbExecutor = db
) {
  const [generationRun] = await executor
    .select()
    .from(generationRuns)
    .where(and(
      eq(generationRuns.id, params.generationRunId),
      eq(generationRuns.contentPackId, params.contentPackId)
    ))
    .limit(1);

  if (!generationRun) return null;

  return {
    ...generationRun,
    snapshot: parseGenerationSnapshot(generationRun.snapshot),
  };
}
