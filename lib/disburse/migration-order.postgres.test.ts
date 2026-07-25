import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { EXPECTED_JOURNAL_TIMESTAMPS, EXPECTED_MIGRATIONS, validateMigrationJournal } from '../../scripts/operational-schema-contract.mjs';

const execFile = promisify(execFileCallback);
const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL;
const repoRoot = new URL('../..', import.meta.url);

function disposableUrl(name: string) {
  const url = new URL(configuredUrl!);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname));
  url.pathname = `/${name}`;
  return url.toString();
}

async function withDisposableDatabase(run: (url: string) => Promise<void>) {
  const { default: postgres } = await import('postgres');
  const name = `disburse_phase6_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const admin = postgres(disposableUrl('postgres'), { max: 1 });
  const url = disposableUrl(name);
  try {
    const [{ server_version_num: version }] = await admin`show server_version_num`;
    assert.ok(Number(version) >= 160000 && Number(version) < 170000);
    await admin.unsafe(`create database "${name}"`);
    await run(url);
  } finally {
    await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => undefined);
    await admin.end();
  }
}

function migrationEnvironment(url: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH!, POSTGRES_URL: url, NODE_ENV: 'test', DISBURSE_PIPELINE_KILL_SWITCH: 'true',
    STRIPE_SECRET_KEY: 'sk_test_placeholder', OPENAI_API_KEY: '', MEDIA_API_SECRET: '',
    S3_UPLOAD_ACCESS_KEY_ID: '', S3_UPLOAD_SECRET_ACCESS_KEY: '',
  };
}

async function migrate(cwd: URL | string, url: string) {
  await execFile('npm', ['run', 'db:migrate'], { cwd, env: migrationEnvironment(url) });
}

async function assertExactJournal(url: string) {
  const { default: postgres } = await import('postgres');
  const client = postgres(url, { max: 1 });
  try {
    const rows = await client.unsafe('select hash, created_at::text created_at from drizzle.__drizzle_migrations order by created_at, id');
    assert.deepEqual(validateMigrationJournal(rows.map((row, index) => ({
      tag: EXPECTED_MIGRATIONS[index]?.[0] ?? null,
      hash: row.hash, created_at: row.created_at,
    }))), []);
    assert.deepEqual(rows.map(row => row.created_at),
      EXPECTED_MIGRATIONS.map(([tag]) => String(expectedTimestamp(tag))));
    const [{ data_type, udt_name }] = await client.unsafe(`
      select data_type, udt_name from information_schema.columns
      where table_schema = 'drizzle' and table_name = '__drizzle_migrations' and column_name = 'created_at'
    `);
    assert.deepEqual({ data_type, udt_name }, { data_type: 'bigint', udt_name: 'int8' });
  } finally { await client.end(); }
}

async function accepted0033Workspace() {
  const root = await mkdtemp(join(tmpdir(), 'disburse-0033-'));
  await cp(new URL('../db/migrations/', import.meta.url), join(root, 'lib/db/migrations'), { recursive: true });
  const journalPath = join(root, 'lib/db/migrations/meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag <= '0033_durable_job_recovery');
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { 'db:migrate': 'drizzle-kit migrate' } }));
  await writeFile(join(root, 'drizzle.config.ts'), `export default { schema: '${new URL('../db/schema.ts', import.meta.url).pathname}', out: './lib/db/migrations', dialect: 'postgresql', dbCredentials: { url: process.env.POSTGRES_URL! } };`);
  return root;
}

test('actual npm db:migrate upgrades accepted 0033 through 0034 and 0035', { skip: !configuredUrl }, async () => {
  await withDisposableDatabase(async url => {
    const accepted = await accepted0033Workspace();
    try {
      await migrate(accepted, url);
      await migrate(repoRoot, url);
      await assertExactJournal(url);
    } finally { await rm(accepted, { recursive: true, force: true }); }
  });
});

test('actual npm db:migrate migrates an empty PostgreSQL 16 database through repository history', { skip: !configuredUrl }, async () => {
  await withDisposableDatabase(async url => {
    await migrate(repoRoot, url);
    await assertExactJournal(url);
  });
});

test('production database preflight rejects incorrect migration hashes and created_at values', { skip: !configuredUrl }, async () => {
  await withDisposableDatabase(async url => {
    await migrate(repoRoot, url);
    const { default: postgres } = await import('postgres');
    const client = postgres(url, { max: 1 });
    try {
      for (const [mutation, reset] of [
        [`update drizzle.__drizzle_migrations set hash = '${'f'.repeat(64)}' where id = 1`, `update drizzle.__drizzle_migrations set hash = '${EXPECTED_MIGRATIONS[0][1]}' where id = 1`],
        [`update drizzle.__drizzle_migrations set created_at = 9999999999999 where id = 1`, `update drizzle.__drizzle_migrations set created_at = ${expectedTimestamp(EXPECTED_MIGRATIONS[0][0])} where id = 1`],
      ]) {
        await client.unsafe(mutation);
        await assert.rejects(execFile('npm', ['run', 'ops:preflight', '--', '--database'], {
          cwd: repoRoot, env: migrationEnvironment(url),
        }));
        await client.unsafe(reset);
      }
    } finally { await client.end(); }
  });
});

test('production database preflight rejects created_at type drift and noncanonical numeric timestamps', { skip: !configuredUrl }, async () => {
  await withDisposableDatabase(async url => {
    await migrate(repoRoot, url);
    const { default: postgres } = await import('postgres');
    const client = postgres(url, { max: 1 });
    try {
      await client.unsafe('alter table drizzle.__drizzle_migrations alter column created_at type numeric using created_at::numeric');
      await client.unsafe(`update drizzle.__drizzle_migrations set created_at = 1784508809304.0 where created_at = ${expectedTimestamp('0035_operational_verification_remediation')}`);
      await assert.rejects(execFile('npm', ['run', 'ops:preflight', '--', '--database'], {
        cwd: repoRoot, env: migrationEnvironment(url),
      }), (error) => error instanceof Error && 'stderr' in error &&
        typeof error.stderr === 'string' && error.stderr.includes('created_at column type drift: expected bigint'));
    } finally { await client.end(); }
  });
});

function expectedTimestamp(tag: string) {
  const timestamp = EXPECTED_JOURNAL_TIMESTAMPS.get(tag);
  assert.notEqual(timestamp, undefined);
  return timestamp;
}
