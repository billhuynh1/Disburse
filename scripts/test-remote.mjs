import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertDisposablePostgresTestDatabase } from '../lib/db/test-database-guard.ts';
import { assertCompleteTap, remoteTestEnvironment, runTestCommand } from './remote-test-support.mjs';

const root = new URL('../', import.meta.url);
const cwd = fileURLToPath(root);
const results = path.join(cwd, '.test-results', 'remote');

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? files(name) : name.endsWith('.test.ts') ? [name] : [];
  }))).flat().sort();
}

async function main() {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL;
  assert.ok(configuredUrl, 'Set PHASE1A_TEST_DATABASE_URL to a disposable loopback PostgreSQL 16 database');
  const url = assertDisposablePostgresTestDatabase(configuredUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'A PostgreSQL URL is required');
  assert.equal(url.search, '', 'Use a plain database URL without connection overrides');
  const environment = await remoteTestEnvironment(process.env, root);
  await mkdir(results, { recursive: true });
  async function run(label, command, args, timeoutMs = 180_000, extraEnv = {}) {
    console.log(`Remote gate: ${label}`);
    const { code, timedOut, interrupted, output } = await runTestCommand(command, args, { cwd, env: { ...environment, ...extraEnv }, timeoutMs });
    await writeFile(path.join(results, `${label}.log`), output);
    assert.ok(!timedOut, `${label} exceeded its timeout; see .test-results/remote/${label}.log`);
    assert.ok(!interrupted, `${label} was interrupted`);
    assert.equal(code, 0, `${label} failed; see .test-results/remote/${label}.log`);
    return output;
  }
  const database = postgres(configuredUrl, { max: 1, connect_timeout: 5 });
  try {
    const [version] = await database`select current_setting('server_version_num')::int as version`;
    assert.ok(version.version >= 160000 && version.version < 170000, 'The remote gate requires PostgreSQL 16');
    const [role] = await database`select rolcreatedb, rolsuper from pg_roles where rolname = current_user`;
    assert.ok(role.rolcreatedb || role.rolsuper, 'The disposable test role needs CREATEDB for migration/S6 tests');
  } finally { await database.end(); }
  await run('ffmpeg', environment.FFMPEG_PATH, ['-version']);
  await run('ffprobe', environment.FFPROBE_PATH, ['-version']);
  const python = process.env.REMOTE_TEST_PYTHON || path.join(cwd, 'services/media-api/.venv/bin/python');
  await run('python-dependencies', python, ['-c', 'import cv2, mediapipe, pytest, fastapi, httpx; print("Media test dependencies available")']);
  const nodeTests = await files(path.join(cwd, 'lib'));
  const tap = await run('node', process.execPath, [
    '--import', './lib/test/register-typescript-path-loader.mjs', '--experimental-transform-types',
    '--test', '--test-concurrency=2', '--test-reporter=tap', ...nodeTests,
  ], 900_000);
  assertCompleteTap(tap);
  const pytestReport = path.join(results, 'pytest.xml');
  await run('python', python, ['-m', 'pytest', 'services/media-api/tests', '-q', `--junitxml=${pytestReport}`]);
  const pythonSummary = await readFile(pytestReport, 'utf8');
  assert.ok(!/<testsuite\b[^>]*\bskipped="[1-9]/.test(pythonSummary), 'Required Python tests skipped');
  assert.ok(/<testsuite\b[^>]*\btests="[1-9]/.test(pythonSummary), 'Python suite ran no tests');
  await run('types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false', '--pretty', 'false']);
  await run('build', process.execPath, ['node_modules/next/dist/bin/next', 'build'], 600_000, { NODE_ENV: 'production' });
  await run('preflight', process.execPath, ['scripts/operational-preflight.mjs']);
  await run('browser', process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], 600_000, { NODE_ENV: 'production' });
  const browserReport = JSON.parse(await readFile(path.join(results, 'playwright.json'), 'utf8'));
  assert.ok(browserReport.stats.expected > 0, 'Browser suite ran no passing tests');
  assert.equal(browserReport.stats.skipped, 0, 'Required browser tests skipped');
  assert.equal(browserReport.stats.unexpected, 0, 'Browser tests failed');
  assert.equal(browserReport.stats.flaky, 0, 'Browser tests required retries');
  await run('diff', 'git', ['diff', '--check']);
  console.log('Remote gate passed: database, Node, Python, real media, types, build, preflight, and browser checks.');
}

main().catch(error => {
  // Never echo the configured database URL or provider credentials.
  console.error(error instanceof assert.AssertionError ? error.message : 'Remote gate failed; check dependencies/database access and .test-results/remote logs.');
  process.exitCode = 1;
});
