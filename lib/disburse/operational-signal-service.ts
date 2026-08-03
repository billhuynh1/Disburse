import 'server-only';

import { db } from '@/lib/db/drizzle';
import { operationalSignals } from '@/lib/db/schema';
import type { OperationalFailureClass } from '@/lib/disburse/operational-events';

export type OperationalSignalType = 'internal_trigger_failure' | 'provider_failure' | 'capacity_blocked' | 'unknown_failure';
export type OperationalSignalProvider = 'openai' | 's3' | 'media' | 'render' | 'facecam';

export async function recordOperationalSignal(params: {
  signalType: OperationalSignalType;
  provider?: OperationalSignalProvider;
  failureClass?: OperationalFailureClass;
}) {
  await db.insert(operationalSignals).values({
    signalType: params.signalType,
    provider: params.provider ?? null,
    failureClass: params.failureClass ?? null,
  });
}
