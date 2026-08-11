import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkOperationalAlerts, OPERATIONAL_ALERT_THRESHOLDS } from './operational-alerts.ts';
import { authorizeOperationalSnapshot } from './operational-authorization.ts';
import { FAULT_INJECTION_POINTS, FAULT_INJECTION_PROVIDERS, maybeInjectOperationalFault, OperationalFaultInjectionError } from './fault-injection.ts';
import { isOperationalCronExpected } from './operational-environment.ts';
import type { OperationalSnapshot } from './operational-snapshot.ts';

test('snapshot authorization is deny-by-default and exact', () => {
  assert.equal(authorizeOperationalSnapshot(null, 'secret-value'), false);
  assert.equal(authorizeOperationalSnapshot('Bearer secret-value', undefined), false);
  assert.equal(authorizeOperationalSnapshot('Basic secret-value', 'secret-value'), false);
  assert.equal(authorizeOperationalSnapshot('Bearer ', 'secret-value'), false);
  assert.equal(authorizeOperationalSnapshot('bearer secret-value', 'secret-value'), false);
  assert.equal(authorizeOperationalSnapshot(' Bearer secret-value', 'secret-value'), false);
  assert.equal(authorizeOperationalSnapshot('Bearer  secret-value', 'secret-value'), false);
  assert.equal(authorizeOperationalSnapshot('Bearer secret-value ', 'secret-value'), false);
  assert.equal(authorizeOperationalSnapshot('Bearer wrong-value', 'secret-value'), false);
  assert.equal(authorizeOperationalSnapshot('Bearer secret-value', 'secret-value'), true);
});

test('fault injection full matrix requires explicit staging identity, switch, and protected authorization', () => {
  for (const provider of FAULT_INJECTION_PROVIDERS) for (const point of FAULT_INJECTION_POINTS) {
    const env = { DISBURSE_DEPLOYMENT_ENV: 'staging', DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'true', DISBURSE_FAULT_INJECTION: `${provider}:${point}`, DISBURSE_FAULT_INJECTION_SECRET: 'fault-secret' };
    assert.throws(() => maybeInjectOperationalFault(provider, point, env, 'fault-secret'), (error) => error instanceof OperationalFaultInjectionError && error.provider === provider && error.point === point);
    for (const disabled of [
      { ...env, DISBURSE_DEPLOYMENT_ENV: 'production' },
      { ...env, DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'false' },
      { ...env, DISBURSE_FAULT_INJECTION_SECRET: '' },
    ]) assert.doesNotThrow(() => maybeInjectOperationalFault(provider, point, disabled, 'fault-secret'));
    assert.doesNotThrow(() => maybeInjectOperationalFault(provider, point, env, 'wrong-secret'));
  }
});

function snapshot(overrides: Partial<OperationalSnapshot> = {}): OperationalSnapshot {
  return {
    generatedAt: new Date(0).toISOString(), schema: { expectedVersion: 35, verified: true, reason: 'verified' },
    queue: { depth: 0, oldestAgeSeconds: 0 }, scheduler: { cronExpected: false, heartbeatAgeSeconds: 0, leaseExpired: false, processorOwned: false, lastCronAgeSeconds: 0, lastCronFailed: false, repeatedCronFailures: 0, internalTriggerFailures15m: 0 },
    leases: { expired: 0, processing: 0 }, reconciliation: { cursor: null, cycle: 0, progressAgeSeconds: 0, progressCount: 0 }, checkpoints: { prepared: 0, ambiguous: 0 },
    deletion: { backlog: 0, oldestAgeSeconds: 0 }, recovery: { accepted24h: 0, rejected24h: 0, budgetExhausted: 0 }, lineage: { budgetExhausted: 0 },
    capacity: { renderActive: 0, facecamActive: 0, renderLimit: 1, facecamLimit: 1, blocked: false, blockedSignals15m: 0 }, locks: { schedulerHeld: false, expiredOwnerPresent: false },
    audit: { rows24h: 0, previous24h: 0, growth: 0 }, providers: { failures15m: 0, byProvider: { openai: 0, s3: 0, media: 0, render: 0, facecam: 0 } }, failures: { unknown15m: 0 }, ...overrides,
  };
}

