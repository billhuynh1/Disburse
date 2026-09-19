import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import postgres from 'postgres';

import { assertDisposablePostgresTestDatabase } from '../db/test-database-guard.ts';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('recovery correctness through production render, checkpoint and reconciliation paths', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async (t) => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  assertDisposablePostgresTestDatabase(configuredUrl);
  const schemaName = `snapshot_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  let appClient: { end(): Promise<void> } | undefined;

  const tempDir = await mkdtemp(path.join(tmpdir(), 'disburse-recovery-'));
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let puts = 0;
  let sourceFailures = 0;
  let failPut = false;
  let pauseSource: (() => Promise<void>) | undefined;
  try {
    const ffmpeg = path.join(tempDir, 'ffmpeg');
    await writeFile(ffmpeg, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv.at(-1), "verified-render");\n');
    await chmod(ffmpeg, 0o755);
    Object.assign(process.env, {
      FFMPEG_PATH: ffmpeg, S3_UPLOAD_ACCESS_KEY_ID: 'test', S3_UPLOAD_SECRET_ACCESS_KEY: 'test',
      S3_UPLOAD_PATH_STYLE: 'true', S3_UPLOAD_BUCKET: 'test', S3_UPLOAD_REGION: 'us-east-1', S3_UPLOAD_ENDPOINT: 'https://storage.example.test',
    });
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).hostname, 'storage.example.test');
      if (init?.method === 'PUT') {
        puts++;
        return new Response(null, { status: failPut ? 503 : 200 });
      }
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '15' } });
      const pause = pauseSource;
      pauseSource = undefined;
      await pause?.();
      if (sourceFailures-- > 0) throw new Error('pre-upload source download interrupted');
      return new Response('source-video');
    };
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`set search_path to "${schemaName}"`);
    const migrationDirectory = new URL('../db/migrations/', import.meta.url);
    for (const file of (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      const migration = await readFile(new URL(file, migrationDirectory), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) {
        const scoped = statement.trim().replaceAll('"public".', `"${schemaName}".`);
        if (scoped) await admin.unsafe(scoped);
      }
    }
    const isolatedUrl = new URL(configuredUrl);
    isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    process.env.POSTGRES_URL = isolatedUrl.toString();

    const { client, db } = await import('../db/drizzle.ts');
    appClient = client;
    const schema = await import('../db/schema.ts');
    const { materializeGenerationSnapshot } = await import('./generation-snapshot.ts');
    const { insertGenerationRun } = await import('./generation-run-service.ts');
    const { resolveCandidateEffectiveRenderConfig } = await import('./effective-render-config-service.ts');
    const { enqueueShortFormPackJob } = await import('./job-service.ts');
    const { reconcileShortFormContentPackStatus } = await import('./short-form-service.ts');
    const { reconcileProjectPipeline } = await import('./pipeline-reconciliation-service.ts');
    const { withAuthorizedJobSuccessTransaction } = await import('./job-execution-authorization.ts');

    const [user] = await db.insert(schema.users).values({ name: 'Snapshot lifecycle user', email: `snapshot-life-${randomUUID()}@example.test`, passwordHash: 'test' }).returning();
    const [project] = await db.insert(schema.projects).values({ userId: user.id, name: 'Snapshot lifecycle project', isSaved: true }).returning();
    const [source] = await db.insert(schema.sourceAssets).values({ userId: user.id, projectId: project.id, title: 'Source', assetType: schema.SourceAssetType.UPLOADED_FILE, mimeType: 'video/mp4', originalFilename: 'source.mp4', storageKey: `snapshot-life/${randomUUID()}.mp4`, storageUrl: 'storage://source', status: schema.SourceAssetStatus.READY }).returning();
    const [transcript] = await db.insert(schema.transcripts).values({ userId: user.id, sourceAssetId: source.id, content: 'Grounded source text.', status: schema.TranscriptStatus.READY }).returning();
    const [template] = await db.insert(schema.brandTemplates).values({ userId: user.id, name: 'Immutable template' }).returning();
    const generationRunId = randomUUID();
    const [pack] = await db.insert(schema.contentPacks).values({ userId: user.id, projectId: project.id, sourceAssetId: source.id, transcriptId: transcript.id, kind: schema.ContentPackKind.SHORT_FORM_CLIPS, name: 'Snapshot pack', generationRunId, shortFormGenerationMode: 'snapshot' }).returning();
    const snapshot = materializeGenerationSnapshot({
      brandTemplateId: template.id,
      ranking: { generationInstructions: 'Find clips.', clipLength: '30-60s', autoHookEnabled: true, contentPackage: 'clips_only' },
      facecam: { detectionEnabled: true, detectorVersion: 'snapshot-detector-v1', preferredLayout: schema.RenderedClipLayout.FACECAM_TOP_30, fallbackLayout: schema.RenderedClipLayout.DEFAULT },
      render: { aspectRatio: '9_16', captionsEnabled: false, captionStyle: 'default', captionFontAssetId: null, captionFontFamily: null, captionFontColor: '#ffffff', captionHighlightColor: '#facc15', captionPosition: 'bottom', captionAnimation: 'none', overlayLogoAssetId: null, introVideoAssetId: null, outroVideoAssetId: null, ctaUrl: 'https://example.test/cta', cropSettings: { sourceCrop: 'original' }, autoEditPreset: 'snapshot_preset' },
    });
    await insertGenerationRun({ generationRunId, contentPackId: pack.id, selectedBrandTemplateId: template.id, snapshot }, db);

    const makeCandidate = async (rank: number, target = { pack, generationRunId }) => (await db.insert(schema.clipCandidates).values({
      userId: user.id, contentPackId: target.pack.id, sourceAssetId: source.id, transcriptId: transcript.id, rank,
      startTimeMs: rank * 10_000, endTimeMs: rank * 10_000 + 8_000, durationMs: 8_000,
      hook: 'Hook', title: `Candidate ${rank}`, captionCopy: 'Caption', summary: 'Summary', transcriptExcerpt: 'Excerpt', whyItWorks: 'Why', platformFit: 'Fit', confidence: 90, generationRunId: target.generationRunId,
      facecamDetectionStatus: schema.FacecamDetectionStatus.NOT_FOUND,
    }).returning())[0]!;
    const resolve = (candidate: { id: number; contentPackId: number; sourceAssetId: number; userId: number; generationRunId: string }) => resolveCandidateEffectiveRenderConfig({ clipCandidateId: candidate.id, contentPackId: candidate.contentPackId, sourceAssetId: candidate.sourceAssetId, userId: candidate.userId, generationRunId: candidate.generationRunId, facecamStatus: schema.FacecamDetectionStatus.NOT_FOUND });
    const artifactFor = async (candidate: { id: number; title: string; startTimeMs: number; endTimeMs: number; durationMs: number }, config: { id: number; contentPackId: number; sourceAssetId: number; generationRunId: string; layout: string; configHash: string }, status: string) =>
      (await db.insert(schema.renderedClips).values({
        userId: user.id, contentPackId: config.contentPackId, sourceAssetId: config.sourceAssetId, clipCandidateId: candidate.id,
        generationRunId: config.generationRunId, variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM, layout: config.layout,
        clipRenderConfigId: config.id, editConfigHash: config.configHash, status, title: candidate.title,
        startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, durationMs: candidate.durationMs,
        ...(status === schema.RenderedClipStatus.READY ? { storageKey: `snapshot/${randomUUID()}.mp4`, storageUrl: 'storage://ready', mimeType: 'video/mp4' } : { storageKey: `snapshot/${randomUUID()}.mp4`, storageUrl: 'storage://pending', failureReason: null }),
      }).returning())[0]!;
    const exactRenderJobs = async (candidateId: number, renderConfigId: number) =>
      (await db.select().from(schema.jobs).where(eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM)))
        .filter((job) => {
          const payload = job.payload as { clipCandidateId?: number; renderConfigId?: number };
          return payload.clipCandidateId === candidateId && payload.renderConfigId === renderConfigId;
        });
    const createSnapshotPack = async (name: string) => {
      const runId = randomUUID();
      const [targetPack] = await db.insert(schema.contentPacks).values({ userId: user.id, projectId: project.id, sourceAssetId: source.id, transcriptId: transcript.id, kind: schema.ContentPackKind.SHORT_FORM_CLIPS, name, generationRunId: runId, shortFormGenerationMode: 'snapshot' }).returning();
      await insertGenerationRun({ generationRunId: runId, contentPackId: targetPack!.id, selectedBrandTemplateId: template.id, snapshot }, db);
      return { pack: targetPack!, generationRunId: runId };
    };

    const { claimNextJob, heartbeatJobLease, markJobCompleted, markJobFailed, withAuthorizedJobFailure } = await import('./job-service.ts');
    const { processClaimedJob, productionPipelineProcessingRuntime } = await import('./pipeline-service.ts');
    const { runCheckpointedExternalEffect, getCompletedCheckpointForJob, persistCompletedJobCheckpoint } = await import('./job-effect-checkpoint-service.ts');
    const { requestJobRecovery } = await import('./job-recovery-service.ts');
    const { markRenderedClipFailed } = await import('./rendered-clip-service.ts');
    const runtime = { ...productionPipelineProcessingRuntime, downstream: { trigger: () => {} } };
    const renderTypes = [schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM];
    const claim = async (id: number) => {
      const job = await claimNextJob({ allowedJobTypes: renderTypes });
      assert.ok(job); assert.equal(job.id, id); return job;
    };
    const fixture = async (name: string) => {
      const target = await createSnapshotPack(name);
      const candidate = await makeCandidate(1, target);
      const resolved = await resolve(candidate);
      return { ...target, candidate, ...resolved };
    };
    const readArtifact = (id: number) => db.query.renderedClips.findFirst({ where: eq(schema.renderedClips.clipCandidateId, id) });
    const readJob = (id: number) => db.query.jobs.findFirst({ where: eq(schema.jobs.id, id) });
    const expire = async (id: number) => db.update(schema.jobs).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.jobs.id, id));
    const checkpointResult = (job: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>, artifact: NonNullable<Awaited<ReturnType<typeof readArtifact>>>) => ({
      jobType: schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM as import('../db/schema.ts').JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      sourceAssetId: source.id, contentPackId: artifact.contentPackId, clipCandidateId: artifact.clipCandidateId,
      renderedClipId: artifact.id, variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM,
      layout: artifact.layout as import('../db/schema.ts').RenderedClipLayout, persistedAt: new Date(),
    });

    await t.test('PREPARED + RENDERING same-config reclaim actually renders and fences original success/failure', async () => {
      const f = await fixture('reclaim');
      const a = await claim(f.job.id);
      await artifactFor(f.candidate, f.config, schema.RenderedClipStatus.RENDERING);
      await db.insert(schema.jobEffectCheckpoints).values({jobId: a.id, effectKey:'primary_external_effect_v1',jobType:a.type,status:'prepared'});
      await expire(a.id);
      const b = await claim(a.id);
      assert.notEqual(b.leaseToken,a.leaseToken);
      assert.deepEqual(b.payload,a.payload);
      assert.equal(await heartbeatJobLease(a.id,a.leaseToken!),false);
      await assert.rejects(markJobCompleted(a.id,a.leaseToken!));
      assert.equal(await markJobFailed(a.id,'stale',a.leaseToken!),false);
      const before=puts;
      assert.equal((await processClaimedJob(b,runtime)).status,'completed');
      assert.equal(puts,before+1);
      assert.equal((await readArtifact(f.candidate.id))!.status,'ready');
      assert.ok(await getCompletedCheckpointForJob(b.id,b.type));
      await assert.rejects(withAuthorizedJobFailure({jobId:a.id,leaseToken:a.leaseToken!},'stale',async tx=> {
        await markRenderedClipFailed(f.candidate.id,user.id,schema.RenderedClipVariant.VERTICAL_SHORT_FORM,'stale',schema.RenderedClipLayout.DEFAULT,tx,{renderConfigId:f.config.id,generationRunId:f.generationRunId});
      }));
      assert.equal((await readArtifact(f.candidate.id))!.status,'ready');
    });

    await t.test('in-flight original cannot upload or publish after replacement claim', async () => {
      const f = await fixture('in-flight reclaim');
      const original = await claim(f.job.id);
      let release!: () => void;
      let entered!: () => void;
      const downloaded = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      pauseSource = async () => { entered(); await blocked; };
      const staleExecution = processClaimedJob(original, runtime);
      await downloaded;
      assert.equal((await readArtifact(f.candidate.id))!.status, 'rendering');
      await expire(original.id);
      const replacement = await claim(original.id);
      const before = puts;
      try {
        assert.equal((await processClaimedJob(replacement, runtime)).status, 'completed');
      } finally { release(); }
      const published = await readArtifact(f.candidate.id);
      assert.equal((await staleExecution).status, 'lease_lost');
      assert.equal(puts, before + 1);
      assert.deepEqual(await readArtifact(f.candidate.id), published);
      assert.equal((await readJob(original.id))!.status, 'completed');
    });

    await t.test('checkpoint write failure rolls publication back atomically and fails closed', async () => {
      const f = await fixture('checkpoint write failure');
      const job = await claim(f.job.id);
      await admin.unsafe(`create function reject_checkpoint() returns trigger language plpgsql as $$ begin if NEW.job_id = ${job.id} and NEW.status = 'completed' then raise exception 'injected checkpoint write failure'; end if; return NEW; end $$`);
      await admin.unsafe('create trigger reject_checkpoint before insert or update on job_effect_checkpoints for each row execute function reject_checkpoint()');
      try {
        assert.equal((await processClaimedJob(job, runtime)).status, 'failed');
      } finally {
        await admin.unsafe('drop trigger reject_checkpoint on job_effect_checkpoints');
        await admin.unsafe('drop function reject_checkpoint()');
      }
      assert.equal((await readJob(job.id))!.failureClass, 'ambiguous_external_effect');
      assert.equal(await getCompletedCheckpointForJob(job.id, job.type), null);
      const artifact = (await readArtifact(f.candidate.id))!;
      assert.equal(artifact.status, 'failed');
      const notifications = await db.select().from(schema.notifications).where(eq(schema.notifications.entityId, artifact.id));
      assert.deepEqual(notifications.filter(n => n.type === 'rendered_clip').map(n => n.status), ['failure']);
    });

    await t.test('safe pre-upload failure requeues then reacquires RENDERING',async()=>{
      const f=await fixture('pre-upload retry');
      const a=await claim(f.job.id); sourceFailures=1;
      const before=puts;
      assert.equal((await processClaimedJob(a,runtime)).status,'requeued');
      assert.equal((await readArtifact(f.candidate.id))!.status,'rendering');
      assert.equal(puts,before);
      const b=await claim(a.id);
      assert.equal((await processClaimedJob(b,runtime)).status,'completed');
      assert.equal(puts,before+1);
    });

    await t.test('candidate RETRY after safe exhaustion reuses the same config and completes', async () => {
      const f = await fixture('safe terminal retry');
      await db.update(schema.jobs).set({ maxAttempts: 1 }).where(eq(schema.jobs.id, f.job.id));
      const job = await claim(f.job.id);
      sourceFailures = 1;
      const before = puts;
      assert.equal((await processClaimedJob(job, runtime)).status, 'failed');
      assert.equal((await readJob(job.id))!.failureClass, 'safe_no_external_effect');
      assert.equal((await readArtifact(f.candidate.id))!.status, 'failed');
      const recovery = await requestJobRecovery({ requestedBy: 'user', userId: user.id, jobId: job.id, mode: schema.JobRecoveryMode.RETRY, idempotencyKey: randomUUID() });
      assert.equal(recovery.outcome, 'accepted');
      const successor = await claim(recovery.successorJobId!);
      assert.deepEqual(successor.payload, job.payload);
      assert.equal((await processClaimedJob(successor, runtime)).status, 'completed');
      assert.equal(puts, before + 1);
      const artifact = (await readArtifact(f.candidate.id))!;
      assert.equal(artifact.status, 'ready');
      assert.equal(artifact.clipRenderConfigId, f.config.id);
    });

    await t.test('artifact ID and RENDERING cannot complete checkpoint or job; wrong READY sibling cannot substitute',async()=>{
      const f=await fixture('postcondition'); const job=await claim(f.job.id);
      const artifact=await artifactFor(f.candidate,f.config,'rendering');
      await assert.rejects(runCheckpointedExternalEffect(job,async()=>checkpointResult(job,artifact)),/render_result_not_ready/);
      assert.equal(await getCompletedCheckpointForJob(job.id,job.type),null);
      await assert.rejects(markJobCompleted(job.id,job.leaseToken!),/render_result_not_ready/);
      const sibling=await makeCandidate(2,{pack:f.pack,generationRunId:f.generationRunId});
      const siblingConfig=await resolve(sibling); const readySibling=await artifactFor(sibling,siblingConfig.config,'ready');
      await assert.rejects(runCheckpointedExternalEffect(job,async()=>checkpointResult(job,readySibling)),/render_result/);
      await markJobFailed(job.id,'exhausted',job.leaseToken!);
      await db.update(schema.jobs).set({status:'completed'}).where(eq(schema.jobs.id,siblingConfig.job.id));
    });

    await t.test('READY publication persists provenance before continuation errors and never emits failure for the clip',async()=>{
      const f=await fixture('publication'); const job=await claim(f.job.id);
      const result=await processClaimedJob(job,{
        ...runtime,processors:{...runtime.processors,formatClip:async (...args)=>{
          const clip=await runtime.processors.formatClip(...args);
          assert.equal(clip.status,'ready');
          assert.ok(await getCompletedCheckpointForJob(job.id,job.type));
          throw new Error('continuation database failure after publication');
        }}
      });
      assert.equal(result.status,'failed');
      assert.equal((await readJob(job.id))!.failureClass,'durable_checkpoint');
      const clip=(await readArtifact(f.candidate.id))!;
      assert.equal(clip.status,'ready');
      await markRenderedClipFailed(f.candidate.id,user.id,schema.RenderedClipVariant.VERTICAL_SHORT_FORM,'late failure',schema.RenderedClipLayout.DEFAULT,db,{renderConfigId:f.config.id,generationRunId:f.generationRunId});
      assert.equal((await readArtifact(f.candidate.id))!.status,'ready');
      const notifications=await db.select().from(schema.notifications).where(eq(schema.notifications.userId,user.id));
      assert.deepEqual(notifications.filter(n => n.type === 'rendered_clip' && n.entityId === clip.id).map(n => n.status), ['success']);
      const recovery=await requestJobRecovery({requestedBy:'user',userId:user.id,jobId:job.id,mode:schema.JobRecoveryMode.RESUME,idempotencyKey:randomUUID()});
      assert.equal(recovery.outcome,'accepted');
      assert.ok(await getCompletedCheckpointForJob(recovery.successorJobId!,job.type));
      // A crash before dispatch still leaves the new row's own durable provenance.
      const successor=await claim(recovery.successorJobId!); await expire(successor.id);
      const reclaimed=await claim(successor.id); const before=puts;
      const failed=await processClaimedJob(reclaimed,{
        ...runtime,downstream:{trigger:()=>{throw new Error('continuation failed after finalization');}}
      });
      // A post-completion callback failure cannot downgrade the terminal success.
      assert.equal((await readJob(reclaimed.id))!.status,'completed');
      assert.ok(await getCompletedCheckpointForJob(reclaimed.id,job.type));
      assert.equal((await readArtifact(f.candidate.id))!.status,'ready');
      assert.equal(puts,before);
      assert.ok(failed);
    });

    await t.test('RESUME failure before completion can RESUME again without repeating render',async()=>{
      const f=await fixture('resume chain'); const job=await claim(f.job.id);
      const clip=await artifactFor(f.candidate,f.config,'ready');
      await withAuthorizedJobSuccessTransaction({jobId:job.id,leaseToken:job.leaseToken!},async tx=> {
        await persistCompletedJobCheckpoint(tx,job,checkpointResult(job,clip));
      });
      await markJobFailed(job.id,'continuation failed',job.leaseToken!);
      const first=await requestJobRecovery({requestedBy:'user',userId:user.id,jobId:job.id,mode:schema.JobRecoveryMode.RESUME,idempotencyKey:randomUUID()});
      assert.equal(first.outcome,'accepted');
      const successor=await claim(first.successorJobId!);
      const before=puts;
      // Fail the actual completion transaction using a scoped DB trigger.
      await admin.unsafe(`create function reject_completion() returns trigger language plpgsql as $$ begin if NEW.id = ${successor.id} and NEW.status = 'completed' then raise exception 'injected finalization failure'; end if; return NEW; end $$`);
      await admin.unsafe(`create trigger reject_completion before update on jobs for each row execute function reject_completion()`);
      try {
        assert.equal((await processClaimedJob(successor,runtime)).status,'failed');
      } finally { await admin.unsafe('drop trigger reject_completion on jobs'); await admin.unsafe('drop function reject_completion()'); }
      assert.equal((await readJob(successor.id))!.failureClass,'durable_checkpoint');
      const second=await requestJobRecovery({requestedBy:'user',userId:user.id,jobId:successor.id,mode:schema.JobRecoveryMode.RESUME,idempotencyKey:randomUUID()});
      assert.equal(second.outcome,'accepted');
      const next=await claim(second.successorJobId!);
      assert.equal((await processClaimedJob(next,runtime)).status,'completed');
      assert.equal(puts,before);
      assert.equal((await readArtifact(f.candidate.id))!.status,'ready');
    });

    await t.test('started upload ambiguity remains terminal and cannot retry',async()=>{
      const f=await fixture('ambiguous'); const job=await claim(f.job.id); failPut=true;
      try { assert.equal((await processClaimedJob(job,runtime)).status,'failed'); } finally { failPut=false; }
      assert.equal((await readJob(job.id))!.failureClass,'ambiguous_external_effect');
      const retry=await requestJobRecovery({requestedBy:'user',userId:user.id,jobId:job.id,mode:schema.JobRecoveryMode.RETRY,idempotencyKey:randomUUID()});
      assert.equal(retry.outcome,'rejected');
      const before=puts; await reconcileProjectPipeline(project.id);
      assert.equal((await exactRenderJobs(f.candidate.id,f.config.id)).length,1);
      assert.equal(puts,before);
    });

    await t.test('active generation/detector aggregation agrees; abandoned detector produces terminal fallback',async()=>{
      const target=await createSnapshotPack('active generation');
      const gen=await enqueueShortFormPackJob(target.pack.id,source.id,transcript.id,user.id); assert.ok(gen);
      await reconcileProjectPipeline(project.id);
      assert.equal((await db.query.contentPacks.findFirst({where:eq(schema.contentPacks.id,target.pack.id)}))!.status,'generating');
      const c=await makeCandidate(3,target);
      await db.update(schema.clipCandidates).set({facecamDetectionStatus:'pending'}).where(eq(schema.clipCandidates.id,c.id));
      await db.update(schema.jobs).set({status:'completed'}).where(eq(schema.jobs.id,gen.id));
      await reconcileProjectPipeline(project.id);
      await reconcileShortFormContentPackStatus({contentPackId:target.pack.id,sourceAssetId:source.id,generationRunId:target.generationRunId});
      assert.equal((await db.query.contentPacks.findFirst({where:eq(schema.contentPacks.id,target.pack.id)}))!.status,'generating');
      const jobs=await db.select().from(schema.jobs).where(eq(schema.jobs.type,schema.JobType.DETECT_CLIP_FACECAM));
      const detector=jobs.find(j=>'clipCandidateId' in j.payload && j.payload.clipCandidateId===c.id)!;
      await db.update(schema.jobs).set({status:'failed',failureClass:'ambiguous_external_effect'}).where(eq(schema.jobs.id,detector.id));
      await reconcileProjectPipeline(project.id);
      const after=(await db.query.clipCandidates.findFirst({where:eq(schema.clipCandidates.id,c.id)}))!;
      assert.equal(after.facecamDetectionStatus,'failed'); assert.ok(after.currentRenderConfigId);
      const renders=await exactRenderJobs(c.id,after.currentRenderConfigId);
      assert.equal(renders.length,1); assert.equal(renders[0].status,'pending');
      await db.update(schema.jobs).set({status:'failed',failureClass:'permanent'}).where(eq(schema.jobs.id,renders[0].id));
    });

    await t.test('normal terminal render failure immediately preserves partial success', async () => {
      const f = await fixture('normal partial completion');
      await artifactFor(f.candidate, f.config, 'ready');
      await db.update(schema.jobs).set({ status: 'completed' }).where(eq(schema.jobs.id, f.job.id));
      const sibling = await makeCandidate(2, { pack: f.pack, generationRunId: f.generationRunId });
      const resolved = await resolve(sibling);
      const job = await claim(resolved.job.id);
      failPut = true;
      try { assert.equal((await processClaimedJob(job, runtime)).status, 'failed'); }
      finally { failPut = false; }
      assert.equal((await readArtifact(f.candidate.id))!.status, 'ready');
      assert.equal((await readArtifact(sibling.id))!.status, 'failed');
      assert.equal((await db.query.contentPacks.findFirst({ where: eq(schema.contentPacks.id, f.pack.id) }))!.status, 'partially_ready');
    });

    await t.test('terminal render projection preserves READY siblings and repeated reconciliation is idempotent',async()=>{
      const f=await fixture('partial');
      await artifactFor(f.candidate,f.config,'ready');
      await db.update(schema.jobs).set({status:'completed'}).where(eq(schema.jobs.id,f.job.id));
      const c=await makeCandidate(2,{pack:f.pack,generationRunId:f.generationRunId}); const r=await resolve(c);
      await artifactFor(c,r.config,'rendering');
      await db.update(schema.jobs).set({status:'failed',failureClass:'ambiguous_external_effect'}).where(eq(schema.jobs.id,r.job.id));
      await reconcileProjectPipeline(project.id);
      assert.equal((await readArtifact(c.id))!.status,'failed');
      assert.equal((await readArtifact(f.candidate.id))!.status,'ready');
      assert.equal((await db.query.contentPacks.findFirst({where:eq(schema.contentPacks.id,f.pack.id)}))!.status,'partially_ready');
      const before={ candidate:await db.query.clipCandidates.findFirst({where:eq(schema.clipCandidates.id,c.id)}), clip:await readArtifact(c.id), jobs:await exactRenderJobs(c.id,r.config.id), pack:await db.query.contentPacks.findFirst({where:eq(schema.contentPacks.id,f.pack.id)}) };
      await reconcileProjectPipeline(project.id); await reconcileProjectPipeline(project.id);
      const after={ candidate:await db.query.clipCandidates.findFirst({where:eq(schema.clipCandidates.id,c.id)}), clip:await readArtifact(c.id), jobs:await exactRenderJobs(c.id,r.config.id), pack:await db.query.contentPacks.findFirst({where:eq(schema.contentPacks.id,f.pack.id)}) };
      assert.deepEqual(after,before);
    });
  } finally {
    globalThis.fetch=originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env,originalEnv);
    await appClient?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
    await rm(tempDir,{recursive:true,force:true});
  }
});
