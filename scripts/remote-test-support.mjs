import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';

// Allow only process/runtime settings through; a developer's provider credentials
// must never become the authority for this gate or Next's environment-file loading.
export async function remoteTestEnvironment(source, root) {
  /** @type {Record<string, string>} */
  const environment = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG', 'LC_ALL', 'TZ', 'CI', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local']) {
    try {
      for (const key of Object.keys(parse(await readFile(new URL(name, root))))) environment[key] = '';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  Object.assign(environment, {
    NODE_ENV: 'test', NEXT_TELEMETRY_DISABLED: '1',
    PHASE1A_TEST_DATABASE_URL: source.PHASE1A_TEST_DATABASE_URL,
    POSTGRES_URL: source.PHASE1A_TEST_DATABASE_URL,
    AUTH_SECRET: 'remote-test-auth-secret-for-disposable-fixtures',
    DISBURSE_DEPLOYMENT_ENV: 'test', DISBURSE_PROCESSOR_MODE: 'worker',
    DISBURSE_CRON_EXPECTED: 'false', DISBURSE_PIPELINE_KILL_SWITCH: 'false',
    DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'false', DISBURSE_FAULT_INJECTION: '',
    DISBURSE_FAULT_INJECTION_SECRET: '', INTERNAL_PROCESSING_SECRET: 'remote-test-internal',
    CRON_SECRET: 'remote-test-cron', OPERATIONAL_SNAPSHOT_SECRET: 'remote-test-snapshot',
    OPENAI_API_KEY: '', STRIPE_SECRET_KEY: 'sk_test_placeholder_remote_gate', STRIPE_WEBHOOK_SECRET: '',
    S3_UPLOAD_ACCESS_KEY_ID: 'remote-test', S3_UPLOAD_SECRET_ACCESS_KEY: 'remote-test',
    S3_UPLOAD_BUCKET: 'remote-test', S3_UPLOAD_REGION: 'us-east-1', S3_UPLOAD_PATH_STYLE: 'true',
    S3_UPLOAD_ENDPOINT: 'http://127.0.0.1:1', MEDIA_API_BASE_URL: 'http://127.0.0.1:1',
    MEDIA_API_SECRET: 'remote-test-media',
    APP_URL: 'http://127.0.0.1:3000', BASE_URL: 'http://127.0.0.1:3000', NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3000',
    FFMPEG_PATH: source.FFMPEG_PATH || 'ffmpeg', FFPROBE_PATH: source.FFPROBE_PATH || 'ffprobe',
    PYTHONPATH: new URL('services/media-api', root).pathname,
  });
  return environment;
}

export function assertCompleteTap(output) {
  const count = (name) => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
  assert.ok(count('tests') > 0, 'Node test runner produced no completed test summary');
  assert.equal(count('fail'), 0, 'Node tests failed');
  assert.equal(count('cancelled'), 0, 'Node tests were cancelled');
  assert.equal(count('skipped'), 0, 'Required Node tests skipped; this gate fails closed');
  assert.equal(count('todo'), 0, 'Required Node tests are marked TODO');
}

export async function runTestCommand(command, args, options) {
  assert.notEqual(process.platform, 'win32', 'The remote gate requires Linux or macOS process-group cleanup');
  const chunks = [];
  const child = spawn(command, args, { ...options, timeoutMs: undefined, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => chunks.push(chunk));
  let timedOut = false;
  let interrupted = false;
  let escalation;
  const killGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const terminate = () => {
    killGroup('SIGTERM');
    escalation ??= setTimeout(() => killGroup('SIGKILL'), 1_000);
  };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
  const interrupt = () => { interrupted = true; terminate(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, timedOut, interrupted, output: Buffer.concat(chunks).toString() };
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    // A successful parent must not strand background fixture servers either.
    killGroup('SIGKILL');
  }
}
