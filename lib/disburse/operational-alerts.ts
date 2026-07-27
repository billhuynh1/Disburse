import type { OperationalSnapshot } from '@/lib/disburse/operational-snapshot';

export type OperationalAlert = { id: string; severity: 'warning' | 'critical'; runbook: string; active: boolean };

export const OPERATIONAL_ALERT_THRESHOLDS = Object.freeze({
  cronAgeSeconds: 900, cronFailures: 3, heartbeatAgeSeconds: 300,
  queueDepth: 25, queueAgeSeconds: 900, reconciliationAgeSeconds: 900,
  deletionAgeSeconds: 1800, capacitySignals: 3, providerFailures: 5,
  auditMinimumRows: 100, auditGrowthFactor: 2,
});

export function checkOperationalAlerts(s: OperationalSnapshot): OperationalAlert[] {
  if (!s.schema.verified) {
    return [{ id: 'migration_failure', severity: 'critical', runbook: 'runbooks.md#migration-failure', active: true }];
  }
  const reconciliationProcessorActive = s.scheduler.heartbeatAgeSeconds !== null &&
    s.scheduler.heartbeatAgeSeconds < OPERATIONAL_ALERT_THRESHOLDS.heartbeatAgeSeconds;
  const checks: OperationalAlert[] = [
    { id: 'cron_missing', severity: 'critical', runbook: 'runbooks.md#cron-failure', active: s.scheduler.cronExpected && s.scheduler.lastCronAgeSeconds === null },
    { id: 'cron_stale', severity: 'critical', runbook: 'runbooks.md#cron-failure', active: s.scheduler.cronExpected && s.scheduler.lastCronAgeSeconds !== null && s.scheduler.lastCronAgeSeconds > OPERATIONAL_ALERT_THRESHOLDS.cronAgeSeconds },
    { id: 'cron_failure', severity: 'critical', runbook: 'runbooks.md#cron-failure', active: s.scheduler.lastCronFailed },
    { id: 'cron_repeated_failure', severity: 'critical', runbook: 'runbooks.md#cron-failure', active: s.scheduler.repeatedCronFailures >= OPERATIONAL_ALERT_THRESHOLDS.cronFailures },
    { id: 'internal_trigger_failure', severity: 'warning', runbook: 'runbooks.md#cron-failure', active: s.scheduler.internalTriggerFailures15m > 0 },
    { id: 'scheduler_stall', severity: 'critical', runbook: 'runbooks.md#scheduler-stall', active: s.queue.depth > 0 && (s.scheduler.heartbeatAgeSeconds === null || s.scheduler.heartbeatAgeSeconds >= OPERATIONAL_ALERT_THRESHOLDS.heartbeatAgeSeconds) },
    { id: 'queue_backlog', severity: 'warning', runbook: 'runbooks.md#scheduler-stall', active: s.queue.depth >= OPERATIONAL_ALERT_THRESHOLDS.queueDepth || s.queue.oldestAgeSeconds >= OPERATIONAL_ALERT_THRESHOLDS.queueAgeSeconds },
    { id: 'lease_takeover', severity: 'warning', runbook: 'runbooks.md#lease-takeover', active: s.leases.expired > 0 || s.locks.expiredOwnerPresent },
    { id: 'reconciliation_stall', severity: 'critical', runbook: 'runbooks.md#reconciliation-stall', active: reconciliationProcessorActive && (s.reconciliation.progressAgeSeconds === null || s.reconciliation.progressAgeSeconds > OPERATIONAL_ALERT_THRESHOLDS.reconciliationAgeSeconds) },
    { id: 'ambiguous_effects', severity: 'critical', runbook: 'runbooks.md#ambiguous-effects', active: s.checkpoints.ambiguous > 0 },
    { id: 'deletion_stall', severity: 'critical', runbook: 'runbooks.md#deletion-stall', active: s.deletion.backlog > 0 && s.deletion.oldestAgeSeconds >= OPERATIONAL_ALERT_THRESHOLDS.deletionAgeSeconds },
    { id: 'recovery_budget_exhaustion', severity: 'critical', runbook: 'runbooks.md#recovery-budget-exhaustion', active: s.recovery.budgetExhausted > 0 || s.lineage.budgetExhausted > 0 },
    { id: 'capacity_sustained', severity: 'warning', runbook: 'runbooks.md#scheduler-stall', active: s.capacity.blocked && s.capacity.blockedSignals15m >= OPERATIONAL_ALERT_THRESHOLDS.capacitySignals },
    { id: 'provider_outage', severity: 'critical', runbook: 'runbooks.md#provider-outage', active: s.providers.failures15m >= OPERATIONAL_ALERT_THRESHOLDS.providerFailures && Object.values(s.providers.byProvider).some(count => count >= OPERATIONAL_ALERT_THRESHOLDS.providerFailures) },
    { id: 'unknown_failure_class', severity: 'warning', runbook: 'runbooks.md#provider-outage', active: s.failures.unknown15m > 0 },
    { id: 'audit_growth', severity: 'warning', runbook: 'runbooks.md#audit-growth', active: s.audit.previous24h >= OPERATIONAL_ALERT_THRESHOLDS.auditMinimumRows && s.audit.rows24h >= s.audit.previous24h * OPERATIONAL_ALERT_THRESHOLDS.auditGrowthFactor },
    { id: 'migration_failure', severity: 'critical', runbook: 'runbooks.md#migration-failure', active: !s.schema.verified },
  ];
  return checks.filter(c => c.active);
}
