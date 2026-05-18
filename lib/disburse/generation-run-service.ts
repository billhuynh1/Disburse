import { randomUUID } from 'node:crypto';

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
