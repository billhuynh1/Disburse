import assert from 'node:assert/strict';
import test from 'node:test';
import { emitPipelineFailureDiagnostic, redactPipelineDiagnostic } from './pipeline-failure-diagnostics';
import { JobType } from '../db/schema';
import { classifyPipelineFailure, getUserSafePipelineFailureReason, logPipelineError } from './pipeline-errors';
import { ExternalEffectNotStartedError, AmbiguousExternalEffectError } from './job-effect-checkpoint-service';

const context = {
  invocationId: '12345678-1234-4234-8234-123456789abc',
  jobId: 226, sourceAssetId: 28, jobType: 'format_rendered_clip_short_form',
};

test('diagnostics preserve wrapped subprocess failures and safe correlation only', () => {
  const cause = Object.assign(new Error('No such filter: subtitles'), {
    code: 1, signal: 'SIGTERM', killed: true,
    stderr: 'ffmpeg stderr: No such filter: subtitles',
  });
  const error = new Error('External effect did not start', { cause: new Error('ffmpeg failed', { cause }) });
  const output: string[] = [];
  emitPipelineFailureDiagnostic(error, { ...context, payload: { secret: 'not-for-logs' }, signedUrl: 'https://private.invalid' }, value => output.push(value));
  const event = JSON.parse(output[0]!);
  assert.equal(event.event, 'pipeline.failure_diagnostic');
  assert.equal(event.jobId, 226);
  assert.equal(event.invocationId, context.invocationId);
  assert.equal(event.causes.length, 3);
  assert.equal(event.causes[2].message, 'No such filter: subtitles');
  assert.equal(event.causes[2].code, 1);
  assert.equal(event.causes[2].signal, 'SIGTERM');
  assert.equal(event.causes[2].killed, true);
  assert.match(event.causes[2].stderr, /No such filter/);
  assert.match(event.causes[2].stack, /Error: No such filter/);
  assert.doesNotMatch(output[0]!, /not-for-logs|private.invalid|signedUrl|payload/);
});

test('redaction removes configured secrets, URLs and embedded credentials before truncation', () => {
  const previous = process.env.MEDIA_API_SECRET;
  process.env.MEDIA_API_SECRET = 'configured-diagnostic-secret';
  try {
    const dangerous = 'configured-diagnostic-secret https://host.invalid/file?X-Amz-Signature=signed-value postgres://user:pass@db.invalid/name Bearer bearer-value Basic basic-value password="quoted password" token=bare-value X-Amz-Credential=aws-value api_key=api-value';
    const output: string[] = [];
    const error = Object.assign(new Error(dangerous), { stderr: `${'x'.repeat(5000)} ${dangerous}` });
    emitPipelineFailureDiagnostic(error, context, value => output.push(value));
    assert.doesNotMatch(output[0]!, /configured-diagnostic-secret|host.invalid|db.invalid|signed-value|bearer-value|basic-value|quoted password|bare-value|aws-value|api-value/);
    assert.match(output[0]!, /REDACTED/);
    const event = JSON.parse(output[0]!);
    assert.ok(event.causes[0].stderr.length <= 4096);
    assert.match(event.causes[0].stderr, /REDACTED/);
    assert.doesNotMatch(redactPipelineDiagnostic('{"headers":{"token":"nested-secret"}} outer=token=assigned-secret', {}), /nested-secret|assigned-secret/);
    assert.equal(redactPipelineDiagnostic('code=1 filter=subtitles', {}), 'code=1 filter=subtitles');
  } finally {
    if (previous === undefined) delete process.env.MEDIA_API_SECRET;
    else process.env.MEDIA_API_SECRET = previous;
  }
});

test('cause chains and diagnostic fields are bounded, including circular causes', () => {
  const error = Object.assign(new Error('x'.repeat(5000)), { stack: 'y'.repeat(5000), stderr: 'z'.repeat(6000) });
  error.cause = error;
  let output = '';
  emitPipelineFailureDiagnostic(error, context, value => { output = value; });
  const event = JSON.parse(output);
  assert.equal(event.causes.length, 1);
  assert.equal(event.causes[0].message.length, 1024);
  assert.equal(event.causes[0].stack.length, 2048);
  assert.equal(event.causes[0].stderr.length, 4096);
  let chain: Error = error;
  for (let i = 0; i < 10; i++) chain = new Error('wrapper', { cause: chain });
  emitPipelineFailureDiagnostic(chain, context, value => { output = value; });
  assert.equal(JSON.parse(output).causes.length, 4);
});

test('non-Errors, hostile properties and failed log sinks cannot interrupt processing', () => {
  let output = '';
  emitPipelineFailureDiagnostic('token=private-token', context, value => { output = value; });
  assert.equal(JSON.parse(output).causes[0].name, 'NonError');
  assert.doesNotMatch(output, /private-token/);
  const hostile = Object.defineProperty(new Error('original failure'), 'cause', { get() { throw new Error('getter failure'); } });
  assert.doesNotThrow(() => emitPipelineFailureDiagnostic(hostile, context, value => { output = value; }));
  assert.match(output, /original failure/);
  assert.doesNotThrow(() => emitPipelineFailureDiagnostic(hostile, context, () => { throw new Error('sink failed'); }));
  assert.equal(redactPipelineDiagnostic('secret=value', {}), 'secret=[REDACTED]');
});

test('production pipeline logger emits diagnostics without changing normalization or classification', async () => {
  const cause = Object.assign(new Error('subprocess failed token=private-token'), { code: 1, stderr: 'No such filter: subtitles' });
  const error = new Error('ffmpeg vertical render failed: subprocess failed', { cause });
  const safeReason = getUserSafePipelineFailureReason(JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, error);
  const classification = classifyPipelineFailure(error);
  const output: string[] = [];
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = value => output.push(String(value));
  console.info = value => output.push(String(value));
  try {
    await logPipelineError(JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, error, { jobId: 226 });
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }
  assert.equal(JSON.parse(output[0]!).event, 'pipeline.failure_diagnostic');
  assert.match(output[0]!, /No such filter/);
  assert.doesNotMatch(output[0]!, /private-token/);
  assert.equal(JSON.parse(output[1]!).event, 'pipeline.invocation_failed');
  assert.equal(getUserSafePipelineFailureReason(JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, error), safeReason);
  assert.deepEqual(classifyPipelineFailure(error), classification);
  assert.deepEqual(classifyPipelineFailure(new ExternalEffectNotStartedError(error)), {
    code: 'external_effect_not_started', failureClass: 'safe_no_external_effect',
  });
  assert.deepEqual(classifyPipelineFailure(new AmbiguousExternalEffectError(error)), {
    code: 'external_effect_ambiguous', failureClass: 'ambiguous_external_effect',
  });
});
