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

  const nextExport = source.indexOf('\nexport ', start + 1);

  return nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
}

test('source upload pause is local and does not abort the multipart session', () => {
  const uploadClient = readRepoFile('app/(dashboard)/dashboard/upload-client.ts');
  const multipartUpload = extractFunction(
    uploadClient,
    'uploadSourceAssetMultipart'
  );

  assert.match(multipartUpload, /UploadPausedError/);
  assert.match(multipartUpload, /status:\s*'paused'/);
  assert.match(multipartUpload, /saveSourceUploadLocalRecord/);
  assert.doesNotMatch(multipartUpload, /\/api\/source-assets\/uploads\/abort/);
});

test('discard is the explicit client path that aborts multipart storage', () => {
  const uploadClient = readRepoFile('app/(dashboard)/dashboard/upload-client.ts');
  const discardUpload = extractFunction(uploadClient, 'discardSourceUpload');

  assert.match(discardUpload, /\/api\/source-assets\/uploads\/abort/);
  assert.match(discardUpload, /clearSourceUploadLocalRecord/);
});

test('resume recovers existing sessions and rejects wrong local files', () => {
  const uploadClient = readRepoFile('app/(dashboard)/dashboard/upload-client.ts');
  const multipartUpload = extractFunction(
    uploadClient,
    'uploadSourceAssetMultipart'
  );

  assert.match(uploadClient, /type SourceUploadLocalRecord/);
  assert.match(uploadClient, /fileMatchesSourceUploadRecord/);
  assert.match(uploadClient, /Choose the same local file to resume this upload/);
  assert.match(uploadClient, /\/api\/source-assets\/uploads\/status/);
  assert.match(uploadClient, /partUrl\.alreadyUploaded/);
  assert.match(uploadClient, /acknowledgedBytes/);
  assert.match(uploadClient, /restoredPercent/);
  assert.match(uploadClient, /label:\s*uploadedParts\.size > 0 \? 'Resuming upload' : 'Uploading'/);
  assert.match(multipartUpload, /uploadedBytesByPart\.set\(partNumber,\s*partSize\)/);
  assert.match(multipartUpload, /const restoredPercent = getUploadPercent\(acknowledgedBytes, params\.file\.size\)/);
});

test('resume progress is based on acknowledged parts, not canceled in-flight bytes', () => {
  const uploadClient = readRepoFile('app/(dashboard)/dashboard/upload-client.ts');
  const multipartUpload = extractFunction(
    uploadClient,
    'uploadSourceAssetMultipart'
  );

  assert.match(multipartUpload, /const uploadedBytesByPart = new Map<number, number>\(\)/);
  assert.match(multipartUpload, /for \(const partNumber of uploadedParts\.keys\(\)\)/);
  assert.match(multipartUpload, /acknowledgedBytes \+= partSize/);
  assert.match(multipartUpload, /uploadedBytesByPart\.set\(partNumber,\s*partSize\)/);
  assert.match(multipartUpload, /updateLocalRecord\(\{\s*uploadSessionId: session\.id,\s*uploadedPartCount: uploadedParts\.size,\s*totalParts: session\.totalParts,\s*percent: restoredPercent,/);
  assert.match(multipartUpload, /loaded: acknowledgedBytes/);
  assert.doesNotMatch(multipartUpload, /currentProgress\?\.percent/);
});

test('part upload abort settles as paused and cannot become interrupted', () => {
  const uploadClient = readRepoFile('app/(dashboard)/dashboard/upload-client.ts');
  const uploadBlobWithProgress = extractFunction(uploadClient, 'uploadBlobWithProgress');

  assert.match(uploadBlobWithProgress, /let settled = false/);
  assert.match(uploadBlobWithProgress, /removeEventListener\('abort', handleAbort\)/);
  assert.match(uploadBlobWithProgress, /addEventListener\('abort', handleAbort, \{ once: true \}\)/);
  assert.match(uploadBlobWithProgress, /params\.signal\?\.aborted\s*\?\s*new UploadPausedError\(\)\s*:\s*new UploadInterruptedError\(\)/);
  assert.match(uploadBlobWithProgress, /xhr\.onabort = \(\) => finish\(\(\) => reject\(new UploadPausedError\(\)\)\)/);
});

test('part upload interruptions stay resumable without raw storage copy', () => {
  const uploadClient = readRepoFile('app/(dashboard)/dashboard/upload-client.ts');
  const dashboardHome = readRepoFile('app/(dashboard)/dashboard/home-ui.tsx');

  assert.match(uploadClient, /UploadInterruptedError/);
  assert.match(uploadClient, /UPLOAD_INTERRUPTED_ERROR_MESSAGE = 'Upload failed\.'/);
  assert.doesNotMatch(uploadClient, /Resume when your connection is stable/);
  assert.match(uploadClient, /status:\s*'failed'/);
  assert.match(uploadClient, /isUploadInterruptedError/);
  assert.doesNotMatch(uploadClient, /Part upload failed/);
  assert.match(dashboardHome, /Upload failed\./);
  assert.doesNotMatch(dashboardHome, /Resume when your connection is stable/);
  assert.doesNotMatch(dashboardHome, /console\.error\("Dashboard upload interrupted/);
  assert.doesNotMatch(dashboardHome, /console\.error\("Dashboard upload resume interrupted/);
  assert.match(dashboardHome, /isUploadInterruptedError/);
  assert.match(dashboardHome, /setResumableUpload/);
  assert.match(dashboardHome, /canResume/);
  assert.match(dashboardHome, /Resume upload/);
  assert.doesNotMatch(dashboardHome, /Part upload failed/);
});

test('source upload form exposes cancel, resume, and discard-backed cancel states', () => {
  const uploadForm = readRepoFile(
    'app/(dashboard)/dashboard/projects/[id]/source-asset-create-form.tsx'
  );
  const dashboardHome = readRepoFile('app/(dashboard)/dashboard/home-ui.tsx');

  assert.match(uploadForm, /AbortController/);
  assert.match(uploadForm, /handlePauseUpload/);
  assert.match(uploadForm, /handleDiscardUpload/);
  assert.match(uploadForm, /getSourceUploadLocalRecords\(projectId\)/);
  assert.match(uploadForm, /Resume upload/);
  assert.match(uploadForm, /Choose same file/);
  assert.match(uploadForm, /Upload canceled/);
  assert.match(uploadForm, /Cancel the saved upload before choosing a different file/);
  assert.doesNotMatch(uploadForm, />\s*Pause\s*</);
  assert.doesNotMatch(uploadForm, />\s*Discard\s*</);
  assert.match(dashboardHome, /isUploadPausedError/);
  assert.match(dashboardHome, /resumableUpload/);
  assert.match(dashboardHome, /canResume/);
  assert.match(dashboardHome, /handleResumeUpload/);
  assert.match(dashboardHome, /handleDiscardResumableUpload/);
  assert.match(dashboardHome, /preserveProgress/);
  assert.match(dashboardHome, /Checking uploaded parts/);
  assert.doesNotMatch(dashboardHome, /Open the project to resume with the same file/);
  assert.match(dashboardHome, />\s*Cancel\s*</);
});
