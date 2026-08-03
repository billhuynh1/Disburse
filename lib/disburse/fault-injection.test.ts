import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { JobType } from '@/lib/db/schema';
import {
  getFaultInjectionProviderForJobType,
  getOperationalFaultInjectionError,
} from './job-effect-checkpoint-service.ts';
import {
  maybeInjectOperationalFault,
  OperationalFaultInjectionError,
  runWithOperationalFaultAuthorization,
} from './fault-injection.ts';

const enabledEnvironment = {
  DISBURSE_DEPLOYMENT_ENV: 'staging',
  DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'true',
  DISBURSE_FAULT_INJECTION: 's3:before_send',
  DISBURSE_FAULT_INJECTION_SECRET: 'fault-secret',
} as const;

test('only checkpoint-represented single-effect job types select a fault provider', () => {
  assert.equal(
    getFaultInjectionProviderForJobType(JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL),
    's3'
  );
  assert.equal(
    getFaultInjectionProviderForJobType(JobType.RENDER_CLIP_CANDIDATE),
    'render'
  );
  assert.equal(
    getFaultInjectionProviderForJobType(JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
    'render'
  );
  assert.equal(
    getFaultInjectionProviderForJobType(JobType.DETECT_CLIP_FACECAM),
    'facecam'
  );

  for (const jobType of [
    JobType.TRANSCRIBE_SOURCE_ASSET,
    JobType.GENERATE_SHORT_FORM_PACK,
    JobType.INGEST_YOUTUBE_SOURCE_ASSET,
    JobType.PUBLISH_RENDERED_CLIP,
  ]) {
    assert.equal(getFaultInjectionProviderForJobType(jobType), null, jobType);
  }
});

test('fault injection requires staging, switch, and independent exact authorization', () => {
  assert.doesNotThrow(() => maybeInjectOperationalFault('s3', 'before_send', enabledEnvironment));
  assert.doesNotThrow(() => runWithOperationalFaultAuthorization('wrong', () =>
    maybeInjectOperationalFault('s3', 'before_send', enabledEnvironment)
  ));
  assert.doesNotThrow(() => runWithOperationalFaultAuthorization('fault-secret', () =>
    maybeInjectOperationalFault('s3', 'before_send', {
      ...enabledEnvironment,
      DISBURSE_DEPLOYMENT_ENV: 'development',
    })
  ));
  assert.doesNotThrow(() => runWithOperationalFaultAuthorization('fault-secret', () =>
    maybeInjectOperationalFault('s3', 'before_send', {
      ...enabledEnvironment,
      DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'false',
    })
  ));
  assert.throws(
    () => runWithOperationalFaultAuthorization('fault-secret', () =>
      maybeInjectOperationalFault('s3', 'before_send', enabledEnvironment)
    ),
    OperationalFaultInjectionError
  );
});

test('authorized fault contexts remain isolated across concurrent and sequential invocations', async () => {
  const [authorized, unauthorized] = await Promise.all([
    runWithOperationalFaultAuthorization('fault-secret', async () => {
      await Promise.resolve();
      try {
        maybeInjectOperationalFault('s3', 'before_send', enabledEnvironment);
        return false;
      } catch (error) {
        return error instanceof OperationalFaultInjectionError;
      }
    }),
    runWithOperationalFaultAuthorization('wrong', async () => {
      await Promise.resolve();
      try {
        maybeInjectOperationalFault('s3', 'before_send', enabledEnvironment);
        return false;
      } catch {
        return true;
      }
    }),
  ]);
  assert.equal(authorized, true);
  assert.equal(unauthorized, false);

  assert.doesNotThrow(() => maybeInjectOperationalFault('s3', 'before_send', enabledEnvironment));
});

test('injected faults remain recoverable through wrapped provider and checkpoint causes', () => {
  const injected = new OperationalFaultInjectionError('facecam', 'after_send_before_response');
  const providerWrapped = new Error('Media API request failed.', { cause: injected });
  const checkpointWrapped = new Error('External effect outcome is ambiguous.', { cause: providerWrapped });

  assert.equal(getOperationalFaultInjectionError(checkpointWrapped), injected);
});

test('recognizes only exact-class injected faults through bounded safe cause chains', () => {
  const direct = new OperationalFaultInjectionError('s3', 'before_send');
  assert.equal(getOperationalFaultInjectionError(direct), direct);

  const wrapped = new Error('provider failed', { cause: direct });
  assert.equal(getOperationalFaultInjectionError(wrapped), direct);

  const deeplyWrapped = Array.from({ length: 8 }).reduce<Error>(
    (cause) => new Error('wrapped provider failure', { cause }),
    direct
  );
  assert.equal(getOperationalFaultInjectionError(deeplyWrapped), direct);

  const cycle = new Error('cycle');
  Object.defineProperty(cycle, 'cause', { value: cycle });
  assert.equal(getOperationalFaultInjectionError(cycle), null);

  const throwingCause = new Error('provider failed');
  Object.defineProperty(throwingCause, 'cause', {
    get() { throw new Error('cause getter failure'); },
  });
  assert.doesNotThrow(() => getOperationalFaultInjectionError(throwingCause));
  assert.equal(getOperationalFaultInjectionError(throwingCause), null);

  const beyondLimit = Array.from({ length: 20 }).reduce<Error>(
    (cause) => new Error('wrapped provider failure', { cause }),
    direct
  );
  assert.equal(getOperationalFaultInjectionError(beyondLimit), null);
});

test('ordinary errors cannot spoof operational fault injection recognition', () => {
  const ordinary = new Error('operational_fault_injected');
  Object.assign(ordinary, {
    name: 'OperationalFaultInjectionError',
    code: 'operational_fault_injected',
    provider: 's3',
    point: 'before_send',
    marker: true,
  });
  const nested = new Error('provider request failed', { cause: ordinary });

  assert.equal(getOperationalFaultInjectionError(nested), null);
});

test('internal route checks the bearer before reading fault authorization', async () => {
  const route = await readFile(
    new URL('../../app/api/internal/jobs/process/route.ts', import.meta.url),
    'utf8'
  );
  assert.ok(route.indexOf("request.headers.get('authorization')") >= 0);
  assert.ok(route.indexOf("request.headers.get('authorization')") < route.indexOf(
    "request.headers.get('x-disburse-fault-injection-authorization')"
  ));
});
