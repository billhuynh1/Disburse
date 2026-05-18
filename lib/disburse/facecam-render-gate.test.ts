import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCanRenderAfterFacecamDetection,
  canRenderAfterFacecamDetection,
  requiresFacecamDetectionBeforeRender,
} from './facecam-render-gate.ts';
import {
  ContentPackKind,
  FacecamDetectionStatus,
  SourceAssetType,
} from '../db/schema.ts';

test('requires terminal facecam detection before rendering uploaded short-form videos', () => {
  const sourceAsset = {
    assetType: SourceAssetType.UPLOADED_FILE,
    mimeType: 'video/mp4',
  };

  assert.equal(
    requiresFacecamDetectionBeforeRender({
      contentPackKind: ContentPackKind.SHORT_FORM_CLIPS,
      sourceAsset,
    }),
    true
  );

  for (const status of [
    FacecamDetectionStatus.NOT_STARTED,
    FacecamDetectionStatus.PENDING,
    FacecamDetectionStatus.DETECTING,
  ]) {
    assert.throws(() =>
      assertCanRenderAfterFacecamDetection({
        contentPackKind: ContentPackKind.SHORT_FORM_CLIPS,
        sourceAsset,
        facecamDetectionStatus: status,
      })
    );
  }
});

test('allows uploaded short-form video rendering after facecam terminal states', () => {
  for (const status of [
    FacecamDetectionStatus.READY,
    FacecamDetectionStatus.NOT_FOUND,
    FacecamDetectionStatus.FAILED_TIMEOUT,
    FacecamDetectionStatus.FAILED_ABORTED,
    FacecamDetectionStatus.FAILED_NETWORK,
    FacecamDetectionStatus.FAILED_HTTP,
    FacecamDetectionStatus.FAILED_INVALID_RESPONSE,
    FacecamDetectionStatus.FAILED,
  ]) {
    assert.equal(canRenderAfterFacecamDetection(status), true);
    assert.doesNotThrow(() =>
      assertCanRenderAfterFacecamDetection({
        contentPackKind: ContentPackKind.SHORT_FORM_CLIPS,
        sourceAsset: {
          assetType: SourceAssetType.UPLOADED_FILE,
          mimeType: 'video/mp4',
        },
        facecamDetectionStatus: status,
      })
    );
  }
});

test('does not gate non-uploaded-video render paths', () => {
  assert.doesNotThrow(() =>
    assertCanRenderAfterFacecamDetection({
      contentPackKind: ContentPackKind.SHORT_FORM_CLIPS,
      sourceAsset: {
        assetType: SourceAssetType.YOUTUBE_URL,
        mimeType: null,
      },
      facecamDetectionStatus: FacecamDetectionStatus.NOT_STARTED,
    })
  );

  assert.doesNotThrow(() =>
    assertCanRenderAfterFacecamDetection({
      contentPackKind: ContentPackKind.GENERAL,
      sourceAsset: {
        assetType: SourceAssetType.UPLOADED_FILE,
        mimeType: 'video/mp4',
      },
      facecamDetectionStatus: FacecamDetectionStatus.PENDING,
    })
  );
});
