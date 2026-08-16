import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: varchar('role', { length: 20 }).notNull().default('member'),
  storageLimitBytes: bigint('storage_limit_bytes', { mode: 'number' }),
  autoSaveApprovedClipsEnabled: boolean('auto_save_approved_clips_enabled')
    .notNull()
    .default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

export const teams = pgTable('teams', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  stripeProductId: text('stripe_product_id'),
  planName: varchar('plan_name', { length: 50 }),
  subscriptionStatus: varchar('subscription_status', { length: 20 }),
});

export const teamMembers = pgTable('team_members', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  role: varchar('role', { length: 50 }).notNull(),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
});

export const activityLogs = pgTable('activity_logs', {
  id: serial('id').primaryKey(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  userId: integer('user_id').references(() => users.id),
  action: text('action').notNull(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  ipAddress: varchar('ip_address', { length: 45 }),
});

export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    type: varchar('type', { length: 50 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    title: varchar('title', { length: 150 }).notNull(),
    message: text('message').notNull(),
    entityType: varchar('entity_type', { length: 50 }),
    entityId: integer('entity_id'),
    actionUrl: text('action_url'),
    dedupeKey: text('dedupe_key').notNull(),
    readAt: timestamp('read_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userReadCreatedIdx: index('notifications_user_read_created_idx').on(
      table.userId,
      table.readAt,
      table.createdAt
    ),
    typeStatusIdx: index('notifications_type_status_idx').on(
      table.type,
      table.status
    ),
    dedupeKeyIdx: uniqueIndex('notifications_dedupe_key_idx').on(table.dedupeKey),
  })
);

export const invitations = pgTable('invitations', {
  id: serial('id').primaryKey(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 50 }).notNull(),
  invitedBy: integer('invited_by')
    .notNull()
    .references(() => users.id),
  invitedAt: timestamp('invited_at').notNull().defaultNow(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
});

export const projects = pgTable(
  'projects',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    name: varchar('name', { length: 150 }).notNull(),
    description: text('description'),
    isSaved: boolean('is_saved').notNull().default(false),
    expiresAt: timestamp('expires_at'),
    savedAt: timestamp('saved_at'),
    deletionRequestedAt: timestamp('deletion_requested_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    temporaryExpiryIdx: index('projects_temporary_expiry_idx').on(
      table.isSaved,
      table.expiresAt
    ),
  })
);

export const sourceAssets = pgTable(
  'source_assets',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    title: varchar('title', { length: 150 }).notNull(),
    assetType: varchar('asset_type', { length: 50 }).notNull(),
    originalFilename: varchar('original_filename', { length: 255 }),
    mimeType: varchar('mime_type', { length: 100 }),
    storageKey: text('storage_key').unique(),
    storageUrl: text('storage_url').notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
    thumbnailStorageKey: text('thumbnail_storage_key').unique(),
    thumbnailMimeType: varchar('thumbnail_mime_type', { length: 100 }),
    thumbnailWidth: integer('thumbnail_width'),
    thumbnailHeight: integer('thumbnail_height'),
    status: varchar('status', { length: 20 }).notNull().default('uploaded'),
    retentionStatus: varchar('retention_status', { length: 20 }),
    expiresAt: timestamp('expires_at'),
    savedAt: timestamp('saved_at'),
    deletedAt: timestamp('deleted_at'),
    storageDeletedAt: timestamp('storage_deleted_at'),
    deletionRequestedAt: timestamp('deletion_requested_at'),
    deletionReason: text('deletion_reason'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    retentionExpiryIdx: index('source_assets_retention_expiry_idx').on(
      table.retentionStatus,
      table.expiresAt
    ),
  })
);

export const sourceUploadSessions = pgTable(
  'source_upload_sessions',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    idempotencyKey: text('idempotency_key').notNull(),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    uploadId: text('upload_id').notNull(),
    partSizeBytes: bigint('part_size_bytes', { mode: 'number' }).notNull(),
    totalParts: integer('total_parts').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('uploading'),
    sourceAssetId: integer('source_asset_id').references(() => sourceAssets.id),
    failureReason: text('failure_reason'),
    completedAt: timestamp('completed_at'),
    abortedAt: timestamp('aborted_at'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userProjectIdempotencyIdx: uniqueIndex(
      'source_upload_sessions_user_project_idempotency_idx'
    ).on(table.userId, table.projectId, table.idempotencyKey),
    statusUpdatedAtIdx: index('source_upload_sessions_status_updated_at_idx').on(
      table.status,
      table.updatedAt
    ),
  })
);

export const sourceUploadParts = pgTable(
  'source_upload_parts',
  {
    id: serial('id').primaryKey(),
    uploadSessionId: integer('upload_session_id')
      .notNull()
      .references(() => sourceUploadSessions.id),
    partNumber: integer('part_number').notNull(),
    byteStart: bigint('byte_start', { mode: 'number' }).notNull(),
    byteEnd: bigint('byte_end', { mode: 'number' }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    etag: text('etag').notNull(),
    checksumSha256: text('checksum_sha256'),
    status: varchar('status', { length: 20 }).notNull().default('uploaded'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    sessionPartIdx: uniqueIndex('source_upload_parts_session_part_idx').on(
      table.uploadSessionId,
      table.partNumber
    ),
  })
);

export const sourceAssetThumbnailVariants = pgTable(
  'source_asset_thumbnail_variants',
  {
    id: serial('id').primaryKey(),
    sourceAssetId: integer('source_asset_id')
      .notNull()
      .references(() => sourceAssets.id),
    variant: varchar('variant', { length: 50 }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    sourceAssetVariantIdx: uniqueIndex(
      'source_asset_thumbnail_variants_source_asset_variant_idx'
    ).on(table.sourceAssetId, table.variant),
  })
);

export const transcripts = pgTable('transcripts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  sourceAssetId: integer('source_asset_id')
    .notNull()
    .references(() => sourceAssets.id)
    .unique(),
  language: varchar('language', { length: 20 }),
  content: text('content'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    id: serial('id').primaryKey(),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    sequence: integer('sequence').notNull(),
    startTimeMs: integer('start_time_ms').notNull(),
    endTimeMs: integer('end_time_ms').notNull(),
    text: text('text').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    transcriptSequenceIdx: index('transcript_segments_transcript_sequence_idx').on(
      table.transcriptId,
      table.sequence
    ),
    transcriptTimingIdx: index('transcript_segments_transcript_timing_idx').on(
      table.transcriptId,
      table.startTimeMs
    ),
  })
);

export const transcriptWords = pgTable(
  'transcript_words',
  {
    id: serial('id').primaryKey(),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    sequence: integer('sequence').notNull(),
    startTimeMs: integer('start_time_ms').notNull(),
    endTimeMs: integer('end_time_ms').notNull(),
    text: text('text').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    transcriptSequenceIdx: index('transcript_words_transcript_sequence_idx').on(
      table.transcriptId,
      table.sequence
    ),
    transcriptTimingIdx: index('transcript_words_transcript_timing_idx').on(
      table.transcriptId,
      table.startTimeMs
    ),
  })
);

export type TranscribeSourceAssetJobPayload = {
  sourceAssetId: number;
  userId: number;
};

export type ExtractSourceAssetThumbnailJobPayload = {
  sourceAssetId: number;
  userId: number;
};

export type IngestYoutubeSourceAssetJobPayload = {
  sourceAssetId: number;
  userId: number;
};

export type GenerateShortFormPackJobPayload = {
  contentPackId: number;
  sourceAssetId: number;
  transcriptId?: number;
  userId: number;
  generationRunId: string;
  brandTemplateId?: number;
  reconciliationRebuild?: {
    originalGenerationRunId: string;
    reason: 'clip_candidate_missing';
  };
};

