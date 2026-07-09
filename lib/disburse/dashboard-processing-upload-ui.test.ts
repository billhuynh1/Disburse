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
  const sourceAssetCard = readRepoFile(
    'app/(dashboard)/dashboard/projects/[id]/source-asset-card.tsx'
  );

  assert.match(
    dashboardHome,
    /import\s+\{\s*useSourceAssetThumbnail\s*\}\s+from\s+"@\/components\/dashboard\/source-asset-thumbnail"/
  );
  assert.match(
    setupUi,
    /import\s+\{\s*useSourceAssetThumbnail\s*\}\s+from\s+'@\/components\/dashboard\/source-asset-thumbnail'/
  );
  assert.match(
    sourceAssetCard,
    /import\s+\{\s*useSourceAssetThumbnail\s*\}\s+from\s+'@\/components\/dashboard\/source-asset-thumbnail'/
  );
  assert.match(
    sourceAssetCard,
    /import\s+\{\s*ProjectThumbnailFrame\s*\}\s+from\s+'@\/components\/dashboard\/project-thumbnail-frame'/
  );
});

test('setup upload persists the extracted thumbnail after multipart upload', () => {
  const createForm = readRepoFile(
    'app/(dashboard)/dashboard/projects/[id]/source-asset-create-form.tsx'
  );

  assert.match(
    createForm,
    /import\s+\{\s*uploadSourceAssetThumbnail\s*\}\s+from\s+'@\/lib\/disburse\/video-thumbnail-client'/
  );
  assert.match(
    createForm,
    /const\s+uploadResult\s*=\s*await\s+uploadSourceAssetMultipart\(/
  );
  assert.match(createForm, /const\s+sourceAssetId\s*=\s*uploadResult\?\.sourceAsset\?\.id/);
  assert.match(
    createForm,
    /await\s+uploadSourceAssetThumbnail\(\{\s*sourceAssetId,\s*file,\s*\}\)/
  );
});

test('project detail maps persisted thumbnail fields into source asset view models', () => {
  const projectDetailPage = readRepoFile(
    'app/(dashboard)/dashboard/projects/[id]/page.tsx'
  );

  assert.match(projectDetailPage, /thumbnailStorageKey:\s*asset\.thumbnailStorageKey/);
  assert.match(
    projectDetailPage,
    /thumbnailUrl:\s*asset\.thumbnailStorageKey\s*\?\s*`\/api\/source-assets\/\$\{asset\.id\}\/thumbnail`\s*:\s*null/
  );
  assert.match(projectDetailPage, /thumbnailWidth:\s*asset\.thumbnailWidth/);
  assert.match(projectDetailPage, /thumbnailHeight:\s*asset\.thumbnailHeight/);
});
