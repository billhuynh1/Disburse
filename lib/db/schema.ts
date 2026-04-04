import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: varchar('role', { length: 20 }).notNull().default('member'),
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
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const sourceAssets = pgTable('source_assets', {
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
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

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
  name: varchar('name', { length: 150 }).notNull(),
  instructions: text('instructions'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

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
  contentPacks: many(contentPacks),
}));

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
  generatedAssets: many(generatedAssets),
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
export type ContentPack = typeof contentPacks.$inferSelect;
export type NewContentPack = typeof contentPacks.$inferInsert;
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