export type RenderClipCandidateJobPayload = {
  clipCandidateId: number;
  contentPackId: number;
  sourceAssetId: number;
  userId: number;
  generationRunId: string;
  captionsEnabled?: boolean;
  captionFontAssetId?: number;
};

export type FormatRenderedClipShortFormJobPayload = {
  clipCandidateId: number;
  contentPackId: number;
  sourceAssetId: number;
  userId: number;
  generationRunId: string;
  renderConfigId?: number;
  editConfigId?: number;
  variant?: RenderedClipVariant;
  layout?: RenderedClipLayout;
  captionsEnabled?: boolean;
  captionFontAssetId?: number;
  editConfigHash?: string;
};

export type DetectClipFacecamJobPayload = {
  videoId?: number;
  sourceAssetId: number;
  userId: number;
  contentPackId?: number;
  clipCandidateId?: number;
  generationRunId?: string;
  startTimeMs?: number;
  endTimeMs?: number;
  detectorVersion?: string;
  detectionRunId?: number;
};

export type PublishRenderedClipJobPayload = {
  clipPublicationId: number;
  renderedClipId: number;
  linkedAccountId: number;
  userId: number;
  platform: 'youtube' | 'tiktok';
};

export type JobPayload =
  | TranscribeSourceAssetJobPayload
  | ExtractSourceAssetThumbnailJobPayload
  | IngestYoutubeSourceAssetJobPayload
  | GenerateShortFormPackJobPayload
  | RenderClipCandidateJobPayload
  | FormatRenderedClipShortFormJobPayload
  | DetectClipFacecamJobPayload
  | PublishRenderedClipJobPayload;

export const jobs = pgTable(
  'jobs',
  {
    id: serial('id').primaryKey(),
    type: varchar('type', { length: 50 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').$type<JobPayload>().notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    availableAt: timestamp('available_at').notNull().defaultNow(),
    startedAt: timestamp('started_at'),
    heartbeatAt: timestamp('heartbeat_at'),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at'),
    completedAt: timestamp('completed_at'),
    cancellationReason: varchar('cancellation_reason', { length: 40 }),
    cancellationRequestedAt: timestamp('cancellation_requested_at'),
    failureReason: text('failure_reason'),
    failureCode: varchar('failure_code', { length: 80 }),
    failureClass: varchar('failure_class', { length: 40 }),
    logicalJobKey: text('logical_job_key'),
    rootJobId: integer('root_job_id').references(
      (): AnyPgColumn => jobs.id,
      { onDelete: 'set null' }
    ),
    parentJobId: integer('parent_job_id').references(
      (): AnyPgColumn => jobs.id,
      { onDelete: 'set null' }
    ),
    recoveryAttempt: integer('recovery_attempt').notNull().default(0),
    recoveryMode: varchar('recovery_mode', { length: 30 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    pendingLookupIdx: index('jobs_pending_lookup_idx').on(
      table.status,
      table.availableAt,
      table.createdAt
    ),
    typeStatusIdx: index('jobs_type_status_idx').on(table.type, table.status),
    leaseExpiryIdx: index('jobs_lease_expiry_idx').on(table.status, table.leaseExpiresAt),
    idempotencyKeyIdx: uniqueIndex('jobs_idempotency_key_idx').on(
      table.idempotencyKey
    ),
    activeLogicalJobIdx: uniqueIndex('jobs_active_logical_job_idx')
      .on(table.logicalJobKey)
      .where(
        sql`${table.logicalJobKey} is not null and ${table.status} in ('pending', 'processing')`
      ),
  })
);

export const jobRecoveryRequests = pgTable(
  'job_recovery_requests',
  {
    id: serial('id').primaryKey(),
    idempotencyIdentity: text('idempotency_identity').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    requestedUserId: integer('requested_user_id'),
    requestedJobId: integer('requested_job_id'),
    requestedMode: varchar('requested_mode', { length: 30 }),
    expectedCurrentGeneration: text('expected_current_generation'),
    outcome: varchar('outcome', { length: 20 }).notNull(),
    outcomeCode: varchar('outcome_code', { length: 80 }).notNull(),
    successorJobId: integer('successor_job_id').references(() => jobs.id, {
      onDelete: 'set null',
    }),
    safeMetadata: jsonb('safe_metadata')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    identityIdx: uniqueIndex('job_recovery_requests_identity_idx').on(
      table.idempotencyIdentity
    ),
    requestedJobIdx: index('job_recovery_requests_requested_job_idx').on(
      table.requestedJobId,
      table.createdAt
    ),
  })
);

export const jobRecoveryEvents = pgTable(
  'job_recovery_events',
  {
    id: serial('id').primaryKey(),
    requestIdentity: text('request_identity').notNull(),
    requestedJobId: integer('requested_job_id'),
    eventType: varchar('event_type', { length: 30 }).notNull(),
    outcomeCode: varchar('outcome_code', { length: 80 }).notNull(),
    safeMetadata: jsonb('safe_metadata')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    requestIdx: index('job_recovery_events_request_idx').on(
      table.requestIdentity,
      table.createdAt
    ),
  })
);

export const jobEffectCheckpoints = pgTable(
  'job_effect_checkpoints',
  {
    id: serial('id').primaryKey(),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    effectKey: text('effect_key').notNull(),
    jobType: varchar('job_type', { length: 50 }).notNull(),
    status: varchar('status', { length: 30 }).notNull(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    externalEffectStartedAt: timestamp('external_effect_started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    jobEffectIdx: uniqueIndex('job_effect_checkpoints_job_effect_idx').on(
      table.jobId,
      table.effectKey
    ),
    statusIdx: index('job_effect_checkpoints_status_idx').on(table.status),
  })
);

export const pipelineSchedulerState = pgTable(
  'pipeline_scheduler_state',
  {
    id: integer('id').primaryKey().default(1),
    ownerToken: text('owner_token'),
    leaseExpiresAt: timestamp('lease_expires_at'),
    heartbeatAt: timestamp('heartbeat_at'),
    reconciliationCursor: integer('reconciliation_cursor'),
    reconciliationCycle: bigint('reconciliation_cycle', { mode: 'number' })
      .notNull()
      .default(0),
    reconciliationProgressAt: timestamp('reconciliation_progress_at'),
    reconciliationProgressCount: bigint('reconciliation_progress_count', { mode: 'number' })
      .notNull()
      .default(0),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    singletonCheck: check('pipeline_scheduler_state_singleton_check', sql`${table.id} = 1`),
  })
);

