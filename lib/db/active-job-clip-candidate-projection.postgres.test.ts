import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import { and, asc, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';

register('../test/typescript-path-loader.mjs', import.meta.url);
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === '@/lib/auth/session') {
        return {
          url: 'data:text/javascript,export async function verifyToken() { return null; }',
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    }
  `)}`,
  import.meta.url,
);

test('dashboard active-job projection safely nulls malformed clip candidate ids', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  const parsed = new URL(configuredUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  assert.equal(parsed.pathname.replace(/^\//, ''), 'disburse_phase1a_test');

  const schemaName = `dashboard_projection_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  let appClient: { end: () => Promise<void> } | undefined;

  try {
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`set search_path to "${schemaName}"`);
    const migrationDirectory = new URL('./migrations/', import.meta.url);
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const migrationFile of migrationFiles) {
      const migrationSql = await readFile(new URL(migrationFile, migrationDirectory), 'utf8');
      for (const statement of migrationSql.split('--> statement-breakpoint')) {
        const scopedStatement = statement.trim().replaceAll('"public".', `"${schemaName}".`);
        if (scopedStatement) await admin.unsafe(scopedStatement);
      }
    }

    const isolatedUrl = new URL(configuredUrl);
    isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    process.env.POSTGRES_URL = isolatedUrl.toString();

    const { client, db } = await import('./drizzle.ts');
    appClient = client;
    const { jobs, JobStatus, JobType } = await import('./schema.ts');
    const { activeJobClipCandidateIdProjection } = await import('./queries.ts');
    const payloads = [
      ['valid', { userId: 1, clipCandidateId: 123 }, 123],
      ['string', { userId: 1, clipCandidateId: '123' }, null],
      ['fraction', { userId: 1, clipCandidateId: 1.5 }, null],
      ['int4-max', { userId: 1, clipCandidateId: 2_147_483_647 }, 2_147_483_647],
      ['too-large', { userId: 1, clipCandidateId: 2_147_483_648 }, null],
      ['int4-min', { userId: 1, clipCandidateId: -2_147_483_648 }, -2_147_483_648],
      ['too-small', { userId: 1, clipCandidateId: -2_147_483_649 }, null],
      ['null', { userId: 1, clipCandidateId: null }, null],
      ['missing', { userId: 1 }, null],
      ['object', { userId: 1, clipCandidateId: {} }, null],
      ['array', { userId: 1, clipCandidateId: [] }, null],
      ['boolean', { userId: 1, clipCandidateId: true }, null],
      ['zero', { userId: 1, clipCandidateId: 0 }, 0],
      ['negative', { userId: 1, clipCandidateId: -7 }, -7],
    ] as const;

    await db.insert(jobs).values(payloads.map(([label, payload]) => ({
      type: JobType.RENDER_CLIP_CANDIDATE,
      status: JobStatus.PENDING,
      idempotencyKey: `dashboard-projection-${label}-${randomUUID()}`,
      payload: payload as any,
    })));

    const projectedJobs = await db
      .select({
        idempotencyKey: jobs.idempotencyKey,
        clipCandidateId: activeJobClipCandidateIdProjection,
      })
      .from(jobs)
      .where(and(
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
        inArray(jobs.type, [
          JobType.TRANSCRIBE_SOURCE_ASSET,
          JobType.INGEST_YOUTUBE_SOURCE_ASSET,
          JobType.GENERATE_SHORT_FORM_PACK,
          JobType.RENDER_CLIP_CANDIDATE,
          JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
          JobType.DETECT_CLIP_FACECAM,
        ]),
        sql<boolean>`jsonb_typeof(${jobs.payload}->'userId') = 'number'`,
        sql<boolean>`${jobs.payload}->'userId' = to_jsonb(${1}::integer)`,
      ))
      .orderBy(asc(jobs.id));

    assert.deepEqual(
      projectedJobs.map((job) => job.clipCandidateId),
      payloads.map(([, , expected]) => expected),
    );
  } finally {
    await appClient?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
