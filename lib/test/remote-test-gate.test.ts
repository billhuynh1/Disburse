import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { assertCompleteTap, remoteTestEnvironment, runTestCommand } from '../../scripts/remote-test-support.mjs';

test('remote gate rejects a green-but-skipped, empty, or incomplete Node run', () => {
  const summary = '# tests 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.doesNotThrow(() => assertCompleteTap(summary));
  for (const output of ['', summary.replace('tests 3', 'tests 0'), summary.replace('skipped 0', 'skipped 1'), summary.replace('fail 0', 'fail 1'), summary.replace('cancelled 0', 'cancelled 1'), summary.replace('todo 0', 'todo 1')]) {
    assert.throws(() => assertCompleteTap(output));
  }
});

test('remote command timeout terminates grandchildren holding inherited output pipes', { timeout: 5_000 }, async () => {
  const start = Date.now();
  const result = await runTestCommand(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("grandchild ready"); setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 500 });
  assert.match(result.output, /grandchild ready/);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - start < 3_000, 'An orphaned grandchild must not hold the gate open');
});

test('remote gate neutralizes inherited credentials and Next/dotenv environment files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'disburse-gate-env-'));
  try {
    await writeFile(path.join(directory, '.env.local'), 'OPENAI_API_KEY=private\nUNKNOWN_PROVIDER_SECRET=private\nPOSTGRES_URL=postgres://private\n');
    const environment = await remoteTestEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'private', POSTGRES_URL: 'postgres://private', UNKNOWN_INHERITED_SECRET: 'private', PHASE1A_TEST_DATABASE_URL: 'postgres://test@127.0.0.1/disburse_phase1a_test_gate' }, pathToFileURL(`${directory}/`));
    assert.equal(environment.OPENAI_API_KEY, '');
    assert.equal(environment.UNKNOWN_PROVIDER_SECRET, '');
    assert.equal(environment.UNKNOWN_INHERITED_SECRET, undefined);
    assert.equal(environment.POSTGRES_URL, environment.PHASE1A_TEST_DATABASE_URL);
    assert.equal(environment.S3_UPLOAD_ENDPOINT, 'http://127.0.0.1:1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