export const operationalSignals = pgTable(
  'operational_signals',
  {
    id: serial('id').primaryKey(),
    signalType: varchar('signal_type', { length: 40 }).notNull(),
    provider: varchar('provider', { length: 20 }),
    failureClass: varchar('failure_class', { length: 30 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    typeCreatedIdx: index('operational_signals_type_created_idx').on(table.signalType, table.createdAt),
    typeCheck: check('operational_signals_type_check', sql`${table.signalType} in ('internal_trigger_failure', 'provider_failure', 'capacity_blocked', 'unknown_failure')`),
    providerCheck: check('operational_signals_provider_check', sql`${table.provider} is null or ${table.provider} in ('openai', 's3', 'media', 'render', 'facecam')`),
    classCheck: check('operational_signals_failure_class_check', sql`${table.failureClass} is null or ${table.failureClass} in ('transient', 'safe_retry', 'permanent', 'ambiguous_external_effect', 'cancellation', 'unknown')`),
  })
);

export const operationalInvocations = pgTable(
  'operational_invocations',
  {
    id: serial('id').primaryKey(),
    invocationId: varchar('invocation_id', { length: 36 }).notNull(),
    origin: varchar('origin', { length: 20 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    stopReason: varchar('stop_reason', { length: 40 }),
    failureClass: varchar('failure_class', { length: 30 }),
    failureCode: varchar('failure_code', { length: 80 }),
    processedJobs: integer('processed_jobs').notNull().default(0),
    recoveredJobs: integer('recovered_jobs').notNull().default(0),
    reconciledProjects: integer('reconciled_projects').notNull().default(0),
    reconciliationCycle: bigint('reconciliation_cycle', { mode: 'number' }),
    followUpTriggered: boolean('follow_up_triggered').notNull().default(false),
    durationMs: integer('duration_ms'),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    invocationIdIdx: uniqueIndex('operational_invocations_invocation_id_idx').on(
      table.invocationId
    ),
    originStartedIdx: index('operational_invocations_origin_started_idx').on(
      table.origin,
      table.startedAt
    ),
    statusStartedIdx: index('operational_invocations_status_started_idx').on(
      table.status,
      table.startedAt
    ),
    originCheck: check(
      'operational_invocations_origin_check',
      sql`${table.origin} in ('internal', 'cron')`
    ),
    statusCheck: check(
      'operational_invocations_status_check',
      sql`${table.status} in ('running', 'completed', 'failed')`
    ),
    countsCheck: check(
      'operational_invocations_counts_check',
      sql`${table.processedJobs} >= 0 and ${table.recoveredJobs} >= 0 and ${table.reconciledProjects} >= 0`
    ),
  })
);

export const contentPacks = pgTable('content_packs', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id),
  sourceAssetId: integer('source_asset_id')
    .notNull()
    .references(() => sourceAssets.id),
  transcriptId: integer('transcript_id').references(() => transcripts.id),
  kind: varchar('kind', { length: 50 }).notNull().default('general'),
  name: varchar('name', { length: 150 }).notNull(),
  instructions: text('instructions'),
  generationRunId: text('generation_run_id').notNull(),
  shortFormGenerationMode: varchar('short_form_generation_mode', { length: 20 })
    .notNull()
    .default('legacy'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const generationRuns = pgTable(
  'generation_runs',
  {
    id: text('id').primaryKey(),
    contentPackId: integer('content_pack_id')
      .notNull()
      .references(() => contentPacks.id, { onDelete: 'cascade' }),
    selectedBrandTemplateId: integer('selected_brand_template_id').references(
      () => brandTemplates.id,
      { onDelete: 'set null' }
    ),
    snapshot: jsonb('snapshot').$type<unknown>().notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    contentPackCreatedIdx: index('generation_runs_content_pack_created_idx').on(
      table.contentPackId,
      table.createdAt
    ),
    selectedBrandTemplateIdx: index(
      'generation_runs_selected_brand_template_idx'
    ).on(table.selectedBrandTemplateId),
    snapshotObjectCheck: check(
      'generation_runs_snapshot_object_check',
      sql`jsonb_typeof(${table.snapshot}) = 'object'`
    ),
  })
);

export const clipCandidates = pgTable(
  'clip_candidates',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    contentPackId: integer('content_pack_id')
      .notNull()
      .references(() => contentPacks.id),
    sourceAssetId: integer('source_asset_id')
      .notNull()
      .references(() => sourceAssets.id),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    rank: integer('rank').notNull(),
    startTimeMs: integer('start_time_ms').notNull(),
    endTimeMs: integer('end_time_ms').notNull(),
    durationMs: integer('duration_ms').notNull(),
    hook: text('hook').notNull(),
    title: varchar('title', { length: 150 }).notNull(),
    captionCopy: text('caption_copy').notNull(),
    summary: text('summary').notNull(),
    transcriptExcerpt: text('transcript_excerpt').notNull(),
    whyItWorks: text('why_it_works').notNull(),
    platformFit: text('platform_fit').notNull(),
    confidence: integer('confidence').notNull(),
    generationRunId: text('generation_run_id').notNull(),
    currentRenderConfigId: integer('current_render_config_id').references(
      (): AnyPgColumn => clipRenderConfigs.id,
      { onDelete: 'set null' }
    ),
    reviewStatus: varchar('review_status', { length: 30 })
      .notNull()
      .default('pending'),
    facecamDetectionStatus: varchar('facecam_detection_status', { length: 20 })
      .notNull()
      .default('not_started'),
    facecamDetectionFailureReason: text('facecam_detection_failure_reason'),
    facecamDetectionDebugReason: text('facecam_detection_debug_reason'),
    facecamDetectedAt: timestamp('facecam_detected_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    contentPackRankIdx: index('clip_candidates_content_pack_rank_idx').on(
      table.contentPackId,
      table.rank
    ),
    sourceAssetIdx: index('clip_candidates_source_asset_idx').on(
      table.sourceAssetId
    ),
    currentRenderConfigIdx: uniqueIndex(
      'clip_candidates_current_render_config_idx'
    )
      .on(table.currentRenderConfigId)
      .where(sql`${table.currentRenderConfigId} is not null`),
  })
);

export const clipCandidateFacecamDetections = pgTable(
  'clip_candidate_facecam_detections',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    sourceAssetId: integer('source_asset_id')
      .notNull()
      .references(() => sourceAssets.id),
    clipCandidateId: integer('clip_candidate_id')
      .notNull()
      .references(() => clipCandidates.id),
    detectionRunId: integer('detection_run_id').references(
      () => clipCandidateFacecamDetectionRuns.id
    ),
    generationRunId: text('generation_run_id').notNull(),
    detectorVersion: text('detector_version').notNull().default('facecam_v1'),
    rank: integer('rank').notNull(),
    startTimeMs: integer('start_time_ms').notNull(),
    endTimeMs: integer('end_time_ms').notNull(),
    frameWidth: integer('frame_width').notNull(),
    frameHeight: integer('frame_height').notNull(),
    xPx: integer('x_px').notNull(),
    yPx: integer('y_px').notNull(),
    widthPx: integer('width_px').notNull(),
    heightPx: integer('height_px').notNull(),
    confidence: integer('confidence').notNull(),
    sampledFrameCount: integer('sampled_frame_count').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    clipCandidateIdx: index('clip_candidate_facecam_detections_candidate_idx').on(
      table.clipCandidateId
    ),
    candidateGenerationRunIdx: index(
      'clip_candidate_facecam_detections_candidate_generation_run_idx'
    ).on(table.clipCandidateId, table.generationRunId),
    sourceAssetIdx: index('clip_candidate_facecam_detections_source_asset_idx').on(
      table.sourceAssetId
    ),
    runRankIdx: uniqueIndex(
      'clip_candidate_facecam_detections_run_rank_idx'
    ).on(table.detectionRunId, table.rank),
  })
);

export const clipCandidateFacecamDetectionRuns = pgTable(
  'clip_candidate_facecam_detection_runs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    sourceAssetId: integer('source_asset_id')
      .notNull()
      .references(() => sourceAssets.id),
    contentPackId: integer('content_pack_id')
      .notNull()
      .references(() => contentPacks.id),
    clipCandidateId: integer('clip_candidate_id')
      .notNull()
      .references(() => clipCandidates.id),
    generationRunId: text('generation_run_id').notNull(),
    detectorVersion: text('detector_version').notNull().default('facecam_v1'),
    startTimeMs: integer('start_time_ms').notNull(),
    endTimeMs: integer('end_time_ms').notNull(),
    status: varchar('status', { length: 30 })
      .notNull()
      .default('pending'),
    failureReason: text('failure_reason'),
    debugReason: text('debug_reason'),
    sampledFrameCount: integer('sampled_frame_count'),
    detectionStage: text('detection_stage'),
    debugSummary: text('debug_summary'),
    jobId: integer('job_id').references(() => jobs.id),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    runKeyIdx: uniqueIndex(
      'clip_candidate_facecam_detection_runs_key_idx'
    ).on(
      table.sourceAssetId,
      table.clipCandidateId,
      table.generationRunId,
      table.startTimeMs,
      table.endTimeMs,
      table.detectorVersion
    ),
    candidateStatusIdx: index(
      'clip_candidate_facecam_detection_runs_candidate_status_idx'
    ).on(table.clipCandidateId, table.status),
    sourceAssetIdx: index(
      'clip_candidate_facecam_detection_runs_source_asset_idx'
    ).on(table.sourceAssetId),
  })
);

