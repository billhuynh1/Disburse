import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRankedClipCandidatesContent } from './openai-short-form-parser.ts';

const VALID_CANDIDATE_OBJECT =
  '{"candidates":[{"windowId":"window-1","hook":"Strong opener","title":"Clip title","captionCopy":"Caption copy","summary":"Summary text","whyItWorks":"Reasonable payoff","platformFit":"Shorts and Reels","confidence":82}]}';

test('parses plain JSON short-form candidate responses', () => {
  const candidates = parseRankedClipCandidatesContent(VALID_CANDIDATE_OBJECT);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.windowId, 'window-1');
});

test('parses escaped JSON objects returned by the model', () => {
  const escapedObject = VALID_CANDIDATE_OBJECT.replace(/"/g, '\\"');
  const candidates = parseRankedClipCandidatesContent(escapedObject);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.title, 'Clip title');
});

test('parses fenced JSON candidate payloads', () => {
  const content = `\`\`\`json\n${VALID_CANDIDATE_OBJECT}\n\`\`\``;
  const candidates = parseRankedClipCandidatesContent(content);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.confidence, 82);
});
