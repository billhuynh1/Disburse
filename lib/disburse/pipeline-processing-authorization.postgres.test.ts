import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import test from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';

import type { CandidateFacecamExternalOperations } from './facecam-detection-service.ts';
import type { ClaimedPipelineJob } from './job-service.ts';
import type { PipelineProcessingRuntime } from './pipeline-service.ts';
import type { ShortFormGenerationExternalOperations } from './short-form-service.ts';
import type { TranscriptionExternalOperations } from './transcription-service.ts';

register('../test/typescript-path-loader.mjs', import.meta.url);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForCondition(condition: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the PostgreSQL barrier.');
}

test('production pipeline persistence is fenced across external-work boundaries', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async (t) => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  const parsed = new URL(configuredUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  assert.equal(parsed.pathname.replace(/^\//, ''), 'disburse_phase1a_test');
  const schemaName = `pipeline_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  await admin.unsafe(`create schema "${schemaName}"`);
  const isolatedUrl = new URL(configuredUrl);
  isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
  const setup = postgres(isolatedUrl.toString(), { max: 1 });
  await setup.unsafe(`
    create table users (
      id serial primary key, name varchar(100), email varchar(255) not null unique,
      password_hash text not null, role varchar(20) not null default 'member',
      storage_limit_bytes bigint, auto_save_approved_clips_enabled boolean not null default false,
      created_at timestamp not null default now(), updated_at timestamp not null default now(),
      deleted_at timestamp
    );
    create table projects (
      id serial primary key, user_id integer not null, name varchar(150) not null,
      description text, is_saved boolean not null default false, expires_at timestamp,
      saved_at timestamp, deletion_requested_at timestamp,
      created_at timestamp not null default now(), updated_at timestamp not null default now()
    );
    create table source_assets (
      id serial primary key, user_id integer not null, project_id integer not null,
      title varchar(150) not null, asset_type varchar(50) not null,
      original_filename varchar(255), mime_type varchar(100), storage_key text unique,
      storage_url text not null, file_size_bytes bigint, thumbnail_storage_key text unique,
      thumbnail_mime_type varchar(100), thumbnail_width integer, thumbnail_height integer,
      status varchar(20) not null default 'uploaded', retention_status varchar(20),
      expires_at timestamp, saved_at timestamp, deleted_at timestamp,
      storage_deleted_at timestamp, deletion_requested_at timestamp,
      deletion_reason text, failure_reason text,
      created_at timestamp not null default now(), updated_at timestamp not null default now()
    );
    create table transcripts (
      id serial primary key, user_id integer not null, source_asset_id integer not null unique,
      language varchar(20), content text, status varchar(20) not null default 'pending',
      failure_reason text, created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table transcript_segments (
      id serial primary key, transcript_id integer not null, sequence integer not null,
      start_time_ms integer not null, end_time_ms integer not null, text text not null,
      created_at timestamp not null default now(), updated_at timestamp not null default now()
    );
    create table transcript_words (
      id serial primary key, transcript_id integer not null, sequence integer not null,
      start_time_ms integer not null, end_time_ms integer not null, text text not null,
      created_at timestamp not null default now(), updated_at timestamp not null default now()
    );
    create table jobs (
      id serial primary key, type varchar(50) not null, status varchar(20) not null default 'pending',
      idempotency_key text not null unique, payload jsonb not null,
      attempt_count integer not null default 0, max_attempts integer not null default 3,
      available_at timestamp not null default now(), started_at timestamp, heartbeat_at timestamp,
      lease_token text, lease_expires_at timestamp, completed_at timestamp,
      cancellation_reason varchar(40), cancellation_requested_at timestamp, failure_reason text,
      failure_code varchar(80), failure_class varchar(40), logical_job_key text,
      root_job_id integer, parent_job_id integer, recovery_attempt integer not null default 0,
      recovery_mode varchar(30),
      created_at timestamp not null default now(), updated_at timestamp not null default now()
    );
    create table job_effect_checkpoints (
      id serial primary key, job_id integer not null references jobs(id) on delete cascade,
      effect_key text not null, job_type varchar(50) not null, status varchar(30) not null,
      result jsonb, external_effect_started_at timestamp, completed_at timestamp,
      created_at timestamp not null default now(), updated_at timestamp not null default now(),
      unique(job_id, effect_key)
    );
    create table pipeline_scheduler_state (
      id integer primary key default 1 check (id = 1), owner_token text,
      lease_expires_at timestamp, heartbeat_at timestamp,
      reconciliation_cursor integer, reconciliation_cycle bigint not null default 0,
      updated_at timestamp not null default now()
    );
    create table deadline_test_barriers (
      id integer primary key, value text not null
    );
    create table deadline_test_effects (
      id serial primary key, job_id integer not null, value text not null
    );
    create table content_packs (
      id serial primary key, user_id integer not null, project_id integer not null,
      source_asset_id integer not null, transcript_id integer, kind varchar(50) not null default 'general',
      name varchar(150) not null, instructions text, generation_run_id text not null,
      status varchar(20) not null default 'pending', failure_reason text,
      created_at timestamp not null default now(), updated_at timestamp not null default now()
    );
    create table notifications (
      id serial primary key, user_id integer not null, type varchar(50) not null,
      status varchar(20) not null, title varchar(150) not null, message text not null,
      entity_type varchar(50), entity_id integer, action_url text, dedupe_key text not null unique,
      read_at timestamp, created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table generated_assets (
      id serial primary key, user_id integer not null, content_pack_id integer not null,
      voice_profile_id integer, asset_type varchar(50) not null, title varchar(150),
      content text not null, created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table brand_templates (
      id serial primary key, user_id integer not null, name varchar(100) not null,
      caption_style varchar(40) not null default 'default', caption_font_family varchar(120),
      caption_font_color varchar(20) not null default '#ffffff',
      caption_highlight_color varchar(20) not null default '#facc15',
      caption_position varchar(20) not null default 'bottom',
      caption_animation varchar(20) not null default 'none', caption_font_asset_id integer,
      aspect_ratio varchar(20) not null default '9_16',
      enabled_aspect_ratios jsonb not null default '["9_16"]',
      default_layout varchar(40) not null default 'default',
      enabled_layouts jsonb not null default '["default"]', logo_asset_id integer,
      cta_url text, intro_video_asset_id integer, outro_video_asset_id integer,
      crop_settings jsonb not null default '{}', is_default boolean not null default false,
      created_at timestamp not null default now(), updated_at timestamp not null default now()
    );
    create table clip_candidates (
      id serial primary key, user_id integer not null, content_pack_id integer not null,
      source_asset_id integer not null, transcript_id integer not null, rank integer not null,
      start_time_ms integer not null, end_time_ms integer not null, duration_ms integer not null,
      hook text not null, title varchar(150) not null, caption_copy text not null,
      summary text not null, transcript_excerpt text not null, why_it_works text not null,
      platform_fit text not null, confidence integer not null, generation_run_id text not null,
      review_status varchar(30) not null default 'pending',
      facecam_detection_status varchar(20) not null default 'not_started',
      facecam_detection_failure_reason text, facecam_detection_debug_reason text,
      facecam_detected_at timestamp, created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table clip_candidate_facecam_detection_runs (
      id serial primary key, user_id integer not null, source_asset_id integer not null,
      content_pack_id integer not null, clip_candidate_id integer not null,
      generation_run_id text not null, detector_version text not null default 'facecam_v1',
      start_time_ms integer not null, end_time_ms integer not null,
      status varchar(30) not null default 'pending', failure_reason text, debug_reason text,
      sampled_frame_count integer, detection_stage text, debug_summary text, job_id integer,
      started_at timestamp, completed_at timestamp,
      created_at timestamp not null default now(), updated_at timestamp not null default now(),
      unique (source_asset_id, clip_candidate_id, generation_run_id, start_time_ms, end_time_ms, detector_version)
    );
    create table clip_candidate_facecam_detections (
      id serial primary key, user_id integer not null, source_asset_id integer not null,
      clip_candidate_id integer not null, detection_run_id integer, generation_run_id text not null,
      detector_version text not null default 'facecam_v1', rank integer not null,
      start_time_ms integer not null, end_time_ms integer not null,
      frame_width integer not null, frame_height integer not null, x_px integer not null,
      y_px integer not null, width_px integer not null, height_px integer not null,
      confidence integer not null, sampled_frame_count integer not null,
      created_at timestamp not null default now(), updated_at timestamp not null default now()
    );
    create table facecam_segments (
      id serial primary key, user_id integer not null, video_id integer not null,
      source_asset_id integer not null, rank integer not null,
      start_time_ms integer not null, end_time_ms integer not null,
      frame_width integer not null, frame_height integer not null,
      x_px integer not null, y_px integer not null, width_px integer not null,
      height_px integer not null, confidence integer not null,
      layout_type varchar(40) not null, sampled_frame_count integer not null,
      created_at timestamp not null default now(), updated_at timestamp not null default now()
    );
    create table clip_edit_configs (
      id serial primary key, user_id integer not null, content_pack_id integer not null,
      source_asset_id integer not null, clip_candidate_id integer not null unique,
      generation_run_id text not null, aspect_ratio varchar(20) not null default '9_16',
      layout varchar(40) not null default 'default', layout_ratio varchar(20),
      captions_enabled boolean not null default true, caption_style varchar(40) not null default 'default',
      caption_font_asset_id integer, caption_font_family varchar(120),
      caption_font_color varchar(20) not null default '#ffffff',
      caption_highlight_color varchar(20) not null default '#facc15',
      caption_position varchar(20) not null default 'bottom',
      caption_animation varchar(20) not null default 'none', brand_template_id integer,
      overlay_logo_asset_id integer, cta_url text, intro_video_asset_id integer,
      outro_video_asset_id integer, crop_settings jsonb not null default '{}',
      facecam_detection_id integer, facecam_detected boolean not null default false,
      auto_edit_preset varchar(80) not null default 'default_short_form_v1',
      auto_edit_applied_at timestamp, config_version integer not null default 1,
      config_hash text not null, created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table clip_render_configs (
      id serial primary key, user_id integer not null, content_pack_id integer not null,
      source_asset_id integer not null, clip_candidate_id integer not null,
      generation_run_id text not null, aspect_ratio varchar(20) not null default '9_16',
      layout varchar(40) not null default 'default', layout_ratio varchar(20),
      captions_enabled boolean not null default true, caption_style varchar(40) not null default 'default',
      caption_font_asset_id integer, caption_font_family varchar(120),
      caption_font_color varchar(20) not null default '#ffffff',
      caption_highlight_color varchar(20) not null default '#facc15',
      caption_position varchar(20) not null default 'bottom',
      caption_animation varchar(20) not null default 'none', brand_template_id integer,
      overlay_logo_asset_id integer, cta_url text, intro_video_asset_id integer,
      outro_video_asset_id integer, crop_settings jsonb not null default '{}',
      facecam_detection_id integer, facecam_detected boolean not null default false,
      auto_edit_preset varchar(80) not null default 'default_short_form_v1',
      config_hash text not null, created_at timestamp not null default now(),
      updated_at timestamp not null default now(), unique (clip_candidate_id, aspect_ratio, layout, config_hash)
    );
    create table rendered_clips (
      id serial primary key, user_id integer not null, content_pack_id integer not null,
      source_asset_id integer not null, clip_candidate_id integer not null,
      generation_run_id text not null, variant varchar(40) not null default 'trimmed_original',
      layout varchar(40) not null default 'default', edit_config_id integer,
      clip_render_config_id integer, edit_config_version integer, edit_config_hash text,
      status varchar(20) not null default 'pending', title varchar(150) not null,
      start_time_ms integer not null, end_time_ms integer not null, duration_ms integer not null,
      storage_key text unique, storage_url text, mime_type varchar(100), file_size_bytes integer,
      retention_status varchar(20), expires_at timestamp, saved_at timestamp,
      deleted_at timestamp, storage_deleted_at timestamp, deletion_reason text, failure_reason text,
      created_at timestamp not null default now(), updated_at timestamp not null default now()
    );
  `);
  await setup.end();
  isolatedUrl.searchParams.set(
    'options',
    `-csearch_path=${schemaName} -capplication_name=phase4_deadline_app`
  );
  process.env.POSTGRES_URL = isolatedUrl.toString();

  const contender = postgres(isolatedUrl.toString(), { max: 1 });
  const { client, db } = await import('../db/drizzle.ts');
  const schema = await import('../db/schema.ts');
  const {
    claimNextJob,
    enqueueDetectCandidateFacecamJob,
    enqueueShortFormPackJob,
    enqueueTranscriptionJob,
  } = await import('./job-service.ts');
  const {
    processClaimedJob,
    productionPipelineProcessingRuntime,
  } = await import('./pipeline-service.ts');
  const { transcribeSourceAsset } = await import('./transcription-service.ts');
  const { generateShortFormPack } = await import('./short-form-service.ts');
  const { detectCandidateFacecam } = await import('./facecam-detection-service.ts');
  const { StaleJobReason } = await import('./stale-job.ts');
  const { withAuthorizedJobSuccessTransaction } =
    await import('./job-execution-authorization.ts');
  const { beginExternalEffectBoundary } =
    await import('./job-effect-checkpoint-service.ts');

  const cleanupUser = async (userId: number) => {
    await contender.begin(async (tx) => {
      await tx`delete from notifications where user_id = ${userId}`;
      await tx`delete from rendered_clips where user_id = ${userId}`;
      await tx`delete from clip_render_configs where user_id = ${userId}`;
      await tx`delete from clip_edit_configs where user_id = ${userId}`;
      await tx`delete from clip_candidate_facecam_detections where user_id = ${userId}`;
      await tx`delete from clip_candidate_facecam_detection_runs where user_id = ${userId}`;
      await tx`delete from facecam_segments where user_id = ${userId}`;
      await tx`delete from jobs where payload->>'userId' = ${String(userId)}`;
      await tx`delete from generated_assets where user_id = ${userId}`;
      await tx`delete from clip_candidates where user_id = ${userId}`;
      await tx`delete from content_packs where user_id = ${userId}`;
      await tx`delete from transcript_words where transcript_id in (select id from transcripts where user_id = ${userId})`;
      await tx`delete from transcript_segments where transcript_id in (select id from transcripts where user_id = ${userId})`;
      await tx`delete from transcripts where user_id = ${userId}`;
      await tx`delete from source_assets where user_id = ${userId}`;
      await tx`delete from projects where user_id = ${userId}`;
      await tx`delete from users where id = ${userId}`;
    });
  };

  const createSource = async (mimeType: string) => {
    const suffix = randomUUID();
    const [user] = await db.insert(schema.users).values({
      email: `phase1c-${suffix}@example.test`,
      passwordHash: 'test',
    }).returning();
    const [project] = await db.insert(schema.projects).values({
      userId: user.id,
      name: `Phase 1C ${suffix}`,
    }).returning();
    const [sourceAsset] = await db.insert(schema.sourceAssets).values({
      userId: user.id,
      projectId: project.id,
      title: 'Phase 1C source',
      assetType: schema.SourceAssetType.UPLOADED_FILE,
      originalFilename: mimeType.startsWith('video/') ? 'source.mp4' : 'source.mp3',
      mimeType,
      storageKey: `phase1c/${suffix}/source`,
      storageUrl: 's3://phase1c/source',
      status: schema.SourceAssetStatus.UPLOADED,
    }).returning();
    return { user, project, sourceAsset };
  };

  const addReadyTranscriptAndPack = async (
    fixture: Awaited<ReturnType<typeof createSource>>
  ) => {
    const [transcript] = await db.insert(schema.transcripts).values({
      userId: fixture.user.id,
      sourceAssetId: fixture.sourceAsset.id,
      language: 'en',
      content: 'A complete source-grounded segment for deterministic generation.',
      status: schema.TranscriptStatus.READY,
    }).returning();
    await db.insert(schema.transcriptSegments).values({
      transcriptId: transcript.id,
      sequence: 0,
      startTimeMs: 0,
      endTimeMs: 45_000,
      text: 'A complete source-grounded segment for deterministic generation.',
    });
    const generationRunId = randomUUID();
    const [contentPack] = await db.insert(schema.contentPacks).values({
      userId: fixture.user.id,
      projectId: fixture.project.id,
      sourceAssetId: fixture.sourceAsset.id,
      transcriptId: transcript.id,
      kind: schema.ContentPackKind.SHORT_FORM_CLIPS,
      name: 'Short-form pack',
      generationRunId,
      status: schema.ContentPackStatus.PENDING,
    }).returning();
    await db.update(schema.sourceAssets)
      .set({ status: schema.SourceAssetStatus.READY })
      .where(eq(schema.sourceAssets.id, fixture.sourceAsset.id));
    return { ...fixture, transcript, contentPack, generationRunId };
  };

  const runtimeWith = (
    processors: Partial<PipelineProcessingRuntime['processors']> = {},
    authorization: Partial<PipelineProcessingRuntime['authorization']> = {}
  ): PipelineProcessingRuntime => ({
    ...productionPipelineProcessingRuntime,
    processors: {
      ...productionPipelineProcessingRuntime.processors,
      ...processors,
    },
    authorization: {
      ...productionPipelineProcessingRuntime.authorization,
      ...authorization,
    },
    downstream: { trigger: () => undefined },
    timer: {
      startHeartbeat: () => null,
      stopHeartbeat: () => undefined,
    },
  });

  const claimExpected = async (expectedJobId: number) => {
    const claimed = await claimNextJob();
    assert.ok(claimed);
    assert.equal(claimed.id, expectedJobId);
    return claimed;
  };

  const rankedCandidate = (windowId: string) => ({
    windowId,
    hook: 'A grounded hook',
    title: 'A grounded title',
    captionCopy: 'Grounded caption copy.',
    summary: 'Grounded summary.',
    whyItWorks: 'It is self-contained.',
    platformFit: 'Short-form video.',
    confidence: 90,
  });

  try {
    await t.test('transcription cancellation suppresses ready rows and notification creation', async () => {
      const fixture = await createSource('audio/mpeg');
      try {
        const queued = await enqueueTranscriptionJob(fixture.sourceAsset.id, fixture.user.id);
        assert.ok(queued);
        const claimed = await claimExpected(queued.id);
        const externalStarted = deferred<void>();
        const releaseExternal = deferred<void>();
        const external: TranscriptionExternalOperations = {
          transcribe: async () => {
            await beginExternalEffectBoundary();
            externalStarted.resolve();
            await releaseExternal.promise;
            return {
              content: 'Transcribed source content.',
              language: 'en',
              segments: [{
                sequence: 0,
                startTimeMs: 0,
                endTimeMs: 30_000,
                text: 'Transcribed source content.',
              }],
              words: [],
            };
          },
        };
        const processing = processClaimedJob(claimed, runtimeWith({
          transcribe: (sourceAssetId, authority) =>
            transcribeSourceAsset(sourceAssetId, authority, external),
        }));
        await externalStarted.promise;
        await contender`update jobs set cancellation_requested_at = clock_timestamp(), cancellation_reason = 'project_deleted' where id = ${claimed.id}`;
        releaseExternal.resolve();

        const result = await processing;
        assert.equal(result.status, 'lease_lost');
        const [transcript] = await db.select().from(schema.transcripts)
          .where(eq(schema.transcripts.sourceAssetId, fixture.sourceAsset.id));
        const segments = await db.select().from(schema.transcriptSegments)
          .where(eq(schema.transcriptSegments.transcriptId, transcript.id));
        const notifications = await db.select().from(schema.notifications)
          .where(and(
            eq(schema.notifications.userId, fixture.user.id),
            eq(schema.notifications.type, 'transcript_ready')
          ));
        assert.equal(transcript.status, schema.TranscriptStatus.PROCESSING);
        assert.equal(segments.length, 0);
        assert.equal(notifications.length, 0);
        const [cancelledJob] = await db.select().from(schema.jobs)
          .where(eq(schema.jobs.id, claimed.id));
        assert.equal(cancelledJob.status, schema.JobStatus.CANCELLED);
        assert.equal(cancelledJob.cancellationReason, 'project_deleted');
      } finally {
        await cleanupUser(fixture.user.id);
      }
    });

    await t.test('late provider success is rejected as an ambiguous post-boundary failure', async () => {
      const fixture = await createSource('audio/mpeg');
      const originalTimeout = process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS;
      process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS = '5';
      try {
        const queued = await enqueueTranscriptionJob(fixture.sourceAsset.id, fixture.user.id);
        assert.ok(queued);
        const claimed = await claimExpected(queued.id);
        const externalStarted = deferred<void>();
        const releaseExternal = deferred<void>();
        const processing = processClaimedJob(claimed, runtimeWith({
          transcribe: (sourceAssetId, authority) => transcribeSourceAsset(
            sourceAssetId,
            authority,
            {
              transcribe: async () => {
                await beginExternalEffectBoundary();
                externalStarted.resolve();
                await releaseExternal.promise;
                return {
                  content: 'Late provider success must not be accepted.',
                  language: 'en',
                  segments: [{
                    sequence: 0,
                    startTimeMs: 0,
                    endTimeMs: 30_000,
                    text: 'Late provider success must not be accepted.',
                  }],
                  words: [],
                };
              },
            }
          ),
        }));
        await externalStarted.promise;
        await new Promise((resolve) => setTimeout(resolve, 20));
        releaseExternal.resolve();

        const result = await processing;
        assert.equal(result.status, 'failed');
        assert.equal(
          'failureCode' in result ? result.failureCode : null,
          'external_effect_ambiguous'
        );
        const [transcript] = await db.select().from(schema.transcripts)
          .where(eq(schema.transcripts.sourceAssetId, fixture.sourceAsset.id));
        const segments = await db.select().from(schema.transcriptSegments)
          .where(eq(schema.transcriptSegments.transcriptId, transcript.id));
        const [persistedJob] = await db.select().from(schema.jobs)
          .where(eq(schema.jobs.id, claimed.id));
        const notifications = await db.select().from(schema.notifications)
          .where(eq(schema.notifications.userId, fixture.user.id));
        assert.equal(transcript.status, schema.TranscriptStatus.FAILED);
        assert.equal(segments.length, 0);
        assert.equal(notifications.length, 1);
        assert.equal(persistedJob.status, schema.JobStatus.FAILED);
      } finally {
        if (originalTimeout === undefined) delete process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS;
        else process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS = originalTimeout;
        await cleanupUser(fixture.user.id);
      }
    });

    await t.test('a stale worker cannot persist a late-success deadline outcome', async () => {
      const fixture = await createSource('audio/mpeg');
      const originalTimeout = process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS;
      process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS = '5';
      try {
        const queued = await enqueueTranscriptionJob(fixture.sourceAsset.id, fixture.user.id);
        assert.ok(queued);
        const claimed = await claimExpected(queued.id);
        const externalStarted = deferred<void>();
        const releaseExternal = deferred<void>();
        const processing = processClaimedJob(claimed, runtimeWith({
          transcribe: (sourceAssetId, authority) => transcribeSourceAsset(
            sourceAssetId,
            authority,
            {
              transcribe: async () => {
                await beginExternalEffectBoundary();
                externalStarted.resolve();
                await releaseExternal.promise;
                return {
                  content: 'Stale late success.',
                  language: 'en',
                  segments: [{ sequence: 0, startTimeMs: 0, endTimeMs: 1_000,
                    text: 'Stale late success.' }],
                  words: [],
                };
              },
            }
          ),
        }));
        await externalStarted.promise;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const replacementToken = randomUUID();
        await contender`update jobs set lease_token = ${replacementToken} where id = ${claimed.id}`;
        releaseExternal.resolve();

        const result = await processing;
        assert.equal(result.status, 'lease_lost');
        const [transcript] = await db.select().from(schema.transcripts)
          .where(eq(schema.transcripts.sourceAssetId, fixture.sourceAsset.id));
        const [persistedJob] = await db.select().from(schema.jobs)
          .where(eq(schema.jobs.id, claimed.id));
        assert.equal(transcript.status, schema.TranscriptStatus.PROCESSING);
        assert.equal(persistedJob.status, schema.JobStatus.PROCESSING);
        assert.equal(persistedJob.leaseToken, replacementToken);
      } finally {
        if (originalTimeout === undefined) delete process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS;
        else process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS = originalTimeout;
        await cleanupUser(fixture.user.id);
      }
    });

    for (const replaceLeaseToken of [false, true]) {
      await t.test(
        `deadline expiry during blocked success finalization ${
          replaceLeaseToken ? 'is fenced by a successor token' : 'rolls back before failure persistence'
        }`,
        async () => {
          const fixture = await createSource('audio/mpeg');
          const originalTimeout = process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS;
          process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS = '1000';
          let blocker: ReturnType<typeof postgres> | undefined;
          let releaseFinalizerBlocker: (() => void) | undefined;
          try {
            const queued = await enqueueTranscriptionJob(
              fixture.sourceAsset.id,
              fixture.user.id
            );
            assert.ok(queued);
            const claimed = await claimExpected(queued.id);
            await contender`
              insert into deadline_test_barriers (id, value)
              values (${claimed.id}, 'unchanged')
            `;

            const blockerUrl = new URL(configuredUrl);
            blockerUrl.searchParams.set(
              'options',
              `-csearch_path=${schemaName} -capplication_name=phase4_deadline_blocker`
            );
            blocker = postgres(blockerUrl.toString(), { max: 1 });
            const blockerEntered = deferred<number>();
            const releaseBlocker = deferred<void>();
            releaseFinalizerBlocker = () => releaseBlocker.resolve();
            const blockerWork = blocker.begin(async (connection) => {
              const [{ pid }] = await connection<{ pid: number }[]>`
                select pg_backend_pid()::int as pid
              `;
              await connection`
                select id from deadline_test_barriers
                where id = ${claimed.id}
                for update
              `;
              blockerEntered.resolve(pid);
              await releaseBlocker.promise;
            });
            const blockerPid = await blockerEntered.promise;
            let operationSignal: AbortSignal | undefined;
            const finalizerEntered = deferred<number>();
            const processing = processClaimedJob(claimed, runtimeWith({
              transcribe: async (_sourceAssetId, authority) => {
                operationSignal = authority.operationSignal;
                await beginExternalEffectBoundary();
                await withAuthorizedJobSuccessTransaction(
                  authority,
                  async (tx) => {
                    await tx.execute(sql`
                      insert into deadline_test_effects (job_id, value)
                      values (${claimed.id}, 'transactional-domain-effect')
                    `);
                  },
                  undefined,
                  async (tx) => {
                    const rows = await tx.execute<{ pid: number }>(sql`
                      select pg_backend_pid()::int as pid
                    `);
                    finalizerEntered.resolve(rows[0]!.pid);
                    await tx.execute(sql`
                      update deadline_test_barriers
                      set value = 'terminal-success'
                      where id = ${claimed.id}
                    `);
                  }
                );
                throw new Error('The deadline barrier unexpectedly completed.');
              },
            }));

            const finalizerPid = await finalizerEntered.promise;
            assert.notEqual(finalizerPid, blockerPid);
            await waitForCondition(async () => {
              const rows = await admin<{ pid: number }[]>`
                select pid::int as pid
                from pg_stat_activity
                where pid = ${finalizerPid}
                  and wait_event_type = 'Lock'
                  and query ilike '%deadline_test_barriers%'
              `;
              return rows.length === 1;
            });
            await waitForCondition(async () => Boolean(operationSignal?.aborted));

            const replacementToken = randomUUID();
            const replaceToken = replaceLeaseToken
              ? contender`
                  update jobs
                  set lease_token = ${replacementToken}
                  where id = ${claimed.id}
                `
              : Promise.resolve([]);
            releaseBlocker.resolve();
            await blockerWork;
            await replaceToken;
            const result = await processing;

            const effects = await contender<{ count: number }[]>`
              select count(*)::int as count
              from deadline_test_effects
              where job_id = ${claimed.id}
            `;
            const [barrier] = await contender<{ value: string }[]>`
              select value from deadline_test_barriers where id = ${claimed.id}
            `;
            const [persistedJob] = await db.select().from(schema.jobs)
              .where(eq(schema.jobs.id, claimed.id));
            assert.equal(effects[0]?.count, 0);
            assert.equal(barrier?.value, 'unchanged');
            if (replaceLeaseToken) {
              assert.equal(result.status, 'lease_lost');
              assert.equal(persistedJob.status, schema.JobStatus.PROCESSING);
              assert.equal(persistedJob.leaseToken, replacementToken);
            } else {
              assert.equal(result.status, 'failed');
              assert.equal(
                'failureCode' in result ? result.failureCode : null,
                'external_effect_ambiguous'
              );
              assert.equal(persistedJob.status, schema.JobStatus.FAILED);
              assert.equal(persistedJob.leaseToken, null);
            }
          } finally {
            if (originalTimeout === undefined) {
              delete process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS;
            } else {
              process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS = originalTimeout;
            }
            releaseFinalizerBlocker?.();
            await blocker?.end();
            await cleanupUser(fixture.user.id);
          }
        }
      );
    }

    for (const heartbeatOutcome of ['false', 'throws'] as const) {
      await t.test(`heartbeat ${heartbeatOutcome} fences production transcription persistence`, async () => {
        const fixture = await createSource('audio/mpeg');
        try {
          const queued = await enqueueTranscriptionJob(fixture.sourceAsset.id, fixture.user.id);
          assert.ok(queued);
          const claimed = await claimExpected(queued.id);
          const externalStarted = deferred<void>();
          const releaseExternal = deferred<void>();
          const timerControl: { heartbeatCallback?: () => void } = {};
          const external: TranscriptionExternalOperations = {
            transcribe: async () => {
              await beginExternalEffectBoundary();
              externalStarted.resolve();
              await releaseExternal.promise;
              return {
                content: 'Transcribed source content.',
                language: 'en',
                segments: [{
                  sequence: 0,
                  startTimeMs: 0,
                  endTimeMs: 30_000,
                  text: 'Transcribed source content.',
                }],
                words: [],
              };
            },
          };
          const runtime = runtimeWith({
            transcribe: (sourceAssetId, authority) =>
              transcribeSourceAsset(sourceAssetId, authority, external),
          });
          runtime.lease.heartbeat = heartbeatOutcome === 'false'
            ? async () => false
            : async () => { throw new Error('heartbeat unavailable'); };
          runtime.timer = {
            startHeartbeat: (callback) => {
              timerControl.heartbeatCallback = callback;
              return callback;
            },
            stopHeartbeat: () => undefined,
          };
          const processing = processClaimedJob(claimed, runtime);
          await externalStarted.promise;
          if (heartbeatOutcome === 'false') {
            await contender`update jobs set lease_token = ${randomUUID()} where id = ${claimed.id}`;
          }
          assert.ok(timerControl.heartbeatCallback);
          timerControl.heartbeatCallback();
          await Promise.resolve();
          await Promise.resolve();
          releaseExternal.resolve();

          const result = await processing;
          assert.equal(result.status, 'lease_lost');
          const [transcript] = await db.select().from(schema.transcripts)
            .where(eq(schema.transcripts.sourceAssetId, fixture.sourceAsset.id));
          const segments = await db.select().from(schema.transcriptSegments)
            .where(eq(schema.transcriptSegments.transcriptId, transcript.id));
          assert.equal(transcript.status, schema.TranscriptStatus.PROCESSING);
          assert.equal(segments.length, 0);
        } finally {
          await cleanupUser(fixture.user.id);
        }
      });
    }

    await t.test('authority loss during provider failure suppresses production failure finalization', async () => {
      const fixture = await createSource('audio/mpeg');
      try {
        const queued = await enqueueTranscriptionJob(fixture.sourceAsset.id, fixture.user.id);
        assert.ok(queued);
        const claimed = await claimExpected(queued.id);
        const externalStarted = deferred<void>();
        const releaseExternal = deferred<void>();
        const external: TranscriptionExternalOperations = {
          transcribe: async () => {
            await beginExternalEffectBoundary();
            externalStarted.resolve();
            await releaseExternal.promise;
            throw new Error('transcription provider failed');
          },
        };
        const processing = processClaimedJob(claimed, runtimeWith({
          transcribe: (sourceAssetId, authority) =>
            transcribeSourceAsset(sourceAssetId, authority, external),
        }));
        await externalStarted.promise;
        const replacementToken = randomUUID();
        await contender`update jobs set lease_token = ${replacementToken} where id = ${claimed.id}`;
        releaseExternal.resolve();

        const result = await processing;
        assert.equal(result.status, 'lease_lost');
        const [transcript] = await db.select().from(schema.transcripts)
          .where(eq(schema.transcripts.sourceAssetId, fixture.sourceAsset.id));
        const [persistedJob] = await db.select().from(schema.jobs)
          .where(eq(schema.jobs.id, claimed.id));
        const failureNotifications = await db.select().from(schema.notifications)
          .where(and(
            eq(schema.notifications.userId, fixture.user.id),
            eq(schema.notifications.type, 'transcript_failed')
          ));
        assert.equal(transcript.status, schema.TranscriptStatus.PROCESSING);
        assert.equal(persistedJob.status, schema.JobStatus.PROCESSING);
        assert.equal(persistedJob.leaseToken, replacementToken);
        assert.equal(failureNotifications.length, 0);
      } finally {
        await cleanupUser(fixture.user.id);
      }
    });

    await t.test('generation supersession after AI work suppresses candidates, assets, and jobs', async () => {
      const fixture = await addReadyTranscriptAndPack(await createSource('audio/mpeg'));
      try {
        const queued = await enqueueShortFormPackJob(
          fixture.contentPack.id,
          fixture.sourceAsset.id,
          fixture.transcript.id,
          fixture.user.id
        );
        const claimed = await claimExpected(queued.id);
        const externalStarted = deferred<void>();
        const releaseExternal = deferred<void>();
        const external: ShortFormGenerationExternalOperations = {
          rankWindows: async (params) => {
            await beginExternalEffectBoundary();
            externalStarted.resolve();
            await releaseExternal.promise;
            return [rankedCandidate(params.windows[0]!.id)];
          },
          generatePackageAssets: async () => [],
        };
        const processing = processClaimedJob(claimed, runtimeWith({
          generateShortForm: (contentPackId, generationRunId, authority) =>
            generateShortFormPack(contentPackId, generationRunId, authority, external),
        }));
        await externalStarted.promise;
        await contender`update content_packs set generation_run_id = ${randomUUID()} where id = ${fixture.contentPack.id}`;
        releaseExternal.resolve();

        const result = await processing;
        assert.equal(result.status, 'lease_lost');
        const candidates = await db.select().from(schema.clipCandidates)
          .where(eq(schema.clipCandidates.contentPackId, fixture.contentPack.id));
        const assets = await db.select().from(schema.generatedAssets)
          .where(eq(schema.generatedAssets.contentPackId, fixture.contentPack.id));
        const downstreamJobs = await db.select().from(schema.jobs)
          .where(eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM));
        assert.equal(candidates.length, 0);
        assert.equal(assets.length, 0);
        assert.equal(
          downstreamJobs.filter((job) =>
            'contentPackId' in job.payload &&
            job.payload.contentPackId === fixture.contentPack.id
          ).length,
          0
        );
      } finally {
        await cleanupUser(fixture.user.id);
      }
    });

    await t.test('facecam completion after cancellation cannot persist ready state or enqueue rendering', async () => {
      const fixture = await addReadyTranscriptAndPack(await createSource('video/mp4'));
      try {
        const [candidate] = await db.insert(schema.clipCandidates).values({
          userId: fixture.user.id,
          contentPackId: fixture.contentPack.id,
          sourceAssetId: fixture.sourceAsset.id,
          transcriptId: fixture.transcript.id,
          generationRunId: fixture.generationRunId,
          rank: 1,
          startTimeMs: 0,
          endTimeMs: 30_000,
          durationMs: 30_000,
          hook: 'Hook',
          title: 'Title',
          captionCopy: 'Caption',
          summary: 'Summary',
          transcriptExcerpt: 'Transcript excerpt',
          whyItWorks: 'Reason',
          platformFit: 'Video',
          confidence: 90,
        }).returning();
        const queued = await enqueueDetectCandidateFacecamJob(candidate);
        const claimed = await claimExpected(queued.job.id);
        const externalStarted = deferred<void>();
        const releaseExternal = deferred<void>();
        const external: CandidateFacecamExternalOperations = {
          createDownload: () => ({ method: 'GET', downloadUrl: 'https://example.test/source' }),
          detectRegions: async () => {
            await beginExternalEffectBoundary();
            externalStarted.resolve();
            await releaseExternal.promise;
            return {
              frameWidth: 1920,
              frameHeight: 1080,
              sampledFrameCount: 10,
              candidates: [{
                rank: 1,
                xPx: 100,
                yPx: 100,
                widthPx: 500,
                heightPx: 500,
                confidence: 95,
              }],
            };
          },
        };
        const processing = processClaimedJob(claimed, runtimeWith({
          detectCandidateFacecam: (params) => detectCandidateFacecam(params, external),
        }));
        await externalStarted.promise;
        await contender`update jobs set cancellation_requested_at = clock_timestamp() where id = ${claimed.id}`;
        releaseExternal.resolve();

        const result = await processing;
        assert.equal(result.status, 'lease_lost');
        const [detectionRun] = await db.select()
          .from(schema.clipCandidateFacecamDetectionRuns)
          .where(eq(schema.clipCandidateFacecamDetectionRuns.jobId, claimed.id));
        const detections = await db.select()
          .from(schema.clipCandidateFacecamDetections)
          .where(eq(schema.clipCandidateFacecamDetections.detectionRunId, detectionRun.id));
        const renderJobs = await db.select().from(schema.jobs)
          .where(eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM));
        assert.equal(detectionRun.status, schema.FacecamDetectionStatus.DETECTING);
        assert.equal(detections.length, 0);
        assert.equal(
          renderJobs.filter((job) =>
            'clipCandidateId' in job.payload && job.payload.clipCandidateId === candidate.id
          ).length,
          0
        );
      } finally {
        await cleanupUser(fixture.user.id);
      }
    });

    await t.test('same-token missing candidate atomically requeues generation and cancels the stale job', async () => {
      const fixture = await addReadyTranscriptAndPack(await createSource('audio/mpeg'));
      try {
        await db.update(schema.contentPacks)
          .set({ status: schema.ContentPackStatus.GENERATING })
          .where(eq(schema.contentPacks.id, fixture.contentPack.id));
        const [candidate] = await db.insert(schema.clipCandidates).values({
          userId: fixture.user.id,
          contentPackId: fixture.contentPack.id,
          sourceAssetId: fixture.sourceAsset.id,
          transcriptId: fixture.transcript.id,
          generationRunId: fixture.generationRunId,
          rank: 1,
          startTimeMs: 0,
          endTimeMs: 30_000,
          durationMs: 30_000,
          hook: 'Hook',
          title: 'Title',
          captionCopy: 'Caption',
          summary: 'Summary',
          transcriptExcerpt: 'Transcript excerpt',
          whyItWorks: 'Reason',
          platformFit: 'Video',
          confidence: 90,
        }).returning();
        const [job] = await db.insert(schema.jobs).values({
          type: schema.JobType.RENDER_CLIP_CANDIDATE,
          status: schema.JobStatus.PENDING,
          idempotencyKey: `phase1c:missing-candidate:${randomUUID()}`,
          payload: {
            sourceAssetId: fixture.sourceAsset.id,
            contentPackId: fixture.contentPack.id,
            clipCandidateId: candidate.id,
            userId: fixture.user.id,
            generationRunId: fixture.generationRunId,
          },
        }).returning();
        const claimed = await claimExpected(job.id);
        await contender`delete from clip_candidates where id = ${candidate.id}`;
        let stageStarted = false;

        const result = await processClaimedJob(claimed, runtimeWith({
          renderClip: async () => {
            stageStarted = true;
            throw new Error('Missing-candidate recovery must not execute the stage.');
          },
        }));

        assert.equal(result.status, 'cancelled');
        assert.equal(stageStarted, false);
        const [persistedJob] = await db.select().from(schema.jobs)
          .where(eq(schema.jobs.id, claimed.id));
        const [persistedPack] = await db.select().from(schema.contentPacks)
          .where(eq(schema.contentPacks.id, fixture.contentPack.id));
        const generationJobs = (await db.select().from(schema.jobs))
          .filter((candidateJob) =>
            candidateJob.type === schema.JobType.GENERATE_SHORT_FORM_PACK &&
            'contentPackId' in candidateJob.payload &&
            candidateJob.payload.contentPackId === fixture.contentPack.id
          );
        assert.equal(generationJobs.length, 1);
        assert.equal(persistedPack.status, schema.ContentPackStatus.PENDING);
        assert.equal(persistedPack.failureReason, null);
        assert.equal(persistedJob.status, schema.JobStatus.CANCELLED);
        assert.equal(persistedJob.failureReason, StaleJobReason.CLIP_CANDIDATE_MISSING);
        assert.equal(persistedJob.leaseToken, null);
        assert.equal(persistedJob.leaseExpiresAt, null);
      } finally {
        await cleanupUser(fixture.user.id);
      }
    });

    await t.test('deletion intent blocks missing-candidate cancellation from requeueing generation', async () => {
      const fixture = await addReadyTranscriptAndPack(await createSource('audio/mpeg'));
      try {
        await db.update(schema.contentPacks)
          .set({ status: schema.ContentPackStatus.GENERATING })
          .where(eq(schema.contentPacks.id, fixture.contentPack.id));
        const [candidate] = await db.insert(schema.clipCandidates).values({
          userId: fixture.user.id,
          contentPackId: fixture.contentPack.id,
          sourceAssetId: fixture.sourceAsset.id,
          transcriptId: fixture.transcript.id,
          generationRunId: fixture.generationRunId,
          rank: 1,
          startTimeMs: 0,
          endTimeMs: 30_000,
          durationMs: 30_000,
          hook: 'Hook',
          title: 'Title',
          captionCopy: 'Caption',
          summary: 'Summary',
          transcriptExcerpt: 'Transcript excerpt',
          whyItWorks: 'Reason',
          platformFit: 'Video',
          confidence: 90,
        }).returning();
        const [job] = await db.insert(schema.jobs).values({
          type: schema.JobType.RENDER_CLIP_CANDIDATE,
          status: schema.JobStatus.PENDING,
          idempotencyKey: `phase2:deleting-missing-candidate:${randomUUID()}`,
          payload: {
            sourceAssetId: fixture.sourceAsset.id,
            contentPackId: fixture.contentPack.id,
            clipCandidateId: candidate.id,
            userId: fixture.user.id,
            generationRunId: fixture.generationRunId,
          },
        }).returning();
        const claimed = await claimExpected(job.id);
        await contender`delete from clip_candidates where id = ${candidate.id}`;
        await contender`update projects set deletion_requested_at = clock_timestamp() where id = ${fixture.project.id}`;
        await contender`update jobs set cancellation_requested_at = clock_timestamp(), cancellation_reason = 'project_deleted' where id = ${claimed.id}`;

        const result = await processClaimedJob(claimed, runtimeWith());
        assert.equal(result.status, 'lease_lost');
        const generationJobs = (await db.select().from(schema.jobs)).filter((candidateJob) =>
          candidateJob.type === schema.JobType.GENERATE_SHORT_FORM_PACK &&
          'contentPackId' in candidateJob.payload &&
          candidateJob.payload.contentPackId === fixture.contentPack.id
        );
        const [persistedPack] = await db.select().from(schema.contentPacks)
          .where(eq(schema.contentPacks.id, fixture.contentPack.id));
        assert.equal(generationJobs.length, 0);
        assert.equal(persistedPack.status, schema.ContentPackStatus.GENERATING);
      } finally {
        await cleanupUser(fixture.user.id);
      }
    });

    await t.test('authority loss after freshness validation rolls back stale cancellation effects', async () => {
      const fixture = await addReadyTranscriptAndPack(await createSource('audio/mpeg'));
      try {
        await db.update(schema.contentPacks)
          .set({ status: schema.ContentPackStatus.GENERATING })
          .where(eq(schema.contentPacks.id, fixture.contentPack.id));
        const [candidate] = await db.insert(schema.clipCandidates).values({
          userId: fixture.user.id,
          contentPackId: fixture.contentPack.id,
          sourceAssetId: fixture.sourceAsset.id,
          transcriptId: fixture.transcript.id,
          generationRunId: fixture.generationRunId,
          rank: 1,
          startTimeMs: 0,
          endTimeMs: 30_000,
          durationMs: 30_000,
          hook: 'Hook',
          title: 'Title',
          captionCopy: 'Caption',
          summary: 'Summary',
          transcriptExcerpt: 'Transcript excerpt',
          whyItWorks: 'Reason',
          platformFit: 'Video',
          confidence: 90,
        }).returning();
        const [job] = await db.insert(schema.jobs).values({
          type: schema.JobType.RENDER_CLIP_CANDIDATE,
          status: schema.JobStatus.PENDING,
          idempotencyKey: `phase1c:stale:${randomUUID()}`,
          payload: {
            sourceAssetId: fixture.sourceAsset.id,
            contentPackId: fixture.contentPack.id,
            clipCandidateId: candidate.id,
            userId: fixture.user.id,
            generationRunId: fixture.generationRunId,
          },
        }).returning();
        const claimed = await claimExpected(job.id);
        const freshnessValidated = deferred<void>();
        const releaseFreshness = deferred<void>();
        const processing = processClaimedJob(claimed, runtimeWith({}, {
          validateFreshness: async () => {
            freshnessValidated.resolve();
            await releaseFreshness.promise;
            return {
              reason: StaleJobReason.CLIP_CANDIDATE_MISSING,
              projectId: fixture.project.id,
              sourceAssetId: fixture.sourceAsset.id,
              contentPackId: fixture.contentPack.id,
              clipCandidateId: candidate.id,
              generationRunId: fixture.generationRunId,
            };
          },
        }));
        await freshnessValidated.promise;
        await contender.begin(async (tx) => {
          await tx`delete from clip_candidates where id = ${candidate.id}`;
          await tx`update jobs set lease_token = ${randomUUID()} where id = ${claimed.id}`;
        });
        releaseFreshness.resolve();

        const result = await processing;
        assert.equal(result.status, 'lease_lost');
        const [persistedJob] = await db.select().from(schema.jobs)
          .where(eq(schema.jobs.id, claimed.id));
        const [persistedPack] = await db.select().from(schema.contentPacks)
          .where(eq(schema.contentPacks.id, fixture.contentPack.id));
        const generationJobs = await db.select().from(schema.jobs)
          .where(eq(schema.jobs.type, schema.JobType.GENERATE_SHORT_FORM_PACK));
        assert.equal(persistedJob.status, schema.JobStatus.PROCESSING);
        assert.equal(persistedPack.status, schema.ContentPackStatus.GENERATING);
        assert.equal(
          generationJobs.filter((candidateJob) =>
            'contentPackId' in candidateJob.payload &&
            candidateJob.payload.contentPackId === fixture.contentPack.id
          ).length,
          0
        );
      } finally {
        await cleanupUser(fixture.user.id);
      }
    });

    await t.test('expired generation lease reclaims and replays one durable candidate and downstream identity', async () => {
      const fixture = await addReadyTranscriptAndPack(await createSource('audio/mpeg'));
      try {
        const queued = await enqueueShortFormPackJob(
          fixture.contentPack.id,
          fixture.sourceAsset.id,
          fixture.transcript.id,
          fixture.user.id
        );
        const firstClaim = await claimExpected(queued.id);
        assert.equal(firstClaim.type, schema.JobType.GENERATE_SHORT_FORM_PACK);
        if (firstClaim.type !== schema.JobType.GENERATE_SHORT_FORM_PACK) {
          throw new Error('Expected a generation job.');
        }
        const external: ShortFormGenerationExternalOperations = {
          rankWindows: async (params) => [rankedCandidate(params.windows[0]!.id)],
          generatePackageAssets: async () => [],
        };
        await generateShortFormPack(
          fixture.contentPack.id,
          firstClaim.payload.generationRunId,
          { jobId: firstClaim.id, leaseToken: firstClaim.leaseToken! },
          external
        );
        const firstCandidates = await db.select().from(schema.clipCandidates)
          .where(eq(schema.clipCandidates.contentPackId, fixture.contentPack.id));
        const firstDownstreamJobs = (await db.select().from(schema.jobs))
          .filter((candidateJob) =>
            candidateJob.id !== firstClaim.id &&
            'contentPackId' in candidateJob.payload &&
            candidateJob.payload.contentPackId === fixture.contentPack.id
          );
        assert.equal(firstCandidates.length, 1);
        assert.ok(firstDownstreamJobs.length > 0);
        await db.insert(schema.jobEffectCheckpoints).values({
          jobId: firstClaim.id,
          effectKey: 'primary_external_effect_v1',
          jobType: schema.JobType.GENERATE_SHORT_FORM_PACK,
          status: schema.JobEffectCheckpointStatus.COMPLETED,
          result: {
            jobType: schema.JobType.GENERATE_SHORT_FORM_PACK,
            sourceAssetId: fixture.sourceAsset.id,
            contentPackId: fixture.contentPack.id,
            generationRunId: firstClaim.payload.generationRunId,
            persistedAt: new Date().toISOString(),
          },
          externalEffectStartedAt: new Date(),
          completedAt: new Date(),
        });

        await contender`update jobs set available_at = clock_timestamp() + interval '1 day' where id <> ${firstClaim.id} and payload->>'userId' = ${String(fixture.user.id)}`;
        await contender`update jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${firstClaim.id}`;
        const replayClaim = await claimExpected(firstClaim.id);
        assert.notEqual(replayClaim.leaseToken, firstClaim.leaseToken);
        let replayCalledAi = false;
        const replayResult = await processClaimedJob(replayClaim, runtimeWith({
          generateShortForm: (contentPackId, generationRunId, authority) =>
            generateShortFormPack(contentPackId, generationRunId, authority, {
              rankWindows: async () => {
                replayCalledAi = true;
                throw new Error('Replay should reuse persisted candidates.');
              },
              generatePackageAssets: async () => [],
            }),
        }));
        assert.equal(replayResult.status, 'completed');
        assert.equal(replayCalledAi, false);

        const replayCandidates = await db.select().from(schema.clipCandidates)
          .where(eq(schema.clipCandidates.contentPackId, fixture.contentPack.id));
        const replayDownstreamJobs = (await db.select().from(schema.jobs))
          .filter((candidateJob) =>
            candidateJob.id !== firstClaim.id &&
            'contentPackId' in candidateJob.payload &&
            candidateJob.payload.contentPackId === fixture.contentPack.id
          );
        assert.equal(replayCandidates.length, 1);
        assert.deepEqual(
          replayDownstreamJobs.map((candidateJob) => candidateJob.idempotencyKey).sort(),
          firstDownstreamJobs.map((candidateJob) => candidateJob.idempotencyKey).sort()
        );
      } finally {
        await cleanupUser(fixture.user.id);
      }
    });
  } finally {
    await client.end();
    await contender.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