export const facecamSegments = pgTable(
  'facecam_segments',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    videoId: integer('video_id')
      .notNull()
      .references(() => sourceAssets.id),
    sourceAssetId: integer('source_asset_id')
      .notNull()
      .references(() => sourceAssets.id),
    rank: integer('rank').notNull(),
    startTimeMs: integer('start_time_ms').notNull(),
    endTimeMs: integer('end_time_ms').notNull(),
    frameWidth: integer('frame_width').notNull(),
    frameHeight: integer('frame_height').notNull(),
    xPx: integer('x_px').notNull(),
    yPx: integer('y_px').notNull(),
    widthPx: integer('width_px').notNull(),
    heightPx: integer('height_px').notNull(),
    confidence: integer('confidence').notNull(),
    layoutType: varchar('layout_type', { length: 40 }).notNull(),
    sampledFrameCount: integer('sampled_frame_count').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    videoTimingIdx: index('facecam_segments_video_timing_idx').on(
      table.videoId,
      table.startTimeMs,
      table.endTimeMs
    ),
    videoRankIdx: index('facecam_segments_video_rank_idx').on(
      table.videoId,
      table.rank
    ),
  })
);

export const clipEditConfigs = pgTable(
  'clip_edit_configs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    contentPackId: integer('content_pack_id')
      .notNull()
      .references(() => contentPacks.id),
    sourceAssetId: integer('source_asset_id')
      .notNull()
      .references(() => sourceAssets.id),
    clipCandidateId: integer('clip_candidate_id')
      .notNull()
      .references(() => clipCandidates.id),
    generationRunId: text('generation_run_id').notNull(),
    aspectRatio: varchar('aspect_ratio', { length: 20 })
      .notNull()
      .default('9_16'),
    layout: varchar('layout', { length: 40 })
      .notNull()
      .default('default'),
    layoutRatio: varchar('layout_ratio', { length: 20 }),
    captionsEnabled: boolean('captions_enabled').notNull().default(true),
    captionStyle: varchar('caption_style', { length: 40 })
      .notNull()
      .default('default'),
    captionFontAssetId: integer('caption_font_asset_id').references(
      () => reusableAssets.id
    ),
    captionFontFamily: varchar('caption_font_family', { length: 120 }),
    captionFontColor: varchar('caption_font_color', { length: 20 })
      .notNull()
      .default('#ffffff'),
    captionHighlightColor: varchar('caption_highlight_color', { length: 20 })
      .notNull()
      .default('#facc15'),
    captionPosition: varchar('caption_position', { length: 20 })
      .notNull()
      .default('bottom'),
    captionAnimation: varchar('caption_animation', { length: 20 })
      .notNull()
      .default('none'),
    brandTemplateId: integer('brand_template_id').references(
      () => brandTemplates.id
    ),
    overlayLogoAssetId: integer('overlay_logo_asset_id').references(
      () => reusableAssets.id
    ),
    ctaUrl: text('cta_url'),
    introVideoAssetId: integer('intro_video_asset_id').references(
      () => reusableAssets.id
    ),
    outroVideoAssetId: integer('outro_video_asset_id').references(
      () => reusableAssets.id
    ),
    cropSettings: jsonb('crop_settings')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    facecamDetectionId: integer('facecam_detection_id').references(
      () => clipCandidateFacecamDetections.id
    ),
    facecamDetected: boolean('facecam_detected').notNull().default(false),
    autoEditPreset: varchar('auto_edit_preset', { length: 80 })
      .notNull()
      .default('default_short_form_v1'),
    autoEditAppliedAt: timestamp('auto_edit_applied_at'),
    configVersion: integer('config_version').notNull().default(1),
    configHash: text('config_hash').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    clipCandidateIdx: uniqueIndex('clip_edit_configs_candidate_idx').on(
      table.clipCandidateId
    ),
    contentPackIdx: index('clip_edit_configs_content_pack_idx').on(
      table.contentPackId
    ),
    userUpdatedIdx: index('clip_edit_configs_user_updated_idx').on(
      table.userId,
      table.updatedAt
    ),
  })
);

export const clipRenderConfigs = pgTable(
  'clip_render_configs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    contentPackId: integer('content_pack_id')
      .notNull()
      .references(() => contentPacks.id),
    sourceAssetId: integer('source_asset_id')
      .notNull()
      .references(() => sourceAssets.id),
    clipCandidateId: integer('clip_candidate_id')
      .notNull()
      .references(() => clipCandidates.id),
    generationRunId: text('generation_run_id').notNull(),
    aspectRatio: varchar('aspect_ratio', { length: 20 })
      .notNull()
      .default('9_16'),
    layout: varchar('layout', { length: 40 })
      .notNull()
      .default('default'),
    layoutRatio: varchar('layout_ratio', { length: 20 }),
    captionsEnabled: boolean('captions_enabled').notNull().default(true),
    captionStyle: varchar('caption_style', { length: 40 })
      .notNull()
      .default('default'),
    captionFontAssetId: integer('caption_font_asset_id').references(
      () => reusableAssets.id
    ),
    captionFontFamily: varchar('caption_font_family', { length: 120 }),
    captionFontColor: varchar('caption_font_color', { length: 20 })
      .notNull()
      .default('#ffffff'),
    captionHighlightColor: varchar('caption_highlight_color', { length: 20 })
      .notNull()
      .default('#facc15'),
    captionPosition: varchar('caption_position', { length: 20 })
      .notNull()
      .default('bottom'),
    captionAnimation: varchar('caption_animation', { length: 20 })
      .notNull()
      .default('none'),
    brandTemplateId: integer('brand_template_id').references(
      () => brandTemplates.id
    ),
    overlayLogoAssetId: integer('overlay_logo_asset_id').references(
      () => reusableAssets.id
    ),
    ctaUrl: text('cta_url'),
    introVideoAssetId: integer('intro_video_asset_id').references(
      () => reusableAssets.id
    ),
    outroVideoAssetId: integer('outro_video_asset_id').references(
      () => reusableAssets.id
    ),
    cropSettings: jsonb('crop_settings')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    facecamDetectionId: integer('facecam_detection_id').references(
      () => clipCandidateFacecamDetections.id
    ),
    facecamDetected: boolean('facecam_detected').notNull().default(false),
    autoEditPreset: varchar('auto_edit_preset', { length: 80 })
      .notNull()
      .default('default_short_form_v1'),
    configHash: text('config_hash').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    clipCandidateIdx: index('clip_render_configs_candidate_idx').on(
      table.clipCandidateId
    ),
    contentPackIdx: index('clip_render_configs_content_pack_idx').on(
      table.contentPackId
    ),
    userUpdatedIdx: index('clip_render_configs_user_updated_idx').on(
      table.userId,
      table.updatedAt
    ),
    configIdx: uniqueIndex('clip_render_configs_candidate_layout_config_idx').on(
      table.clipCandidateId,
      table.aspectRatio,
      table.layout,
      table.configHash
    ),
  })
);

