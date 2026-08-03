import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';

export const FAULT_INJECTION_PROVIDERS = ['openai', 's3', 'media', 'render', 'facecam'] as const;
export const FAULT_INJECTION_POINTS = ['before_send', 'after_send_before_response', 'after_provider_success_before_persistence', 'after_checkpoint_persistence_before_finalization'] as const;
export type FaultInjectionProvider = typeof FAULT_INJECTION_PROVIDERS[number];
export type FaultInjectionPoint = typeof FAULT_INJECTION_POINTS[number];
const authorization = new AsyncLocalStorage<string | null>();

export class OperationalFaultInjectionError extends Error {
  readonly code = 'operational_fault_injected';
  constructor(readonly provider: FaultInjectionProvider, readonly point: FaultInjectionPoint) {
    super(`Staging fault injected at ${provider}:${point}.`);
    this.name = 'OperationalFaultInjectionError';
  }
}

export function parseFaultInjection(value: string | undefined) {
  if (!value) return null;
  const [provider, point, extra] = value.split(':');
  if (extra || !FAULT_INJECTION_PROVIDERS.includes(provider as FaultInjectionProvider) || !FAULT_INJECTION_POINTS.includes(point as FaultInjectionPoint)) return null;
  return { provider: provider as FaultInjectionProvider, point: point as FaultInjectionPoint };
}

function authorized(provided: string | null | undefined, expected: string | undefined) {
  if (!provided || !expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function runWithOperationalFaultAuthorization<T>(value: string | null, callback: () => T): T {
  return authorization.run(value, callback);
}

export function maybeInjectOperationalFault(provider: FaultInjectionProvider, point: FaultInjectionPoint, env: Readonly<Record<string, string | undefined>> = process.env, providedAuthorization: string | null = authorization.getStore() ?? null) {
  if (env.DISBURSE_DEPLOYMENT_ENV !== 'staging') return;
  if (env.DISBURSE_STAGING_FAULT_INJECTION_ENABLED !== 'true') return;
  if (!authorized(providedAuthorization, env.DISBURSE_FAULT_INJECTION_SECRET)) return;
  const configured = parseFaultInjection(env.DISBURSE_FAULT_INJECTION);
  if (configured?.provider === provider && configured.point === point) throw new OperationalFaultInjectionError(provider, point);
}
