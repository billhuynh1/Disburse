import assert from 'node:assert/strict';
import test from 'node:test';

import { assertDisposablePostgresTestDatabase } from './test-database-guard.ts';

test('disposable PostgreSQL guard accepts only local phase test databases', () => {
  assert.equal(
    assertDisposablePostgresTestDatabase('postgres://localhost/disburse_phase1a_test_20260815').pathname,
    '/disburse_phase1a_test_20260815'
  );
  assert.throws(
    () => assertDisposablePostgresTestDatabase('postgres://localhost/disburse_dev'),
    /disburse_dev/
  );
  assert.throws(
    () => assertDisposablePostgresTestDatabase('postgres://db.example.com/disburse_phase1a_test'),
    /local PostgreSQL host/
  );
  assert.throws(
    () => assertDisposablePostgresTestDatabase('postgres://localhost/disburse_production'),
    /disposable/
  );
});