export const renderedClips = pgTable(
  'rendered_clips',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    contentPackId: integer('content_pack_id')
      .notNull()
      .references(() => contentPacks.id),
    sourceAssetId: integer('source_asset_id')
      .notNull()
      .references(() => sourceAssets.id),
    clipCandidateId: integer('clip_candidate_id')
      .notNull()
      .references(() => clipCandidates.id),
    generationRunId: text('generation_run_id').notNull(),
    variant: varchar('variant', { length: 40 })
      .notNull()
      .default('trimmed_original'),
    layout: varchar('layout', { length: 40 })
      .notNull()
      .default('default'),
    editConfigId: integer('edit_config_id').references(() => clipEditConfigs.id),
    clipRenderConfigId: integer('clip_render_config_id').references(
      () => clipRenderConfigs.id
    ),
    editConfigVersion: integer('edit_config_version'),
    editConfigHash: text('edit_config_hash'),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    title: varchar('title', { length: 150 }).notNull(),
    startTimeMs: integer('start_time_ms').notNull(),
    endTimeMs: integer('end_time_ms').notNull(),
    durationMs: integer('duration_ms').notNull(),
    storageKey: text('storage_key').unique(),
    storageUrl: text('storage_url'),
    mimeType: varchar('mime_type', { length: 100 }),
    fileSizeBytes: integer('file_size_bytes'),
    retentionStatus: varchar('retention_status', { length: 20 }),
    expiresAt: timestamp('expires_at'),
    savedAt: timestamp('saved_at'),
    deletedAt: timestamp('deleted_at'),
    storageDeletedAt: timestamp('storage_deleted_at'),
    deletionReason: text('deletion_reason'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    contentPackIdx: index('rendered_clips_content_pack_idx').on(
      table.contentPackId
    ),
    sourceAssetIdx: index('rendered_clips_source_asset_idx').on(
      table.sourceAssetId
    ),
    statusIdx: index('rendered_clips_status_idx').on(
      table.status,
      table.updatedAt
    ),
    retentionExpiryIdx: index('rendered_clips_retention_expiry_idx').on(
      table.retentionStatus,
      table.expiresAt
    ),
    candidateVariantLayoutIdx: uniqueIndex(
      'rendered_clips_candidate_variant_layout_config_idx'
    ).on(
      table.clipCandidateId,
      table.variant,
      table.layout,
      table.editConfigHash
    ),
    renderConfigIdx: uniqueIndex('rendered_clips_render_config_idx')
      .on(table.clipRenderConfigId)
      .where(sql`${table.clipRenderConfigId} is not null`),
  })
);

export const voiceProfiles = pgTable('voice_profiles', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  tone: varchar('tone', { length: 100 }),
  audience: varchar('audience', { length: 150 }),
  writingStyleNotes: text('writing_style_notes'),
  bannedPhrases: text('banned_phrases'),
  ctaStyle: varchar('cta_style', { length: 150 }),
  prompt: text('prompt').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const generatedAssets = pgTable('generated_assets', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  contentPackId: integer('content_pack_id')
    .notNull()
    .references(() => contentPacks.id),
  voiceProfileId: integer('voice_profile_id').references(() => voiceProfiles.id),
  assetType: varchar('asset_type', { length: 50 }).notNull(),
  title: varchar('title', { length: 150 }),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const reusableAssets = pgTable(
  'reusable_assets',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    kind: varchar('kind', { length: 20 }).notNull(),
    title: varchar('title', { length: 150 }).notNull(),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    storageUrl: text('storage_url').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userKindIdx: index('reusable_assets_user_kind_idx').on(
      table.userId,
      table.kind
    ),
    storageKeyIdx: uniqueIndex('reusable_assets_storage_key_idx').on(
      table.storageKey
    ),
  })
);

export const brandTemplates = pgTable(
  'brand_templates',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    name: varchar('name', { length: 100 }).notNull(),
    captionStyle: varchar('caption_style', { length: 40 })
      .notNull()
      .default('default'),
    captionFontFamily: varchar('caption_font_family', { length: 120 }),
    captionFontColor: varchar('caption_font_color', { length: 20 })
      .notNull()
      .default('#ffffff'),
    captionHighlightColor: varchar('caption_highlight_color', { length: 20 })
      .notNull()
      .default('#facc15'),
    captionPosition: varchar('caption_position', { length: 20 })
      .notNull()
      .default('bottom'),
    captionAnimation: varchar('caption_animation', { length: 20 })
      .notNull()
      .default('none'),
    captionFontAssetId: integer('caption_font_asset_id').references(
      () => reusableAssets.id
    ),
    aspectRatio: varchar('aspect_ratio', { length: 20 })
      .notNull()
      .default('9_16'),
    enabledAspectRatios: jsonb('enabled_aspect_ratios')
      .$type<('9_16' | '1_1' | '16_9')[]>()
      .notNull()
      .default(['9_16']),
    defaultLayout: varchar('default_layout', { length: 40 })
      .notNull()
      .default('default'),
    enabledLayouts: jsonb('enabled_layouts')
      .$type<RenderedClipLayout[]>()
      .notNull()
      .default(['default'] as RenderedClipLayout[]),
    logoAssetId: integer('logo_asset_id').references(() => reusableAssets.id),
    ctaUrl: text('cta_url'),
    introVideoAssetId: integer('intro_video_asset_id').references(
      () => reusableAssets.id
    ),
    outroVideoAssetId: integer('outro_video_asset_id').references(
      () => reusableAssets.id
    ),
    cropSettings: jsonb('crop_settings')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userUpdatedIdx: index('brand_templates_user_updated_idx').on(
      table.userId,
      table.updatedAt
    ),
    userDefaultIdx: index('brand_templates_user_default_idx').on(
      table.userId,
      table.isDefault
    ),
  })
);

export const linkedAccounts = pgTable(
  'linked_accounts',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    platform: varchar('platform', { length: 50 }).notNull(),
    platformAccountId: varchar('platform_account_id', { length: 255 }).notNull(),
    platformAccountName: varchar('platform_account_name', { length: 255 }),
    platformAccountUsername: varchar('platform_account_username', { length: 255 }),
    platformAccountImage: text('platform_account_image'),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userPlatformIdx: index('linked_accounts_user_platform_idx').on(
      table.userId,
      table.platform
    ),
    uniqueUserPlatformAccountIdx: uniqueIndex('linked_accounts_unique_account_idx').on(
      table.userId,
      table.platform,
      table.platformAccountId
    ),
  })
);

