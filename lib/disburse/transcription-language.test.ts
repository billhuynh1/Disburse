import assert from 'node:assert/strict';
import test from 'node:test';

import { withExternalEffectBoundary } from './job-effect-checkpoint-service.ts';
import { transcribeWithOpenAI } from './openai-transcription.ts';
import {
  normalizeTranscriptionLanguage,
  resolveProviderTranscriptionLanguage,
} from './transcription-language.ts';

const auditedLanguages = [
  ['arabic', 'ar'],
  ['chinese', 'zh'],
  ['dutch', 'nl'],
  ['english', 'en'],
  ['french', 'fr'],
  ['german', 'de'],
  ['hindi', 'hi'],
  ['indonesian', 'id'],
  ['italian', 'it'],
  ['japanese', 'ja'],
  ['korean', 'ko'],
  ['polish', 'pl'],
  ['portuguese', 'pt'],
  ['russian', 'ru'],
  ['spanish', 'es'],
  ['swedish', 'sv'],
  ['turkish', 'tr'],
  ['ukrainian', 'uk'],
  ['vietnamese', 'vi'],
] as const;

test('normalizes only audited request-language names and canonical codes', () => {
  for (const [name, code] of auditedLanguages) {
    assert.equal(normalizeTranscriptionLanguage(name), code);
    assert.equal(normalizeTranscriptionLanguage(name.toUpperCase()), code);
    assert.equal(normalizeTranscriptionLanguage(code), code);
    assert.equal(normalizeTranscriptionLanguage(code.toUpperCase()), code);
  }

  assert.equal(normalizeTranscriptionLanguage(' English '), 'en');
});

test('rejects unsupported request-language values', () => {
  for (const language of [
    undefined,
    null,
    '',
    '   ',
    'Klingon',
    'zz',
    'en-US',
    'e',
    'eng',
    '日本語',
  ]) {
    assert.equal(normalizeTranscriptionLanguage(language), null);
  }
});

test('preserves nonblank provider language metadata and otherwise uses a valid request fallback', () => {
  assert.equal(resolveProviderTranscriptionLanguage('Finnish', 'English'), 'Finnish');
  assert.equal(resolveProviderTranscriptionLanguage(' English ', undefined), 'English');
  assert.equal(resolveProviderTranscriptionLanguage('  Finnish  ', 'en'), 'Finnish');
  assert.equal(resolveProviderTranscriptionLanguage('', 'English'), 'en');
  assert.equal(resolveProviderTranscriptionLanguage('   ', 'English'), 'en');
  assert.equal(resolveProviderTranscriptionLanguage(undefined, 'English'), 'en');
  assert.equal(resolveProviderTranscriptionLanguage(null, 'English'), 'en');
  assert.equal(resolveProviderTranscriptionLanguage(undefined, 'zz'), null);
});

test('uses strict request language normalization without changing the OpenAI safety boundary', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const events: string[] = [];
  const request = {
    signal: null as AbortSignal | null,
    fields: {} as Record<string, string[]>,
  };
  process.env.OPENAI_API_KEY = 'test-key';
  const providerLanguages = ['Finnish', undefined, 'Finnish', undefined, undefined, '', 'English'];
  globalThis.fetch = (async (_input, init) => {
    events.push('send');
    assert.equal(init?.method, 'POST');
    assert.ok(init?.signal instanceof AbortSignal);
    request.signal = init?.signal || null;
    const formData = init?.body;
    assert.ok(formData instanceof FormData);
    request.fields = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === 'string') {
        (request.fields[key] ||= []).push(value);
      }
    }

    return new Response(JSON.stringify({
      text: 'A complete transcript.',
      language: providerLanguages.shift(),
      segments: [{ start: 0, end: 1, text: 'A complete transcript.' }],
      words: [{ start: 0, end: 1, word: 'A' }],
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const controller = new AbortController();
    const transcribe = async (language: string | undefined, wordTimestamps = false) =>
      await withExternalEffectBoundary(async () => {
        events.push('boundary');
      }, async () => await transcribeWithOpenAI({
        file: new Blob(['audio']),
        filename: 'audio.mp3',
        language,
        wordTimestamps,
        signal: controller.signal,
      }));

    const transcription = await transcribe('English', true);

    assert.deepEqual(events, ['boundary', 'send']);
    assert.ok(request.signal);
    assert.equal(request.signal.aborted, false);
    assert.deepEqual(request.fields, {
      model: ['whisper-1'],
      response_format: ['verbose_json'],
      'timestamp_granularities[]': ['segment', 'word'],
      language: ['en'],
    });
    assert.equal(transcription.language, 'Finnish');

    assert.equal((await transcribe('EN')).language, 'en');
    assert.deepEqual(request.fields.language, ['en']);

    assert.equal((await transcribe('English')).language, 'Finnish');
    assert.deepEqual(request.fields.language, ['en']);

    assert.equal((await transcribe('zz')).language, null);
    assert.equal(request.fields.language, undefined);

    assert.equal((await transcribe('en-US')).language, null);
    assert.equal(request.fields.language, undefined);

    assert.equal((await transcribe('   ')).language, null);
    assert.equal(request.fields.language, undefined);

    assert.equal((await transcribe('English')).language, 'English');
    assert.deepEqual(request.fields.language, ['en']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});