test('Cron expectation is explicit and defaults only for deployed production', () => {
  assert.equal(isOperationalCronExpected({ DISBURSE_DEPLOYMENT_ENV: 'test' }), false);
  assert.equal(isOperationalCronExpected({ DISBURSE_DEPLOYMENT_ENV: 'production' }), true);
  assert.equal(isOperationalCronExpected({ DISBURSE_DEPLOYMENT_ENV: 'production', DISBURSE_CRON_EXPECTED: 'false' }), false);
  assert.equal(isOperationalCronExpected({ DISBURSE_DEPLOYMENT_ENV: 'staging', DISBURSE_CRON_EXPECTED: 'true' }), true);
});

test('alerts have documented equality boundaries and unrelated-signal negatives', () => {
  assert.deepEqual(checkOperationalAlerts(snapshot()), []);
  const active = (id: string, value: OperationalSnapshot) => checkOperationalAlerts(value).some(alert => alert.id === id);
  const scheduler = (values: Partial<OperationalSnapshot['scheduler']>) => snapshot({ scheduler: { ...snapshot().scheduler, ...values } });
  const cases: Array<[string, OperationalSnapshot, boolean]> = [
    ['cron_failure', scheduler({ lastCronFailed: true }), true],
    ['cron_repeated_failure', scheduler({ repeatedCronFailures: 2 }), false],
    ['cron_repeated_failure', scheduler({ repeatedCronFailures: 3 }), true],
    ['internal_trigger_failure', scheduler({ internalTriggerFailures15m: 1 }), true],
    ['scheduler_stall', snapshot({ queue: { depth: 1, oldestAgeSeconds: 0 }, scheduler: { ...snapshot().scheduler, heartbeatAgeSeconds: 300 } }), true],
    ['queue_backlog', snapshot({ queue: { depth: 24, oldestAgeSeconds: 899 } }), false],
    ['queue_backlog', snapshot({ queue: { depth: 25, oldestAgeSeconds: 0 } }), true],
    ['lease_takeover', snapshot({ leases: { expired: 1, processing: 1 } }), true],
    ['ambiguous_effects', snapshot({ checkpoints: { prepared: 0, ambiguous: 1 } }), true],
    ['deletion_stall', snapshot({ deletion: { backlog: 1, oldestAgeSeconds: 1800 } }), true],
    ['recovery_budget_exhaustion', snapshot({ recovery: { ...snapshot().recovery, budgetExhausted: 1 } }), true],
    ['capacity_sustained', snapshot({ capacity: { ...snapshot().capacity, blocked: true, blockedSignals15m: 3 } }), true],
    ['provider_outage', snapshot({ providers: { failures15m: 5, byProvider: { ...snapshot().providers.byProvider, openai: 5 } } }), true],
    ['unknown_failure_class', snapshot({ failures: { unknown15m: 1 } }), true],
    ['audit_growth', snapshot({ audit: { rows24h: 200, previous24h: 100, growth: 100 } }), true],
    ['migration_failure', snapshot({ schema: { expectedVersion: 35, verified: false, reason: 'incompatible' } }), true],
  ];
  for (const [id, value, expected] of cases) assert.equal(active(id, value), expected, id);
  const noProviderInference = snapshot({ providers: { failures15m: 5, byProvider: { openai: 1, s3: 1, media: 1, render: 1, facecam: 1 } } });
  assert.equal(checkOperationalAlerts(noProviderInference).some(a => a.id === 'provider_outage'), false);
});

test('schema-unverified snapshots emit only migration failure', () => {
  const unverified = snapshot({ schema: { expectedVersion: 35, verified: false, reason: 'incompatible' }, scheduler: { ...snapshot().scheduler, cronExpected: true, lastCronAgeSeconds: null }, queue: { depth: 100, oldestAgeSeconds: 10_000 } });
  assert.deepEqual(checkOperationalAlerts(unverified), [
    { id: 'migration_failure', severity: 'critical', runbook: 'runbooks.md#migration-failure', active: true },
  ]);
});