export const clipPublications = pgTable(
  'clip_publications',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    renderedClipId: integer('rendered_clip_id')
      .notNull()
      .references(() => renderedClips.id),
    linkedAccountId: integer('linked_account_id')
      .notNull()
      .references(() => linkedAccounts.id),
    platform: varchar('platform', { length: 50 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    platformPostId: varchar('platform_post_id', { length: 255 }),
    platformUrl: text('platform_url'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    renderedClipIdx: index('clip_publications_rendered_clip_idx').on(
      table.renderedClipId
    ),
    statusIdx: index('clip_publications_status_idx').on(
      table.status,
      table.updatedAt
    ),
    uniqueRenderedClipAccountIdx: uniqueIndex(
      'clip_publications_unique_rendered_clip_account_idx'
    ).on(table.renderedClipId, table.linkedAccountId),
  })
);

export const teamsRelations = relations(teams, ({ many }) => ({
  teamMembers: many(teamMembers),
  activityLogs: many(activityLogs),
  invitations: many(invitations),
}));

export const usersRelations = relations(users, ({ many }) => ({
  teamMembers: many(teamMembers),
  invitationsSent: many(invitations),
  notifications: many(notifications),
  projects: many(projects),
  sourceAssets: many(sourceAssets),
  transcripts: many(transcripts),
  contentPacks: many(contentPacks),
  clipCandidates: many(clipCandidates),
  clipCandidateFacecamDetectionRuns: many(clipCandidateFacecamDetectionRuns),
  clipCandidateFacecamDetections: many(clipCandidateFacecamDetections),
  clipEditConfigs: many(clipEditConfigs),
  renderedClips: many(renderedClips),
  generatedAssets: many(generatedAssets),
  voiceProfiles: many(voiceProfiles),
  reusableAssets: many(reusableAssets),
  brandTemplates: many(brandTemplates),
  linkedAccounts: many(linkedAccounts),
  clipPublications: many(clipPublications),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  team: one(teams, {
    fields: [invitations.teamId],
    references: [teams.id],
  }),
  invitedBy: one(users, {
    fields: [invitations.invitedBy],
    references: [users.id],
  }),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
}));

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  team: one(teams, {
    fields: [activityLogs.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [activityLogs.userId],
    references: [users.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, {
    fields: [projects.userId],
    references: [users.id],
  }),
  sourceAssets: many(sourceAssets),
  contentPacks: many(contentPacks),
}));

export const sourceAssetsRelations = relations(sourceAssets, ({ one, many }) => ({
  user: one(users, {
    fields: [sourceAssets.userId],
    references: [users.id],
  }),
  project: one(projects, {
    fields: [sourceAssets.projectId],
    references: [projects.id],
  }),
  transcript: one(transcripts, {
    fields: [sourceAssets.id],
    references: [transcripts.sourceAssetId],
  }),
  clipCandidates: many(clipCandidates),
  clipCandidateFacecamDetectionRuns: many(clipCandidateFacecamDetectionRuns),
  clipCandidateFacecamDetections: many(clipCandidateFacecamDetections),
  renderedClips: many(renderedClips),
  clipEditConfigs: many(clipEditConfigs),
  contentPacks: many(contentPacks),
  thumbnailVariants: many(sourceAssetThumbnailVariants),
}));

export const sourceUploadSessionsRelations = relations(
  sourceUploadSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [sourceUploadSessions.userId],
      references: [users.id],
    }),
    project: one(projects, {
      fields: [sourceUploadSessions.projectId],
      references: [projects.id],
    }),
    sourceAsset: one(sourceAssets, {
      fields: [sourceUploadSessions.sourceAssetId],
      references: [sourceAssets.id],
    }),
    parts: many(sourceUploadParts),
  })
);

export const sourceUploadPartsRelations = relations(
  sourceUploadParts,
  ({ one }) => ({
    session: one(sourceUploadSessions, {
      fields: [sourceUploadParts.uploadSessionId],
      references: [sourceUploadSessions.id],
    }),
  })
);

export const sourceAssetThumbnailVariantsRelations = relations(
  sourceAssetThumbnailVariants,
  ({ one }) => ({
    sourceAsset: one(sourceAssets, {
      fields: [sourceAssetThumbnailVariants.sourceAssetId],
      references: [sourceAssets.id],
    }),
  })
);

export const transcriptsRelations = relations(transcripts, ({ one, many }) => ({
  user: one(users, {
    fields: [transcripts.userId],
    references: [users.id],
  }),
  sourceAsset: one(sourceAssets, {
    fields: [transcripts.sourceAssetId],
    references: [sourceAssets.id],
  }),
  segments: many(transcriptSegments),
  words: many(transcriptWords),
  clipCandidates: many(clipCandidates),
  contentPacks: many(contentPacks),
}));

export const transcriptSegmentsRelations = relations(
  transcriptSegments,
  ({ one }) => ({
    transcript: one(transcripts, {
      fields: [transcriptSegments.transcriptId],
      references: [transcripts.id],
    }),
  })
);

export const transcriptWordsRelations = relations(
  transcriptWords,
  ({ one }) => ({
    transcript: one(transcripts, {
      fields: [transcriptWords.transcriptId],
      references: [transcripts.id],
    }),
  })
);

export const contentPacksRelations = relations(contentPacks, ({ one, many }) => ({
  user: one(users, {
    fields: [contentPacks.userId],
    references: [users.id],
  }),
  project: one(projects, {
    fields: [contentPacks.projectId],
    references: [projects.id],
  }),
  sourceAsset: one(sourceAssets, {
    fields: [contentPacks.sourceAssetId],
    references: [sourceAssets.id],
  }),
  transcript: one(transcripts, {
    fields: [contentPacks.transcriptId],
    references: [transcripts.id],
  }),
  clipCandidates: many(clipCandidates),
  renderedClips: many(renderedClips),
  generatedAssets: many(generatedAssets),
  clipEditConfigs: many(clipEditConfigs),
  clipRenderConfigs: many(clipRenderConfigs),
  clipCandidateFacecamDetectionRuns: many(clipCandidateFacecamDetectionRuns),
  generationRuns: many(generationRuns),
}));

export const generationRunsRelations = relations(generationRuns, ({ one }) => ({
  contentPack: one(contentPacks, {
    fields: [generationRuns.contentPackId],
    references: [contentPacks.id],
  }),
  selectedBrandTemplate: one(brandTemplates, {
    fields: [generationRuns.selectedBrandTemplateId],
    references: [brandTemplates.id],
  }),
}));

export const clipCandidatesRelations = relations(clipCandidates, ({ one, many }) => ({
  user: one(users, {
    fields: [clipCandidates.userId],
    references: [users.id],
  }),
  contentPack: one(contentPacks, {
    fields: [clipCandidates.contentPackId],
    references: [contentPacks.id],
  }),
  sourceAsset: one(sourceAssets, {
    fields: [clipCandidates.sourceAssetId],
    references: [sourceAssets.id],
  }),
  transcript: one(transcripts, {
    fields: [clipCandidates.transcriptId],
    references: [transcripts.id],
  }),
  renderedClips: many(renderedClips),
  facecamDetectionRuns: many(clipCandidateFacecamDetectionRuns),
  facecamDetections: many(clipCandidateFacecamDetections),
  renderConfigs: many(clipRenderConfigs),
  currentRenderConfig: one(clipRenderConfigs, {
    relationName: 'candidateCurrentRenderConfig',
    fields: [clipCandidates.currentRenderConfigId],
    references: [clipRenderConfigs.id],
  }),
  editConfig: one(clipEditConfigs, {
    fields: [clipCandidates.id],
    references: [clipEditConfigs.clipCandidateId],
  }),
}));

export const clipCandidateFacecamDetectionRunsRelations = relations(
  clipCandidateFacecamDetectionRuns,
  ({ one, many }) => ({
    user: one(users, {
      fields: [clipCandidateFacecamDetectionRuns.userId],
      references: [users.id],
    }),
    sourceAsset: one(sourceAssets, {
      fields: [clipCandidateFacecamDetectionRuns.sourceAssetId],
      references: [sourceAssets.id],
    }),
    contentPack: one(contentPacks, {
      fields: [clipCandidateFacecamDetectionRuns.contentPackId],
      references: [contentPacks.id],
    }),
    clipCandidate: one(clipCandidates, {
      fields: [clipCandidateFacecamDetectionRuns.clipCandidateId],
      references: [clipCandidates.id],
    }),
    detections: many(clipCandidateFacecamDetections),
    job: one(jobs, {
      fields: [clipCandidateFacecamDetectionRuns.jobId],
      references: [jobs.id],
    }),
  })
);

export const clipCandidateFacecamDetectionsRelations = relations(
  clipCandidateFacecamDetections,
  ({ one, many }) => ({
    user: one(users, {
      fields: [clipCandidateFacecamDetections.userId],
      references: [users.id],
    }),
    sourceAsset: one(sourceAssets, {
      fields: [clipCandidateFacecamDetections.sourceAssetId],
      references: [sourceAssets.id],
    }),
    clipCandidate: one(clipCandidates, {
      fields: [clipCandidateFacecamDetections.clipCandidateId],
      references: [clipCandidates.id],
    }),
    detectionRun: one(clipCandidateFacecamDetectionRuns, {
      fields: [clipCandidateFacecamDetections.detectionRunId],
      references: [clipCandidateFacecamDetectionRuns.id],
    }),
    editConfigs: many(clipEditConfigs),
    renderConfigs: many(clipRenderConfigs),
  })
);

