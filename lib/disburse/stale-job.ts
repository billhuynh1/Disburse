export const StaleJobReason = {
  PROJECT_DELETED: 'project_deleted',
  SOURCE_ASSET_DELETED: 'source_asset_deleted',
  CLIP_CANDIDATE_MISSING: 'clip_candidate_missing',
  EDIT_CONFIG_MISSING: 'edit_config_missing',
  GENERATION_RUN_STALE: 'generation_run_stale',
  STORAGE_OBJECT_MISSING: 'storage_object_missing',
  ARTIFACT_REPLACED: 'artifact_replaced',
  CONTENT_PACK_MISSING: 'content_pack_missing',
} as const;

export type StaleJobReason =
  (typeof StaleJobReason)[keyof typeof StaleJobReason];

export class StaleJobError extends Error {
  readonly staleReason: StaleJobReason;

  constructor(staleReason: StaleJobReason, message?: string) {
    super(message ?? staleReason);
    this.name = 'StaleJobError';
    this.staleReason = staleReason;
  }
}

export function isStaleJobError(error: unknown): error is StaleJobError {
  return error instanceof StaleJobError;
}