test('verified alert identifiers, thresholds, and severities remain closed and unchanged', () => {
  assert.deepEqual(OPERATIONAL_ALERT_THRESHOLDS, {
    cronAgeSeconds: 900, cronFailures: 3, heartbeatAgeSeconds: 300,
    queueDepth: 25, queueAgeSeconds: 900, reconciliationAgeSeconds: 900,
    deletionAgeSeconds: 1800, capacitySignals: 3, providerFailures: 5,
    auditMinimumRows: 100, auditGrowthFactor: 2,
  });
  const allRuntime = snapshot({
    queue: { depth: 25, oldestAgeSeconds: 900 },
    scheduler: { ...snapshot().scheduler, cronExpected: true, heartbeatAgeSeconds: 300, lastCronAgeSeconds: 901, lastCronFailed: true, repeatedCronFailures: 3, internalTriggerFailures15m: 1 },
    leases: { expired: 1, processing: 1 },
    checkpoints: { prepared: 0, ambiguous: 1 }, deletion: { backlog: 1, oldestAgeSeconds: 1800 },
    recovery: { ...snapshot().recovery, budgetExhausted: 1 },
    capacity: { ...snapshot().capacity, blocked: true, blockedSignals15m: 3 },
    providers: { failures15m: 5, byProvider: { ...snapshot().providers.byProvider, openai: 5 } },
    failures: { unknown15m: 1 }, audit: { rows24h: 200, previous24h: 100, growth: 100 },
  });
  const reconciliation = snapshot({ scheduler: { ...snapshot().scheduler, heartbeatAgeSeconds: 1 }, reconciliation: { ...snapshot().reconciliation, progressAgeSeconds: null } });
  const cronMissing = snapshot({ scheduler: { ...snapshot().scheduler, cronExpected: true, lastCronAgeSeconds: null } });
  const active = [...checkOperationalAlerts(allRuntime), ...checkOperationalAlerts(reconciliation), ...checkOperationalAlerts(cronMissing)];
  const ids = [...new Set(active.map((alert) => alert.id))].sort();
  assert.deepEqual(ids, [
    'ambiguous_effects', 'audit_growth', 'capacity_sustained', 'cron_failure', 'cron_missing', 'cron_repeated_failure', 'cron_stale',
    'deletion_stall', 'internal_trigger_failure', 'lease_takeover', 'provider_outage', 'queue_backlog', 'reconciliation_stall',
    'recovery_budget_exhaustion', 'scheduler_stall', 'unknown_failure_class',
  ]);
  assert.equal(new Set(active.map((alert) => alert.id)).size, active.length);
  assert.deepEqual([...new Set(active.map((alert) => alert.severity))].sort(), ['critical', 'warning']);
  assert.deepEqual(Object.fromEntries(active.map((alert) => [alert.id, alert.severity])), {
    cron_stale: 'critical', cron_failure: 'critical', cron_repeated_failure: 'critical', internal_trigger_failure: 'warning',
    scheduler_stall: 'critical', queue_backlog: 'warning', lease_takeover: 'warning', ambiguous_effects: 'critical',
    deletion_stall: 'critical', recovery_budget_exhaustion: 'critical', capacity_sustained: 'warning', provider_outage: 'critical',
    unknown_failure_class: 'warning', audit_growth: 'warning', reconciliation_stall: 'critical', cron_missing: 'critical',
  });
  const activeWithSchemaFailure = [...active, ...checkOperationalAlerts(snapshot({ schema: { expectedVersion: 35, verified: false, reason: 'incompatible' } }))];
  assert.deepEqual(Object.fromEntries(activeWithSchemaFailure.map((alert) => [alert.id, alert.runbook])), {
    cron_stale: 'runbooks.md#cron-failure', cron_failure: 'runbooks.md#cron-failure', cron_repeated_failure: 'runbooks.md#cron-failure',
    internal_trigger_failure: 'runbooks.md#cron-failure', scheduler_stall: 'runbooks.md#scheduler-stall',
    queue_backlog: 'runbooks.md#scheduler-stall', lease_takeover: 'runbooks.md#lease-takeover',
    ambiguous_effects: 'runbooks.md#ambiguous-effects', deletion_stall: 'runbooks.md#deletion-stall',
    recovery_budget_exhaustion: 'runbooks.md#recovery-budget-exhaustion', capacity_sustained: 'runbooks.md#scheduler-stall',
    provider_outage: 'runbooks.md#provider-outage', unknown_failure_class: 'runbooks.md#provider-outage',
    audit_growth: 'runbooks.md#audit-growth', reconciliation_stall: 'runbooks.md#reconciliation-stall',
    cron_missing: 'runbooks.md#cron-failure', migration_failure: 'runbooks.md#migration-failure',
  });
});