export const clipEditConfigsRelations = relations(clipEditConfigs, ({ one, many }) => ({
  user: one(users, {
    fields: [clipEditConfigs.userId],
    references: [users.id],
  }),
  contentPack: one(contentPacks, {
    fields: [clipEditConfigs.contentPackId],
    references: [contentPacks.id],
  }),
  sourceAsset: one(sourceAssets, {
    fields: [clipEditConfigs.sourceAssetId],
    references: [sourceAssets.id],
  }),
  clipCandidate: one(clipCandidates, {
    fields: [clipEditConfigs.clipCandidateId],
    references: [clipCandidates.id],
  }),
  facecamDetection: one(clipCandidateFacecamDetections, {
    fields: [clipEditConfigs.facecamDetectionId],
    references: [clipCandidateFacecamDetections.id],
  }),
  brandTemplate: one(brandTemplates, {
    fields: [clipEditConfigs.brandTemplateId],
    references: [brandTemplates.id],
  }),
  renderedClips: many(renderedClips),
}));

export const clipRenderConfigsRelations = relations(
  clipRenderConfigs,
  ({ one, many }) => ({
    user: one(users, {
      fields: [clipRenderConfigs.userId],
      references: [users.id],
    }),
    contentPack: one(contentPacks, {
      fields: [clipRenderConfigs.contentPackId],
      references: [contentPacks.id],
    }),
    sourceAsset: one(sourceAssets, {
      fields: [clipRenderConfigs.sourceAssetId],
      references: [sourceAssets.id],
    }),
    clipCandidate: one(clipCandidates, {
      fields: [clipRenderConfigs.clipCandidateId],
      references: [clipCandidates.id],
    }),
    facecamDetection: one(clipCandidateFacecamDetections, {
      fields: [clipRenderConfigs.facecamDetectionId],
      references: [clipCandidateFacecamDetections.id],
    }),
    brandTemplate: one(brandTemplates, {
      fields: [clipRenderConfigs.brandTemplateId],
      references: [brandTemplates.id],
    }),
    renderedClips: many(renderedClips),
  })
);

export const renderedClipsRelations = relations(renderedClips, ({ one, many }) => ({
  user: one(users, {
    fields: [renderedClips.userId],
    references: [users.id],
  }),
  contentPack: one(contentPacks, {
    fields: [renderedClips.contentPackId],
    references: [contentPacks.id],
  }),
  sourceAsset: one(sourceAssets, {
    fields: [renderedClips.sourceAssetId],
    references: [sourceAssets.id],
  }),
  clipCandidate: one(clipCandidates, {
    fields: [renderedClips.clipCandidateId],
    references: [clipCandidates.id],
  }),
  editConfig: one(clipEditConfigs, {
    fields: [renderedClips.editConfigId],
    references: [clipEditConfigs.id],
  }),
  renderConfig: one(clipRenderConfigs, {
    fields: [renderedClips.clipRenderConfigId],
    references: [clipRenderConfigs.id],
  }),
  clipPublications: many(clipPublications),
}));

export const voiceProfilesRelations = relations(voiceProfiles, ({ one, many }) => ({
  user: one(users, {
    fields: [voiceProfiles.userId],
    references: [users.id],
  }),
  generatedAssets: many(generatedAssets),
}));

export const generatedAssetsRelations = relations(
  generatedAssets,
  ({ one }) => ({
    user: one(users, {
      fields: [generatedAssets.userId],
      references: [users.id],
    }),
    contentPack: one(contentPacks, {
      fields: [generatedAssets.contentPackId],
      references: [contentPacks.id],
    }),
    voiceProfile: one(voiceProfiles, {
      fields: [generatedAssets.voiceProfileId],
      references: [voiceProfiles.id],
    }),
  })
);

export const reusableAssetsRelations = relations(reusableAssets, ({ one }) => ({
  user: one(users, {
    fields: [reusableAssets.userId],
    references: [users.id],
  }),
}));

export const brandTemplatesRelations = relations(brandTemplates, ({ one, many }) => ({
  user: one(users, {
    fields: [brandTemplates.userId],
    references: [users.id],
  }),
  captionFontAsset: one(reusableAssets, {
    fields: [brandTemplates.captionFontAssetId],
    references: [reusableAssets.id],
  }),
  logoAsset: one(reusableAssets, {
    fields: [brandTemplates.logoAssetId],
    references: [reusableAssets.id],
  }),
  introVideoAsset: one(reusableAssets, {
    fields: [brandTemplates.introVideoAssetId],
    references: [reusableAssets.id],
  }),
  outroVideoAsset: one(reusableAssets, {
    fields: [brandTemplates.outroVideoAssetId],
    references: [reusableAssets.id],
  }),
  clipEditConfigs: many(clipEditConfigs),
  clipRenderConfigs: many(clipRenderConfigs),
  generationRuns: many(generationRuns),
}));

export const linkedAccountsRelations = relations(linkedAccounts, ({ one, many }) => ({
  user: one(users, {
    fields: [linkedAccounts.userId],
    references: [users.id],
  }),
  clipPublications: many(clipPublications),
}));

