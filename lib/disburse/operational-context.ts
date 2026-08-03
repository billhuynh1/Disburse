import { AsyncLocalStorage } from 'node:async_hooks';

type OperationalInvocationContext = {
  invocationId: string;
  origin: 'internal' | 'cron';
};

const storage = new AsyncLocalStorage<OperationalInvocationContext>();

export function runWithOperationalInvocation<T>(
  context: OperationalInvocationContext,
  operation: () => Promise<T>
) {
  return storage.run(context, operation);
}

export function getOperationalCorrelation() {
  return storage.getStore() ?? { invocationId: '00000000-0000-4000-8000-000000000000' };
}