test('every alert has isolated below, equality, and above-threshold behavior', () => {
  const active = (id: string, value: OperationalSnapshot) => checkOperationalAlerts(value).some(alert => alert.id === id);
  const withScheduler = (values: Partial<OperationalSnapshot['scheduler']>) => snapshot({ scheduler: { ...snapshot().scheduler, ...values } });
  const cases: Array<[string, OperationalSnapshot, OperationalSnapshot, OperationalSnapshot]> = [
    ['cron_failure', withScheduler({ lastCronFailed: false }), withScheduler({ lastCronFailed: true }), withScheduler({ lastCronFailed: true, repeatedCronFailures: 1 })],
    ['cron_repeated_failure', withScheduler({ repeatedCronFailures: 2 }), withScheduler({ repeatedCronFailures: 3 }), withScheduler({ repeatedCronFailures: 4 })],
    ['internal_trigger_failure', withScheduler({ internalTriggerFailures15m: 0 }), withScheduler({ internalTriggerFailures15m: 1 }), withScheduler({ internalTriggerFailures15m: 2 })],
    ['scheduler_stall', snapshot({ queue: { depth: 1, oldestAgeSeconds: 0 }, scheduler: { ...snapshot().scheduler, heartbeatAgeSeconds: 299 } }), snapshot({ queue: { depth: 1, oldestAgeSeconds: 0 }, scheduler: { ...snapshot().scheduler, heartbeatAgeSeconds: 300 } }), snapshot({ queue: { depth: 1, oldestAgeSeconds: 0 }, scheduler: { ...snapshot().scheduler, heartbeatAgeSeconds: 301 } })],
    ['queue_backlog', snapshot({ queue: { depth: 24, oldestAgeSeconds: 899 } }), snapshot({ queue: { depth: 25, oldestAgeSeconds: 0 } }), snapshot({ queue: { depth: 26, oldestAgeSeconds: 0 } })],
    ['lease_takeover', snapshot(), snapshot({ leases: { expired: 1, processing: 1 } }), snapshot({ leases: { expired: 2, processing: 2 } })],
    ['ambiguous_effects', snapshot(), snapshot({ checkpoints: { prepared: 0, ambiguous: 1 } }), snapshot({ checkpoints: { prepared: 0, ambiguous: 2 } })],
    ['deletion_stall', snapshot({ deletion: { backlog: 1, oldestAgeSeconds: 1799 } }), snapshot({ deletion: { backlog: 1, oldestAgeSeconds: 1800 } }), snapshot({ deletion: { backlog: 1, oldestAgeSeconds: 1801 } })],
    ['recovery_budget_exhaustion', snapshot(), snapshot({ recovery: { ...snapshot().recovery, budgetExhausted: 1 } }), snapshot({ recovery: { ...snapshot().recovery, budgetExhausted: 2 } })],
    ['capacity_sustained', snapshot({ capacity: { ...snapshot().capacity, blocked: true, blockedSignals15m: 2 } }), snapshot({ capacity: { ...snapshot().capacity, blocked: true, blockedSignals15m: 3 } }), snapshot({ capacity: { ...snapshot().capacity, blocked: true, blockedSignals15m: 4 } })],
    ['provider_outage', snapshot({ providers: { failures15m: 4, byProvider: { ...snapshot().providers.byProvider, openai: 4 } } }), snapshot({ providers: { failures15m: 5, byProvider: { ...snapshot().providers.byProvider, openai: 5 } } }), snapshot({ providers: { failures15m: 6, byProvider: { ...snapshot().providers.byProvider, openai: 6 } } })],
    ['unknown_failure_class', snapshot(), snapshot({ failures: { unknown15m: 1 } }), snapshot({ failures: { unknown15m: 2 } })],
    ['audit_growth', snapshot({ audit: { rows24h: 199, previous24h: 100, growth: 99 } }), snapshot({ audit: { rows24h: 200, previous24h: 100, growth: 100 } }), snapshot({ audit: { rows24h: 201, previous24h: 100, growth: 101 } })],
    ['migration_failure', snapshot(), snapshot({ schema: { expectedVersion: 35, verified: false, reason: 'incompatible' } }), snapshot({ schema: { expectedVersion: 35, verified: false, reason: 'missing' } })],
  ];
  for (const [id, below, equal, above] of cases) {
    assert.equal(active(id, below), false, `${id}:below`);
    assert.equal(active(id, equal), true, `${id}:equal`);
    assert.equal(active(id, above), true, `${id}:above`);
  }
});

