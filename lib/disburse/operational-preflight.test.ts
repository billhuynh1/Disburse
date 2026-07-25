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
