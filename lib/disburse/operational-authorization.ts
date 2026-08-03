import { timingSafeEqual } from 'node:crypto';

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function authorizeOperationalSnapshot(
  authorization: string | null,
  configuredSecret = process.env.OPERATIONAL_SNAPSHOT_SECRET
) {
  const secret = configuredSecret?.trim();
  if (!secret || !authorization?.startsWith('Bearer ')) return false;
  return safeEqual(authorization.slice('Bearer '.length), secret);
}
