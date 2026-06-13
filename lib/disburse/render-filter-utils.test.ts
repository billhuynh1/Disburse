import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceCropFilter } from './render-filter-utils.ts';

test('source crop filter preserves original input by default', () => {
  assert.equal(buildSourceCropFilter(), null);
  assert.equal(buildSourceCropFilter({ sourceCrop: 'original' }), null);
});

test('source crop filter creates centered square crop', () => {
  assert.equal(
    buildSourceCropFilter({ sourceCrop: '1_1' }),
    'crop=min(iw\\,ih):min(iw\\,ih):(iw-ow)/2:(ih-oh)/2'
  );
});

test('source crop filter creates centered 4:3 crop', () => {
  assert.equal(
    buildSourceCropFilter({ sourceCrop: '4_3' }),
    [
      'crop=',
      'if(gte(iw/ih\\,4/3)\\,ih*4/3\\,iw):',
      'if(gte(iw/ih\\,4/3)\\,ih\\,iw*3/4):',
      '(iw-ow)/2:',
      '(ih-oh)/2',
    ].join('')
  );
});
