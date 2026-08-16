import assert from 'node:assert/strict';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DISPOSABLE_TEST_DATABASE = /^disburse_phase1a_test(?:_[a-z0-9_]+)?$/i;

export function assertDisposablePostgresTestDatabase(configuredUrl: string) {
  const parsed = new URL(configuredUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

  assert.ok(
    LOOPBACK_HOSTS.has(parsed.hostname),
    'PHASE1A_TEST_DATABASE_URL must use a local PostgreSQL host'
  );
  assert.notEqual(databaseName, 'disburse_dev', 'disburse_dev must never be used for tests');
  assert.ok(
    DISPOSABLE_TEST_DATABASE.test(databaseName),
    'PHASE1A_TEST_DATABASE_URL must name a disposable disburse_phase1a_test database'
  );

  return parsed;
}
