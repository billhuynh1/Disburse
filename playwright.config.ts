import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.test-results/remote/playwright.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:3210',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --import ./lib/test/register-typescript-path-loader.mjs --experimental-transform-types tests/browser/fixture-server.ts',
    url: 'http://127.0.0.1:3210/sign-in',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
