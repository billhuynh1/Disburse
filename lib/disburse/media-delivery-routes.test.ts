import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceAssetType, type SourceAsset, type RenderedClip } from '../db/schema.ts';
import { createSourceMediaRoute, createRenderedClipDownloadRoute } from './media-delivery-route-handlers.ts';

function fixture() {
  let user: { id: number } | null = { id: 7 };
  const source = { id: 11, userId: 7, assetType: SourceAssetType.UPLOADED_FILE, storageKey: 'source.mp4', mimeType: 'video/mp4' } as SourceAsset;
  const clip = { id: 12, userId: 7, storageKey: 'clip.mp4', mimeType: 'video/mp4', title: ' A "Clutch" / WIN! ', status: 'ready' } as RenderedClip;
  let expired = false;
  let authorityError: Error | undefined;
  let storageResponse = new Response('video', { headers: { 'content-length': '5' } });
  let unreachable = false;
  const storageCalls: { headers?: Record<string, string> }[] = [];
  const signingCalls: { storageKey: string; expiresInSeconds: number }[] = [];
  const deps = {
    getUser: async () => user,
    findSourceAsset: async (id: number, userId: number) => id === source.id && userId === source.userId ? source : undefined,
    findRenderedClip: async (id: number, userId: number) => id === clip.id && userId === clip.userId ? clip : undefined,
    isMediaUnavailable: () => expired,
    createPresignedDownload: (input: { storageKey: string; expiresInSeconds: number }) => {
      signingCalls.push(input);
      return { downloadUrl: `https://storage.example/${input.storageKey}?signed=1`, method: 'GET' };
    },
    fetchPresignedAsset: async (input: { headers?: Record<string, string> }) => {
      storageCalls.push(input);
      return unreachable ? { ok: false as const, errorResponse: Response.json({ error: 'Storage unreachable' }, { status: 502 }) } : { ok: true as const, response: storageResponse };
    },
    assertRenderedClipPublicationAuthority: async (input: { renderedClipId: number; userId: number }) => {
      assert.deepEqual(input, { renderedClipId: clip.id, userId: 7 });
      if (authorityError) throw authorityError;
    },
  };
  return { source, clip, storageCalls, signingCalls, sourceGET: createSourceMediaRoute(deps), clipGET: createRenderedClipDownloadRoute(deps),
    setUser: (value: typeof user) => { user = value; }, setExpired: () => { expired = true; },
    supersede: () => { authorityError = new Error('Rendered clip is no longer current.'); },
    setStorage: (response: Response) => { storageResponse = response; }, setUnreachable: () => { unreachable = true; },
  };
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (suffix = '') => new Request(`https://app.example/media${suffix}`);

test('media routes reject authentication, invalid IDs and cross-user access before storage', async () => {
  for (const kind of ['source', 'clip'] as const) {
    const f = fixture(); const GET = kind === 'source' ? f.sourceGET : f.clipGET; const id = kind === 'source' ? '11' : '12';
    f.setUser(null); assert.equal((await GET(request(), context(id))).status, 401);
    f.setUser({ id: 7 });
    for (const invalid of ['0', '-1', '1.5', 'nope']) assert.equal((await GET(request(), context(invalid))).status, 400);
    f.setUser({ id: 8 }); assert.equal((await GET(request(), context(id))).status, 404);
    assert.equal(f.signingCalls.length, 0); assert.equal(f.storageCalls.length, 0);
  }
});

test('media routes reject expired, missing, unsupported and unfinished media', async () => {
  const f = fixture(); f.setExpired();
  assert.equal((await f.sourceGET(request(), context('11'))).status, 410);
  assert.equal((await f.clipGET(request(), context('12'))).status, 410);
  const missing = fixture(); missing.source.storageKey = null; missing.clip.storageKey = null;
  assert.equal((await missing.sourceGET(request(), context('11'))).status, 404);
  assert.equal((await missing.clipGET(request(), context('12'))).status, 404);
  const unavailable = fixture(); unavailable.source.assetType = SourceAssetType.YOUTUBE_URL; unavailable.clip.status = 'processing';
  assert.equal((await unavailable.sourceGET(request(), context('11'))).status, 404);
  assert.equal((await unavailable.clipGET(request(), context('12'))).status, 409);
  const old = fixture(); old.supersede();
  assert.equal((await old.clipGET(request(), context('12'))).status, 409);
  assert.equal(old.signingCalls.length, 0);
});

test('source media forwards byte range and streams 206 body with media headers', async () => {
  const f = fixture(); f.setStorage(new Response('abc', { status: 206, headers: { 'content-length': '3', 'content-range': 'bytes 0-2/5', 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' } }));
  const response = await f.sourceGET(new Request('https://app.example/media', { headers: { range: 'bytes=0-2' } }), context('11'));
  assert.equal(response.status, 206); assert.equal(await response.text(), 'abc');
  assert.deepEqual(f.storageCalls[0].headers, { Range: 'bytes=0-2' });
  assert.equal(response.headers.get('content-range'), 'bytes 0-2/5');
  assert.equal(response.headers.get('content-length'), '3'); assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes'); assert.equal(response.headers.get('cache-control'), 'private, max-age=300');
  assert.deepEqual(f.signingCalls, [{ storageKey: 'source.mp4', expiresInSeconds: 300 }]);
});

test('current rendered clip redirects playback and proxies a safe attachment filename', async () => {
  const f = fixture(); const playback = await f.clipGET(request(), context('12'));
  assert.equal(playback.status, 307); assert.equal(playback.headers.get('location'), 'https://storage.example/clip.mp4?signed=1');
  assert.equal(f.storageCalls.length, 0);
  const attachment = await f.clipGET(request('?download=1'), context('12'));
  assert.equal(attachment.status, 200); assert.equal(await attachment.text(), 'video');
  assert.equal(attachment.headers.get('content-disposition'), 'attachment; filename="a-clutch-win-hd.mp4"');
  assert.equal(attachment.headers.get('content-length'), '5');
  assert.equal(f.signingCalls[0].expiresInSeconds, 3600);
  const fallback = fixture(); fallback.clip.title = '!!!';
  assert.equal((await fallback.clipGET(request('?download=1'), context('12'))).headers.get('content-disposition'), 'attachment; filename="rendered-clip-hd.mp4"');
});

test('source and rendered download preserve storage HTTP failures and unreachable responses', async () => {
  for (const kind of ['source', 'clip'] as const) {
    for (const status of [403, 404, 500]) {
      const f = fixture(); f.setStorage(new Response('provider detail', { status }));
      const response = await (kind === 'source' ? f.sourceGET : f.clipGET)(request('?download=1'), context(kind === 'source' ? '11' : '12'));
      assert.equal(response.status, status); assert.doesNotMatch(await response.text(), /provider detail/);
    }
    const f = fixture(); f.setUnreachable();
    assert.equal((await (kind === 'source' ? f.sourceGET : f.clipGET)(request('?download=1'), context(kind === 'source' ? '11' : '12'))).status, 502);
  }
});
