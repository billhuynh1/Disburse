import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const MEDIA_FIXTURE_DURATION_MS = 15_000;

/** Small colored regions make crop/layout assertions possible without pixel snapshots. */
export async function createSyntheticMedia(options: { audio?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'disburse-fixture-'));
  const filename = join(directory, 'source.mp4');
  try {
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=2:d=15',
      ...(options.audio === false ? [] : ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=15']),
      '-vf', 'drawbox=x=0:y=0:w=80:h=60:color=red:t=fill,drawbox=x=80:y=0:w=160:h=180:color=green:t=fill',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', filename,
    ], { timeout: 30_000 });
    return await readFile(filename);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function createLoopbackMediaStorage() {
  const objects = new Map<string, Buffer>();
  const requests: Array<{ method: string; key: string }> = [];
  const server = createServer(async (request, response) => {
    const key = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname.replace(/^\/fixtures\//, ''));
    const method = request.method!;
    requests.push({ method, key });
    if (method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      response.writeHead(200, { ETag: '"fixture-etag"' }).end();
      return;
    }
    const body = objects.get(key);
    if (!body) { response.writeHead(404).end(); return; }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    response.writeHead(range ? 206 : 200, {
      'Content-Length': end - start + 1,
      'Content-Type': key.endsWith('.ttf') ? 'font/ttf' : 'video/mp4',
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}),
    });
    response.end(method === 'HEAD' ? undefined : body.subarray(start, end + 1));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback storage port.');
  const endpoint = `http://127.0.0.1:${address.port}`;
  return {
    objects, requests, endpoint,
    environment: {
      S3_UPLOAD_ACCESS_KEY_ID: 'fixture-access', S3_UPLOAD_SECRET_ACCESS_KEY: 'fixture-secret',
      S3_UPLOAD_BUCKET: 'fixtures', S3_UPLOAD_REGION: 'auto', S3_UPLOAD_ENDPOINT: endpoint,
      S3_UPLOAD_PATH_STYLE: 'true',
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