export const clipPublicationsRelations = relations(
  clipPublications,
  ({ one }) => ({
    user: one(users, {
      fields: [clipPublications.userId],
      references: [users.id],
    }),
    renderedClip: one(renderedClips, {
      fields: [clipPublications.renderedClipId],
      references: [renderedClips.id],
    }),
    linkedAccount: one(linkedAccounts, {
      fields: [clipPublications.linkedAccountId],
      references: [linkedAccounts.id],
    }),
  })
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type SourceAsset = typeof sourceAssets.$inferSelect;
export type NewSourceAsset = typeof sourceAssets.$inferInsert;
export type SourceUploadSession = typeof sourceUploadSessions.$inferSelect;
export type NewSourceUploadSession = typeof sourceUploadSessions.$inferInsert;
export type SourceUploadPart = typeof sourceUploadParts.$inferSelect;
export type NewSourceUploadPart = typeof sourceUploadParts.$inferInsert;
export type SourceAssetThumbnailVariant =
  typeof sourceAssetThumbnailVariants.$inferSelect;
export type NewSourceAssetThumbnailVariant =
  typeof sourceAssetThumbnailVariants.$inferInsert;
export type Transcript = typeof transcripts.$inferSelect;
export type NewTranscript = typeof transcripts.$inferInsert;
export type TranscriptSegment = typeof transcriptSegments.$inferSelect;
export type NewTranscriptSegment = typeof transcriptSegments.$inferInsert;
export type TranscriptWord = typeof transcriptWords.$inferSelect;
export type NewTranscriptWord = typeof transcriptWords.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobRecoveryRequest = typeof jobRecoveryRequests.$inferSelect;
export type NewJobRecoveryRequest = typeof jobRecoveryRequests.$inferInsert;
export type JobRecoveryEvent = typeof jobRecoveryEvents.$inferSelect;
export type JobEffectCheckpoint = typeof jobEffectCheckpoints.$inferSelect;
export type PipelineSchedulerState = typeof pipelineSchedulerState.$inferSelect;
export type ContentPack = typeof contentPacks.$inferSelect;
export type NewContentPack = typeof contentPacks.$inferInsert;
export type GenerationRun = typeof generationRuns.$inferSelect;
export type NewGenerationRun = typeof generationRuns.$inferInsert;
export type ClipCandidate = typeof clipCandidates.$inferSelect;
export type NewClipCandidate = typeof clipCandidates.$inferInsert;
export type ClipCandidateFacecamDetectionRun =
  typeof clipCandidateFacecamDetectionRuns.$inferSelect;
export type NewClipCandidateFacecamDetectionRun =
  typeof clipCandidateFacecamDetectionRuns.$inferInsert;
export type ClipCandidateFacecamDetection =
  typeof clipCandidateFacecamDetections.$inferSelect;
export type NewClipCandidateFacecamDetection =
  typeof clipCandidateFacecamDetections.$inferInsert;
export type FacecamSegment = typeof facecamSegments.$inferSelect;
export type NewFacecamSegment = typeof facecamSegments.$inferInsert;
export type ClipEditConfig = typeof clipEditConfigs.$inferSelect;
export type NewClipEditConfig = typeof clipEditConfigs.$inferInsert;
export type ClipRenderConfig = typeof clipRenderConfigs.$inferSelect;
export type NewClipRenderConfig = typeof clipRenderConfigs.$inferInsert;
export type RenderedClip = typeof renderedClips.$inferSelect;
export type NewRenderedClip = typeof renderedClips.$inferInsert;
export type GeneratedAsset = typeof generatedAssets.$inferSelect;
export type NewGeneratedAsset = typeof generatedAssets.$inferInsert;
export type VoiceProfile = typeof voiceProfiles.$inferSelect;
export type NewVoiceProfile = typeof voiceProfiles.$inferInsert;
export type ReusableAsset = typeof reusableAssets.$inferSelect;
export type NewReusableAsset = typeof reusableAssets.$inferInsert;
export type BrandTemplate = typeof brandTemplates.$inferSelect;
export type NewBrandTemplate = typeof brandTemplates.$inferInsert;
export type LinkedAccount = typeof linkedAccounts.$inferSelect;
export type NewLinkedAccount = typeof linkedAccounts.$inferInsert;
export type ClipPublication = typeof clipPublications.$inferSelect;
export type NewClipPublication = typeof clipPublications.$inferInsert;
export type TeamDataWithMembers = Team & {
  teamMembers: (TeamMember & {
    user: Pick<User, 'id' | 'name' | 'email'>;
  })[];
};

export enum SourceAssetStatus {
  UPLOADED = 'uploaded',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export enum SourceAssetType {
  UPLOADED_FILE = 'uploaded_file',
  YOUTUBE_URL = 'youtube_url',
  PASTED_TRANSCRIPT = 'pasted_transcript',
}

export enum SourceUploadSessionStatus {
  UPLOADING = 'uploading',
  COMPLETING = 'completing',
  COMPLETED = 'completed',
  ABORTED = 'aborted',
  FAILED = 'failed',
}

export enum SourceUploadPartStatus {
  UPLOADED = 'uploaded',
}

export enum MediaRetentionStatus {
  TEMPORARY = 'temporary',
  SAVED = 'saved',
  EXPIRED = 'expired',
  DELETED = 'deleted',
}

export enum TranscriptStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export enum ContentPackStatus {
  PENDING = 'pending',
  GENERATING = 'generating',
  READY = 'ready',
  PARTIALLY_READY = 'partially_ready',
  FAILED = 'failed',
}

export enum ContentPackKind {
  GENERAL = 'general',
  SHORT_FORM_CLIPS = 'short_form_clips',
}

export enum JobType {
  TRANSCRIBE_SOURCE_ASSET = 'transcribe_source_asset',
  EXTRACT_SOURCE_ASSET_THUMBNAIL = 'extract_source_asset_thumbnail',
  INGEST_YOUTUBE_SOURCE_ASSET = 'ingest_youtube_source_asset',
  GENERATE_SHORT_FORM_PACK = 'generate_short_form_pack',
  RENDER_CLIP_CANDIDATE = 'render_clip_candidate',
  FORMAT_RENDERED_CLIP_SHORT_FORM = 'format_rendered_clip_short_form',
  DETECT_CLIP_FACECAM = 'detect_clip_facecam',
  PUBLISH_RENDERED_CLIP = 'publish_rendered_clip',
}

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

export enum JobFailureClass {
  SAFE_NO_EXTERNAL_EFFECT = 'safe_no_external_effect',
  AMBIGUOUS_EXTERNAL_EFFECT = 'ambiguous_external_effect',
  DURABLE_CHECKPOINT = 'durable_checkpoint',
  PERMANENT = 'permanent',
  CANCELLED = 'cancelled',
}

export enum JobRecoveryMode {
  RETRY = 'retry',
  RESUME = 'resume',
  NEW_GENERATION = 'new_generation',
}

export enum JobRecoveryOutcome {
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
}

export enum JobEffectCheckpointStatus {
  PREPARED = 'prepared',
  EXTERNAL_EFFECT_STARTED = 'external_effect_started',
  COMPLETED = 'completed',
}

export enum ClipCandidateReviewStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  DISCARDED = 'discarded',
  SAVED_FOR_LATER = 'saved_for_later',
}

export enum FacecamDetectionStatus {
  NOT_STARTED = 'not_started',
  PENDING = 'pending',
  DETECTING = 'detecting',
  READY = 'ready',
  NOT_FOUND = 'not_found',
  FAILED_TIMEOUT = 'failed_timeout',
  FAILED_ABORTED = 'failed_aborted',
  FAILED_NETWORK = 'failed_network',
  FAILED_HTTP = 'failed_http',
  FAILED_INVALID_RESPONSE = 'failed_invalid',
  FAILED = 'failed',
}

export enum RenderedClipStatus {
  PENDING = 'pending',
  RENDERING = 'rendering',
  READY = 'ready',
  FAILED = 'failed',
}

export enum RenderedClipVariant {
  TRIMMED_ORIGINAL = 'trimmed_original',
  VERTICAL_SHORT_FORM = 'vertical_short_form',
  SQUARE_SHORT_FORM = 'square_short_form',
  LANDSCAPE_SHORT_FORM = 'landscape_short_form',
}

export enum RenderedClipLayout {
  PRESERVE_ASPECT = 'preserve_aspect',
  DEFAULT = 'default',
  FACECAM_TOP_50 = 'facecam_top_50',
  FACECAM_TOP_40 = 'facecam_top_40',
  FACECAM_TOP_30 = 'facecam_top_30',
}

export enum ReusableAssetKind {
  FONT = 'font',
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
}

export enum ClipPublicationStatus {
  PENDING = 'pending',
  PUBLISHING = 'publishing',
  PUBLISHED = 'published',
  FAILED = 'failed',
}

export enum NotificationType {
  UPLOAD = 'upload',
  TRANSCRIPT = 'transcript',
  SHORT_FORM_PACK = 'short_form_pack',
  RENDERED_CLIP = 'rendered_clip',
  FACECAM_DETECTION = 'facecam_detection',
  CLIP_PUBLICATION = 'clip_publication',
}

export enum NotificationOutcome {
  SUCCESS = 'success',
  WARNING = 'warning',
  FAILURE = 'failure',
}

export enum ActivityType {
  SIGN_UP = 'SIGN_UP',
  SIGN_IN = 'SIGN_IN',
  SIGN_OUT = 'SIGN_OUT',
  UPDATE_PASSWORD = 'UPDATE_PASSWORD',
  DELETE_ACCOUNT = 'DELETE_ACCOUNT',
  UPDATE_ACCOUNT = 'UPDATE_ACCOUNT',
  CREATE_TEAM = 'CREATE_TEAM',
  REMOVE_TEAM_MEMBER = 'REMOVE_TEAM_MEMBER',
  INVITE_TEAM_MEMBER = 'INVITE_TEAM_MEMBER',
  ACCEPT_INVITATION = 'ACCEPT_INVITATION',
}
