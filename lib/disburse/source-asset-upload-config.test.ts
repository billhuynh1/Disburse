import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_MULTIPART_PART_SIZE_BYTES,
  MAX_MULTIPART_PARTS,
  MIN_MULTIPART_PART_SIZE_BYTES,
  computeMultipartPlan,
} from './source-asset-upload-config.ts';

test('uses the minimum multipart part size for small files', () => {
  assert.deepEqual(computeMultipartPlan(1), {
    partSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES,
    totalParts: 1,
  });
});

test('uses the minimum multipart part size for a file exactly 5 MiB', () => {
  assert.deepEqual(computeMultipartPlan(MIN_MULTIPART_PART_SIZE_BYTES), {
    partSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES,
    totalParts: 1,
  });
});

test('keeps the minimum multipart part size for a file just over 5 MiB', () => {
  assert.deepEqual(computeMultipartPlan(MIN_MULTIPART_PART_SIZE_BYTES + 1), {
    partSizeBytes: MIN_MULTIPART_PART_SIZE_BYTES,
    totalParts: 2,
  });
});

test('sizes large uploads to stay at or below 10,000 parts', () => {
  const fileSizeBytes = MIN_MULTIPART_PART_SIZE_BYTES * MAX_MULTIPART_PARTS + 1;
  const plan = computeMultipartPlan(fileSizeBytes);

  assert.equal(plan.totalParts, MAX_MULTIPART_PARTS);
  assert.equal(plan.partSizeBytes, Math.ceil(fileSizeBytes / MAX_MULTIPART_PARTS));
});

test('keeps non-final parts within multipart size bounds and allows a smaller final part', () => {
  const fileSizeBytes = MIN_MULTIPART_PART_SIZE_BYTES * 3 + 123;
  const plan = computeMultipartPlan(fileSizeBytes);

  assert.equal(plan.partSizeBytes, MIN_MULTIPART_PART_SIZE_BYTES);
  assert.equal(plan.totalParts, 4);

  for (let partNumber = 1; partNumber <= plan.totalParts; partNumber += 1) {
    const byteStart = (partNumber - 1) * plan.partSizeBytes;
    const byteEnd = Math.min(byteStart + plan.partSizeBytes, fileSizeBytes);
    const sizeBytes = byteEnd - byteStart;
    const isFinalPart = partNumber === plan.totalParts;

    if (isFinalPart) {
      assert.ok(sizeBytes > 0);
      assert.ok(sizeBytes < MIN_MULTIPART_PART_SIZE_BYTES);
      continue;
    }

    assert.ok(sizeBytes >= MIN_MULTIPART_PART_SIZE_BYTES);
    assert.ok(sizeBytes <= MAX_MULTIPART_PART_SIZE_BYTES);
  }
});

test('rejects uploads that require parts larger than 5 GiB', () => {
  assert.throws(
    () =>
      computeMultipartPlan(
        MAX_MULTIPART_PART_SIZE_BYTES * MAX_MULTIPART_PARTS + 1
      ),
    /too large/
  );
});
