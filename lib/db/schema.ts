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
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

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

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  name: varchar('name', { length: 150 }).notNull(),
  description: text('description'),
  savedAt: timestamp('saved_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

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
    fileSizeBytes: integer('file_size_bytes'),
    status: varchar('status', { length: 20 }).notNull().default('uploaded'),
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
    retentionExpiryIdx: index('source_assets_retention_expiry_idx').on(
      table.retentionStatus,
      table.expiresAt
    ),
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

export type TranscribeSourceAssetJobPayload = {
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
  transcriptId: number;
  userId: number;
};

export type RenderClipCandidateJobPayload = {
  clipCandidateId: number;
  contentPackId: number;
  sourceAssetId: number;
  userId: number;
};

export type FormatRenderedClipShortFormJobPayload = {
  clipCandidateId: number;
  contentPackId: number;
  sourceAssetId: number;
  userId: number;
};

export type DetectClipFacecamJobPayload = {
  clipCandidateId: number;
  contentPackId: number;
  sourceAssetId: number;
  userId: number;
};

export type JobPayload =
  | TranscribeSourceAssetJobPayload
  | IngestYoutubeSourceAssetJobPayload
  | GenerateShortFormPackJobPayload
  | RenderClipCandidateJobPayload
  | FormatRenderedClipShortFormJobPayload
  | DetectClipFacecamJobPayload;

export const jobs = pgTable(
  'jobs',
  {
    id: serial('id').primaryKey(),
    type: varchar('type', { length: 50 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    payload: jsonb('payload').$type<JobPayload>().notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    availableAt: timestamp('available_at').notNull().defaultNow(),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    failureReason: text('failure_reason'),
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
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

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
    reviewStatus: varchar('review_status', { length: 30 })
      .notNull()
      .default('pending'),
    facecamDetectionStatus: varchar('facecam_detection_status', { length: 20 })
      .notNull()
      .default('not_started'),
    facecamDetectionFailureReason: text('facecam_detection_failure_reason'),
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
    sourceAssetIdx: index('clip_candidate_facecam_detections_source_asset_idx').on(
      table.sourceAssetId
    ),
    candidateRankIdx: uniqueIndex(
      'clip_candidate_facecam_detections_candidate_rank_idx'
    ).on(table.clipCandidateId, table.rank),
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
    variant: varchar('variant', { length: 40 })
      .notNull()
      .default('trimmed_original'),
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
    candidateVariantIdx: uniqueIndex('rendered_clips_candidate_variant_idx').on(
      table.clipCandidateId,
      table.variant
    ),
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

export const teamsRelations = relations(teams, ({ many }) => ({
  teamMembers: many(teamMembers),
  activityLogs: many(activityLogs),
  invitations: many(invitations),
}));

export const usersRelations = relations(users, ({ many }) => ({
  teamMembers: many(teamMembers),
  invitationsSent: many(invitations),
  projects: many(projects),
  sourceAssets: many(sourceAssets),
  transcripts: many(transcripts),
  contentPacks: many(contentPacks),
  clipCandidates: many(clipCandidates),
  clipCandidateFacecamDetections: many(clipCandidateFacecamDetections),
  renderedClips: many(renderedClips),
  generatedAssets: many(generatedAssets),
  voiceProfiles: many(voiceProfiles),
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
  clipCandidateFacecamDetections: many(clipCandidateFacecamDetections),
  renderedClips: many(renderedClips),
  contentPacks: many(contentPacks),
}));

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
  facecamDetections: many(clipCandidateFacecamDetections),
}));

export const clipCandidateFacecamDetectionsRelations = relations(
  clipCandidateFacecamDetections,
  ({ one }) => ({
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
  })
);

export const renderedClipsRelations = relations(renderedClips, ({ one }) => ({
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type SourceAsset = typeof sourceAssets.$inferSelect;
export type NewSourceAsset = typeof sourceAssets.$inferInsert;
export type Transcript = typeof transcripts.$inferSelect;
export type NewTranscript = typeof transcripts.$inferInsert;
export type TranscriptSegment = typeof transcriptSegments.$inferSelect;
export type NewTranscriptSegment = typeof transcriptSegments.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type ContentPack = typeof contentPacks.$inferSelect;
export type NewContentPack = typeof contentPacks.$inferInsert;
export type ClipCandidate = typeof clipCandidates.$inferSelect;
export type NewClipCandidate = typeof clipCandidates.$inferInsert;
export type ClipCandidateFacecamDetection =
  typeof clipCandidateFacecamDetections.$inferSelect;
export type NewClipCandidateFacecamDetection =
  typeof clipCandidateFacecamDetections.$inferInsert;
export type RenderedClip = typeof renderedClips.$inferSelect;
export type NewRenderedClip = typeof renderedClips.$inferInsert;
export type GeneratedAsset = typeof generatedAssets.$inferSelect;
export type NewGeneratedAsset = typeof generatedAssets.$inferInsert;
export type VoiceProfile = typeof voiceProfiles.$inferSelect;
export type NewVoiceProfile = typeof voiceProfiles.$inferInsert;
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
  FAILED = 'failed',
}

export enum ContentPackKind {
  GENERAL = 'general',
  SHORT_FORM_CLIPS = 'short_form_clips',
}

export enum JobType {
  TRANSCRIBE_SOURCE_ASSET = 'transcribe_source_asset',
  INGEST_YOUTUBE_SOURCE_ASSET = 'ingest_youtube_source_asset',
  GENERATE_SHORT_FORM_PACK = 'generate_short_form_pack',
  RENDER_CLIP_CANDIDATE = 'render_clip_candidate',
  FORMAT_RENDERED_CLIP_SHORT_FORM = 'format_rendered_clip_short_form',
  DETECT_CLIP_FACECAM = 'detect_clip_facecam',
}

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
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