test('Cron and reconciliation alert states are isolated with strict age boundaries', () => {
  const withScheduler = (values: Partial<OperationalSnapshot['scheduler']>) =>
    snapshot({ scheduler: { ...snapshot().scheduler, ...values } });
  const withReconciliation = (progressAgeSeconds: number | null, reconciliation: Partial<OperationalSnapshot['reconciliation']> = {}) =>
    snapshot({
      queue: { depth: 0, oldestAgeSeconds: 0 },
      scheduler: { ...snapshot().scheduler, heartbeatAgeSeconds: 1 },
      reconciliation: { ...snapshot().reconciliation, progressAgeSeconds, ...reconciliation },
    });
  const cases: Array<[string, OperationalSnapshot, string[]]> = [
    ['Cron not expected, never run', withScheduler({ cronExpected: false, lastCronAgeSeconds: null }), []],
    ['Cron not expected, stale', withScheduler({ cronExpected: false, lastCronAgeSeconds: 901 }), []],
    ['Cron expected, never run', withScheduler({ cronExpected: true, lastCronAgeSeconds: null }), ['cron_missing']],
    ['Cron below stale threshold', withScheduler({ cronExpected: true, lastCronAgeSeconds: 899 }), []],
    ['Cron exactly at stale threshold', withScheduler({ cronExpected: true, lastCronAgeSeconds: 900 }), []],
    ['Cron above stale threshold', withScheduler({ cronExpected: true, lastCronAgeSeconds: 901 }), ['cron_stale']],
    ['reconciliation never run while scheduler is active', withReconciliation(null), ['reconciliation_stall']],
    ['reconciliation below threshold', withReconciliation(899), []],
    ['reconciliation exactly at threshold', withReconciliation(900), []],
    ['empty queue, heartbeat-only reconciliation above threshold', withReconciliation(901), ['reconciliation_stall']],
    ['genuine reconciliation cursor movement', withReconciliation(0, { cursor: 44, progressCount: 1 }), []],
    ['genuine reconciliation cycle completion', withReconciliation(0, { cursor: null, cycle: 1, progressCount: 1 }), []],
    ['old reconciliation without continuing scheduler activity', snapshot({ reconciliation: { ...snapshot().reconciliation, progressAgeSeconds: 901 }, scheduler: { ...snapshot().scheduler, heartbeatAgeSeconds: null } }), []],
  ];
  for (const [name, value, expectedIds] of cases) {
    assert.deepEqual(checkOperationalAlerts(value).map(alert => alert.id), expectedIds, name);
  }
});

test('implementation probes schema before snapshot data and provider hooks are inside real integrations', async () => {
  const snapshotSource = await readFile(new URL('./operational-snapshot.ts', import.meta.url), 'utf8');
  assert.ok(snapshotSource.indexOf('verifyOperationalSchema(executor)') < snapshotSource.indexOf('select\n      (select count(*)::int from jobs'));
  assert.match(snapshotSource, /if \(!schema\.verified\) return emptySnapshot/);
  for (const file of ['openai-transcription.ts','openai-short-form.ts','openai-package-assets.ts','s3-storage.ts','media-api-client.ts','youtube-ingestion-service.ts']) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /responsePromise/);
    assert.match(source, /afterExternalEffectSendBoundary/);
    assert.match(source, /afterExternalEffectSuccessBoundary/);
  }
  assert.doesNotMatch(snapshotSource, /select\s+\*|jobs\.payload|payload\s*->|transcript_text|storage_url|idempotency_key/i);
});

test('route correlation and publishing prohibitions cover every server entry point', async () => {
  for (const route of ['../../app/api/internal/jobs/process/route.ts','../../app/api/cron/process-jobs/route.ts']) {
    const source = await readFile(new URL(route, import.meta.url), 'utf8');
    assert.match(source, /const invocationId = randomUUID\(\)/);
    assert.match(source, /processor\(\{ origin: '(?:internal|cron)', invocationId \}\)/);
    assert.doesNotMatch(source, /catch[\s\S]{0,300}invocationId: randomUUID\(\)/);
  }
  for (const file of ['actions.ts','job-service.ts','pipeline-service.ts','publishing-service.ts','job-recovery-service.ts']) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /publishing_(?:prohibited|recovery_forbidden)|DirectPublishing|assertDirectPublishing|DIRECT_PUBLISHING/i, file);
  }
});
