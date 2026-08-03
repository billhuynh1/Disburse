import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import process from 'node:process';

const path = process.argv[2] ? resolve(process.argv[2]) : null;
if (!path) throw new Error('Usage: npm run ops:validate-smoke-fixture -- /path/to/non-sensitive.mp4');
const supported = new Set(['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm']);
const metadata = await stat(path);
if (!metadata.isFile()) throw new Error('Smoke fixture must be a regular file.');
if (!supported.has(extname(path).toLowerCase())) throw new Error('Smoke fixture format is unsupported.');
if (metadata.size <= 0 || metadata.size > 10 * 1024 * 1024) {
  throw new Error('Smoke fixture must be non-empty and no larger than 10 MiB.');
}
process.stdout.write(`Fixture is staging-safe: ${metadata.size} bytes. No upload was performed.\n`);
