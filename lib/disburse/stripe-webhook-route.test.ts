import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

const webhookSecret = 's4b-test-webhook-secret';
const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;

type StubState = {
  constructEvent: (...args: [string, string, string]) => unknown;
  handleSubscriptionChange: (subscription: unknown) => Promise<void>;
};

const stubs: StubState = {
  constructEvent: () => ({ type: 'unknown', data: { object: {} } }),
  handleSubscriptionChange: async () => {},
};

Object.assign(globalThis, { __s4bStripeWebhookStubs: stubs });

function dataModule(source: string) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

const moduleUrls = {
  stripe: dataModule('export default class Stripe {}'),
  'next/server': dataModule(`
    export class NextRequest {}
    export class NextResponse extends Response {
      static json(body, init = {}) { return Response.json(body, init); }
    }
  `),
  '@/lib/payments/stripe': dataModule(`
    export const stripe = {
      webhooks: {
        constructEvent: (...args) => globalThis.__s4bStripeWebhookStubs.constructEvent(...args),
      },
    };
    export const handleSubscriptionChange = (...args) =>
      globalThis.__s4bStripeWebhookStubs.handleSubscriptionChange(...args);
  `),
};

register(
  dataModule(`
    const urls = ${JSON.stringify(moduleUrls)};
    export async function resolve(specifier, context, nextResolve) {
      if (urls[specifier]) return { url: urls[specifier], shortCircuit: true };
      return nextResolve(specifier, context);
    }
  `),
  import.meta.url,
);

const { POST } = await import('../../app/api/stripe/webhook/route.ts?s4b-webhook-test');

let logs: unknown[][] = [];
let errors: unknown[][] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;

function request(rawBody: string, signature = 's4b-signature') {
  return new Request('https://disburse.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: rawBody,
  });
}

function containsSentinel(value: unknown, sentinel: string, seen = new WeakSet<object>(), depth = 0): boolean {
  if (depth > 12 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.includes(sentinel);
  if (typeof value !== 'object') return String(value).includes(sentinel);
  if (seen.has(value)) return false;
  seen.add(value);

  if (value instanceof Error && value.message.includes(sentinel)) return true;

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && key.includes(sentinel)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor && containsSentinel(descriptor.value, sentinel, seen, depth + 1)) {
      return true;
    }
  }

  return false;
}

function assertOutputExcludes(...sentinels: string[]) {
  for (const sentinel of sentinels) {
    assert.equal(logs.some((call) => call.some((argument) => containsSentinel(argument, sentinel))), false);
    assert.equal(errors.some((call) => call.some((argument) => containsSentinel(argument, sentinel))), false);
  }
}

test.beforeEach(() => {
  logs = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args);
  console.error = (...args: unknown[]) => errors.push(args);
  stubs.constructEvent = () => ({ type: 'unknown', data: { object: {} } });
  stubs.handleSubscriptionChange = async () => {};
});

test.afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

test.after(() => {
  if (originalWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
  delete (globalThis as typeof globalThis & { __s4bStripeWebhookStubs?: StubState }).__s4bStripeWebhookStubs;
});

test('handled subscription events forward raw verification inputs and dispatch once', async () => {
  for (const eventType of ['customer.subscription.updated', 'customer.subscription.deleted']) {
    const rawBody = `raw-${eventType}`;
    const signature = `signature-${eventType}`;
    const subscription = { id: `${eventType}-subscription` };
    const verificationCalls: unknown[][] = [];
    const subscriptionCalls: unknown[] = [];
    stubs.constructEvent = (...args) => {
      verificationCalls.push(args);
      return { type: eventType, data: { object: subscription } };
    };
    stubs.handleSubscriptionChange = async (receivedSubscription) => {
      subscriptionCalls.push(receivedSubscription);
    };

    const response = await POST(request(rawBody, signature) as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });
    assert.deepEqual(verificationCalls, [[rawBody, signature, webhookSecret]]);
    assert.deepEqual(subscriptionCalls, [subscription]);
    assert.deepEqual(logs, []);
  }
});

test('unknown event types never enter logs or responses', async () => {
  const maliciousType = 'unknown\nsecret=payload-value';
  stubs.constructEvent = () => ({ type: maliciousType, data: { object: { id: 'ignored' } } });
  let handlerCalls = 0;
  stubs.handleSubscriptionChange = async () => { handlerCalls += 1; };

  const response = await POST(request('unknown-body') as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.deepEqual(logs, [['Unhandled event type.']]);
  assert.equal(handlerCalls, 0);
  assertOutputExcludes('unknown', 'secret=payload-value');
});

test('malformed payload failures return the static signature boundary', async () => {
  const rawBody = 'malformed-body-secret';
  const signature = 'malformed-signature-secret';
  const exception = 'malformed-exception-secret';
  const verificationCalls: unknown[][] = [];
  stubs.constructEvent = (...args) => {
    verificationCalls.push(args);
    throw new Error(exception);
  };

  const response = await POST(request(rawBody, signature) as never);
  const responseText = await response.text();

  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(responseText), { error: 'Webhook signature verification failed.' });
  assert.deepEqual(verificationCalls, [[rawBody, signature, webhookSecret]]);
  assert.deepEqual(errors, [['Webhook signature verification failed.']]);
  assert.equal(logs.length, 0);
  assertOutputExcludes(rawBody, signature, exception);
  for (const sentinel of [rawBody, signature, exception]) assert.doesNotMatch(responseText, new RegExp(sentinel));
});

test('invalid signatures are never exposed by the signature boundary', async () => {
  const rawBody = 'invalid-signature-body-secret';
  const signature = 'invalid-signature-header-secret';
  const exception = 'invalid-signature-exception-secret';
  const verificationCalls: unknown[][] = [];
  stubs.constructEvent = (...args) => {
    verificationCalls.push(args);
    throw new Error(exception);
  };

  const response = await POST(request(rawBody, signature) as never);
  const responseText = await response.text();

  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(responseText), { error: 'Webhook signature verification failed.' });
  assert.deepEqual(verificationCalls, [[rawBody, signature, webhookSecret]]);
  assert.deepEqual(errors, [['Webhook signature verification failed.']]);
  assert.equal(logs.length, 0);
  assertOutputExcludes(rawBody, signature, exception);
  for (const sentinel of [rawBody, signature, exception]) assert.doesNotMatch(responseText, new RegExp(sentinel));
});

test('subscription handler failures reject from the direct route call', async () => {
  const failure = new Error('subscription-handler-sentinel');
  stubs.constructEvent = () => ({
    type: 'customer.subscription.updated',
    data: { object: { id: 'subscription' } },
  });
  stubs.handleSubscriptionChange = async () => { throw failure; };

  await assert.rejects(POST(request('handler-failure-body') as never), (error) => error === failure);
  assert.deepEqual(logs, []);
  assert.deepEqual(errors, []);
  assertOutputExcludes('subscription-handler-sentinel', 'handler-failure-body');
});
