import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function extractFunction(source: string, functionName: string) {
  const start = source.indexOf(`function ${functionName}`);

  assert.notEqual(start, -1, `${functionName} should exist`);

  const nextFunction = source.indexOf('\nfunction ', start + 1);
  const nextConst = source.indexOf('\nconst ', start + 1);
  const candidates = [nextFunction, nextConst].filter((index) => index !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;

  return source.slice(start, end);
}

test('dashboard upload completion redirects back to the dashboard', () => {
  const dashboardHome = readRepoFile('app/(dashboard)/dashboard/home-ui.tsx');

  assert.match(dashboardHome, /router\.push\("\/dashboard"\)/);
  assert.doesNotMatch(dashboardHome, /router\.push\(`\/dashboard\/projects\/\$\{[^}]+}\`\/setup`\)/);
  assert.doesNotMatch(dashboardHome, /router\.push\(`\/dashboard\/projects\/\$\{[^}]+}\/setup`\)/);
});

test('processing modal cancel explicitly deletes the project', () => {
  const dashboardHome = readRepoFile('app/(dashboard)/dashboard/home-ui.tsx');
  const dialog = extractFunction(dashboardHome, 'ProjectProcessingDialog');
  const cancelHandler = extractFunction(dashboardHome, 'handleCancelUpload');

  assert.match(dialog, /Cancel upload/);
  assert.match(dialog, /onOpenChange=\{onOpenChange\}/);
  assert.match(cancelHandler, /deleteProject\(\{\}, formData\)/);
  assert.match(cancelHandler, /formData\.set\("projectId", String\(projectId\)\)/);
  assert.doesNotMatch(dialog, /onOpenChange=\{handleCancelUpload\}/);
});

test('dashboard and setup use the shared source thumbnail hook', () => {
  const dashboardHome = readRepoFile('app/(dashboard)/dashboard/home-ui.tsx');
  const setupUi = readRepoFile(
    'app/(dashboard)/dashboard/projects/[id]/setup/setup-ui.tsx'
  );

  assert.match(
    dashboardHome,
    /import\s+\{\s*useSourceAssetThumbnail\s*\}\s+from\s+"@\/components\/dashboard\/source-asset-thumbnail"/
  );
  assert.match(
    setupUi,
    /import\s+\{\s*useSourceAssetThumbnail\s*\}\s+from\s+'@\/components\/dashboard\/source-asset-thumbnail'/
  );
});
