import { test, expect } from '@playwright/test';

const fixtureUrl = 'http://127.0.0.1:3211';

test.beforeEach(async ({ context, request }) => {
  const response = await request.get(`${fixtureUrl}/fixture/session`);
  const { session } = await response.json();
  await context.addCookies([{ name: 'session', value: session, url: 'http://127.0.0.1:3210', httpOnly: true, sameSite: 'Lax' }]);
});

test('uploaded video navigates to generation setup', async ({ page, request }) => {
  const media = await request.get(`${fixtureUrl}/fixture/video`);
  await page.goto('/dashboard');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'browser-gameplay.mp4', mimeType: 'video/mp4', buffer: await media.body() });
  await expect(page).toHaveURL(/\/dashboard\/projects\/\d+\/setup/, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Generate clips', exact: true })).toBeVisible();
  await expect(page.getByText('browser-gameplay', { exact: false }).first()).toBeVisible();
});

test('generation refresh exposes one current clip with playback, seeking, and download', async ({ page, request }) => {
  const seeded = await request.post(`${fixtureUrl}/fixture/project`);
  const { projectId, currentArtifactId } = await seeded.json();
  await page.goto(`/dashboard/projects/${projectId}`);
  await page.getByRole('button', { name: 'grid view', exact: true }).click();
  await expect(page.getByText('Rendering clip', { exact: true }).first()).toBeVisible();
  await request.post(`${fixtureUrl}/fixture/ready`);
  const downloadLink = page.getByRole('link', { name: 'Download clip 1', exact: true });
  // No reload: the active generation's production polling must refresh the RSC projection.
  await expect(downloadLink).toHaveCount(1);
  await expect(downloadLink).toHaveAttribute('href', `/api/rendered-clips/${currentArtifactId}/download?download=1`);
  const video = page.locator(`video[src="/api/rendered-clips/${currentArtifactId}/download"]`).first();
  await page.getByRole('button', { name: 'Play clip 1', exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.1);
  const seek = page.getByRole('button', { name: 'Seek clip 1', exact: true });
  await seek.click({ position: { x: (await seek.boundingBox())!.width / 2, y: 2 }, force: true });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1);
  const download = page.waitForEvent('download');
  await downloadLink.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('current-gaming-moment-hd.mp4');
  expect(await file.failure()).toBeNull();
});

test('failed candidate retry persists a successor job through the real recovery route', async ({ page, request }) => {
  const seeded = await request.post(`${fixtureUrl}/fixture/project`);
  const { projectId, failedJobId } = await seeded.json();
  await request.post(`${fixtureUrl}/fixture/failed`);
  await page.goto(`/dashboard/projects/${projectId}`);
  await page.getByRole('button', { name: 'grid view', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry', exact: true }).first();
  await expect(retry).toBeVisible();
  const recoveryResponse = page.waitForResponse((response) => response.url().endsWith(`/api/jobs/${failedJobId}/recover`) && response.request().method() === 'POST');
  await retry.click();
  const response = await recoveryResponse;
  expect(response.ok()).toBe(true);
  await expect.poll(async () => (await (await request.get(`${fixtureUrl}/fixture/recovery`)).json()).length).toBe(1);
  const [successor] = await (await request.get(`${fixtureUrl}/fixture/recovery`)).json();
  expect(successor.parentJobId).toBe(failedJobId);
  expect(successor.status).toBe('pending');
});
