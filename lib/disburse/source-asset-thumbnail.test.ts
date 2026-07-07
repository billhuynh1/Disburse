import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceAssetType } from '../db/schema.ts';
import {
  canExtractSourceAssetThumbnail,
  getSourceAssetAspectRatio,
  getSourceAssetMediaUrl,
  getStaticSourceAssetThumbnail,
  parseYouTubeVideoId,
} from './source-asset-thumbnail.ts';

test('uses a persisted thumbnail when one exists', () => {
  const thumbnail = getStaticSourceAssetThumbnail({
    id: 1,
    title: 'Uploaded source',
    assetType: SourceAssetType.UPLOADED_FILE,
    storageUrl: 'https://storage.test/video.mp4',
    thumbnailUrl: '/api/source-assets/1/thumbnail',
    thumbnailWidth: 640,
    thumbnailHeight: 360,
  });

  assert.deepEqual(thumbnail, {
    kind: 'image',
    src: '/api/source-assets/1/thumbnail',
    width: 640,
    height: 360,
    alt: 'Uploaded source',
  });
});

test('uses a YouTube preview when no persisted thumbnail exists', () => {
  const thumbnail = getStaticSourceAssetThumbnail({
    id: 2,
    title: 'YouTube source',
    assetType: SourceAssetType.YOUTUBE_URL,
    storageUrl: 'https://www.youtube.com/watch?v=abc123',
  });

  assert.deepEqual(thumbnail, {
    kind: 'image',
    src: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
    width: 480,
    height: 360,
    alt: 'YouTube source',
  });
});

test('uploaded videos without persisted thumbnails stay extractable on the client', () => {
  const asset = {
    id: 3,
    title: 'Upload',
    assetType: SourceAssetType.UPLOADED_FILE,
    storageUrl: 'https://storage.test/video.mp4',
    mimeType: 'video/mp4',
  };

  assert.equal(getStaticSourceAssetThumbnail(asset), null);
  assert.equal(canExtractSourceAssetThumbnail(asset), true);
  assert.equal(getSourceAssetMediaUrl(asset), '/api/source-assets/3/media');
});

test('non-video uploads do not attempt client-side extraction', () => {
  const asset = {
    id: 4,
    title: 'Audio upload',
    assetType: SourceAssetType.UPLOADED_FILE,
    storageUrl: 'https://storage.test/audio.mp3',
    mimeType: 'audio/mpeg',
  };

  assert.equal(canExtractSourceAssetThumbnail(asset), false);
});

test('aspect ratio prefers resolved thumbnail dimensions and keeps transcript fallback', () => {
  assert.equal(
    getSourceAssetAspectRatio(
      {
        id: 5,
        title: 'Video',
        assetType: SourceAssetType.UPLOADED_FILE,
        storageUrl: 'https://storage.test/video.mp4',
      },
      { width: 1280, height: 720 }
    ),
    '1280 / 720'
  );
  assert.equal(
    getSourceAssetAspectRatio({
      id: 6,
      title: 'Transcript',
      assetType: SourceAssetType.PASTED_TRANSCRIPT,
      storageUrl: 'placeholder://transcript',
    }),
    '4 / 3'
  );
});

test('parses YouTube ids from supported URL formats', () => {
  assert.equal(
    parseYouTubeVideoId('https://www.youtube.com/watch?v=video123'),
    'video123'
  );
  assert.equal(parseYouTubeVideoId('https://youtu.be/video123'), 'video123');
  assert.equal(parseYouTubeVideoId('https://example.com/video123'), null);
});
