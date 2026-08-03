import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const repoRoot = new URL('../..', import.meta.url);

async function copiedPreflight() {
  const root = await mkdtemp(join(tmpdir(), 'disburse-preflight-'));
  await cp(new URL('../../scripts/', import.meta.url), join(root, 'scripts'), { recursive: true });
  await cp(new URL('./fault-injection.ts', import.meta.url), join(root, 'lib/disburse/fault-injection.ts'));
  await cp(new URL('../db/migrations/', import.meta.url), join(root, 'lib/db/migrations'), { recursive: true });
  return root;
}

async function expectFailure(mutate: (root: string) => Promise<void>) {
  const root = await copiedPreflight();
  try {
    await mutate(root);
    await assert.rejects(execFile('node', ['scripts/operational-preflight.mjs'], { cwd: root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('production preflight entry point accepts the repository contract', async () => {
  const { stdout } = await execFile('node', ['scripts/operational-preflight.mjs'], {
    cwd: new URL('../..', import.meta.url),
  });
  assert.match(stdout, /Phase 6 preflight passed/);
});

test('production preflight rejects invalid migration history', async () => {
  await expectFailure(async root => {
    const path = join(root, 'lib/db/migrations/meta/_journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    journal.entries[33].when = journal.entries[32].when;
    await writeFile(path, JSON.stringify(journal));
  });
  await expectFailure(async root => {
    const path = join(root, 'lib/db/migrations/meta/_journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    journal.entries[33].when = journal.entries[32].when - 1;
    await writeFile(path, JSON.stringify(journal));
  });
  await expectFailure(async root => {
    const path = join(root, 'lib/db/migrations/meta/_journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    [journal.entries[32], journal.entries[33]] = [journal.entries[33], journal.entries[32]];
    await writeFile(path, JSON.stringify(journal));
  });
  await expectFailure(root => rm(join(root, 'lib/db/migrations/0034_operational_verification.sql')));
  await expectFailure(root => writeFile(join(root, 'lib/db/migrations/0036_unexplained.sql'), 'select 1;'));
  await expectFailure(async root => {
    const path = join(root, 'lib/db/migrations/meta/0033_snapshot.json');
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    snapshot.prevId = 'broken-historical-link';
    await writeFile(path, JSON.stringify(snapshot));
  });
  await expectFailure(async root => {
    const path = join(root, 'lib/db/migrations/meta/0034_snapshot.json');
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    snapshot.id = 'a1a7a574-4ae5-483d-a816-1a26fcda9740';
    await writeFile(path, JSON.stringify(snapshot));
  });
});

const requiredEnvironment = {
  NODE_ENV: 'test' as const,
  POSTGRES_URL: 'postgres://preflight:preflight@localhost:5432/preflight',
  INTERNAL_PROCESSING_SECRET: 'internal-preflight-secret',
  CRON_SECRET: 'cron-preflight-secret',
  OPERATIONAL_SNAPSHOT_SECRET: 'snapshot-preflight-secret',
  OPENAI_API_KEY: 'openai-preflight-key',
  MEDIA_API_SECRET: 'media-preflight-secret',
  S3_UPLOAD_ACCESS_KEY_ID: 's3-preflight-key',
  S3_UPLOAD_SECRET_ACCESS_KEY: 's3-preflight-secret',
};

async function runRequiredEnvironment(environment: Record<string, string | undefined>) {
  return await execFile(process.execPath, ['scripts/operational-preflight.mjs', '--require-env'], {
    cwd: repoRoot,
    env: { ...requiredEnvironment, ...environment },
  });
}

async function expectRequiredEnvironmentFailure(
  environment: Record<string, string | undefined>,
  expectedMessage: RegExp,
  hiddenValue = 'not-a-secret-value'
) {
  await assert.rejects(runRequiredEnvironment(environment), (error: NodeJS.ErrnoException & { stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr ?? '', expectedMessage);
    assert.doesNotMatch(error.stderr ?? '', new RegExp(hiddenValue, 'g'));
    return true;
  });
}

test('required environment preflight accepts valid deployment configurations', async () => {
  for (const environment of [
    { DISBURSE_DEPLOYMENT_ENV: 'production' },
    { DISBURSE_DEPLOYMENT_ENV: 'staging' },
    { DISBURSE_DEPLOYMENT_ENV: 'staging', DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'false' },
    {
      DISBURSE_DEPLOYMENT_ENV: 'staging',
      DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'true',
      DISBURSE_FAULT_INJECTION: 's3:before_send',
      DISBURSE_FAULT_INJECTION_SECRET: 'fault-preflight-secret',
    },
    { DISBURSE_DEPLOYMENT_ENV: 'development' },
    { DISBURSE_DEPLOYMENT_ENV: 'test' },
  ]) {
    const { stdout, stderr } = await runRequiredEnvironment(environment);
    assert.match(stdout, /Phase 6 preflight passed/);
    assert.equal(stderr, '');
  }
});

test('required environment preflight rejects invalid deployment identity and booleans', async () => {
  await expectRequiredEnvironmentFailure({}, /DISBURSE_DEPLOYMENT_ENV must be one of/);
  await expectRequiredEnvironmentFailure({ DISBURSE_DEPLOYMENT_ENV: 'preview' }, /DISBURSE_DEPLOYMENT_ENV must be one of/);
  await expectRequiredEnvironmentFailure({ DISBURSE_DEPLOYMENT_ENV: 'production', DISBURSE_CRON_EXPECTED: 'TRUE' }, /DISBURSE_CRON_EXPECTED must be exactly true or false/);
  await expectRequiredEnvironmentFailure({ DISBURSE_DEPLOYMENT_ENV: 'staging', DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'yes' }, /DISBURSE_STAGING_FAULT_INJECTION_ENABLED must be exactly true or false/);
});

test('required environment preflight enforces production Cron and fault-injection invariants', async () => {
  await expectRequiredEnvironmentFailure({ DISBURSE_DEPLOYMENT_ENV: 'production', DISBURSE_CRON_EXPECTED: 'false' }, /DISBURSE_CRON_EXPECTED must be true or unset for production/);
  await expectRequiredEnvironmentFailure({ DISBURSE_DEPLOYMENT_ENV: 'production', DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'true' }, /DISBURSE_STAGING_FAULT_INJECTION_ENABLED must be false or unset for production/);
  await expectRequiredEnvironmentFailure({ DISBURSE_DEPLOYMENT_ENV: 'production', DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'false', DISBURSE_FAULT_INJECTION: 's3:before_send' }, /DISBURSE_FAULT_INJECTION must be empty or unset for production/);
});

test('required environment preflight rejects ambiguous staging fault-injection configuration', async () => {
  const enabled = { DISBURSE_DEPLOYMENT_ENV: 'staging', DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'true', DISBURSE_FAULT_INJECTION_SECRET: 'fault-preflight-secret' };
  await expectRequiredEnvironmentFailure(enabled, /DISBURSE_FAULT_INJECTION is required when staging fault injection is enabled/);
  for (const selector of ['invalid:before_send', 's3:invalid_point', ' s3:before_send', 's3:before_send ', ' s3:before_send ']) {
    await expectRequiredEnvironmentFailure({ ...enabled, DISBURSE_FAULT_INJECTION: selector }, /DISBURSE_FAULT_INJECTION must select a valid provider and point/);
  }
  await expectRequiredEnvironmentFailure({ DISBURSE_DEPLOYMENT_ENV: 'staging', DISBURSE_FAULT_INJECTION: 's3:before_send' }, /DISBURSE_FAULT_INJECTION must be empty or unset when staging fault injection is disabled/);
  await expectRequiredEnvironmentFailure({ DISBURSE_DEPLOYMENT_ENV: 'staging', DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'false', DISBURSE_FAULT_INJECTION: 's3:before_send' }, /DISBURSE_FAULT_INJECTION must be empty or unset when staging fault injection is disabled/);
});

test('required environment preflight rejects every active operational-secret collision without leaking it', async () => {
  const collisions: Array<[string, string, Record<string, string | undefined>]> = [
    ['INTERNAL_PROCESSING_SECRET', 'CRON_SECRET', { DISBURSE_DEPLOYMENT_ENV: 'production' }],
    ['INTERNAL_PROCESSING_SECRET', 'OPERATIONAL_SNAPSHOT_SECRET', { DISBURSE_DEPLOYMENT_ENV: 'production' }],
    ['CRON_SECRET', 'OPERATIONAL_SNAPSHOT_SECRET', { DISBURSE_DEPLOYMENT_ENV: 'production' }],
    ['INTERNAL_PROCESSING_SECRET', 'DISBURSE_FAULT_INJECTION_SECRET', { DISBURSE_DEPLOYMENT_ENV: 'staging', DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'true', DISBURSE_FAULT_INJECTION: 's3:before_send' }],
    ['CRON_SECRET', 'DISBURSE_FAULT_INJECTION_SECRET', { DISBURSE_DEPLOYMENT_ENV: 'staging', DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'true', DISBURSE_FAULT_INJECTION: 's3:before_send' }],
    ['OPERATIONAL_SNAPSHOT_SECRET', 'DISBURSE_FAULT_INJECTION_SECRET', { DISBURSE_DEPLOYMENT_ENV: 'staging', DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'true', DISBURSE_FAULT_INJECTION: 's3:before_send' }],
  ];
  for (const [left, right, environment] of collisions) {
    for (const [leftValue, rightValue] of [
      ['not-a-secret-value', 'not-a-secret-value'],
      [' not-a-secret-value', 'not-a-secret-value'],
      ['not-a-secret-value ', 'not-a-secret-value'],
    ]) {
      await expectRequiredEnvironmentFailure({ ...environment, [left]: leftValue, [right]: rightValue }, new RegExp(`${left} must not reuse ${right}`), 'not-a-secret-value');
    }
  }
});
