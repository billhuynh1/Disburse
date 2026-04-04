import { listUploadedTranscriptStatuses } from '@/lib/db/queries';

export async function GET() {
  try {
    const items = await listUploadedTranscriptStatuses();
    return Response.json({ items });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load transcript statuses.';
    const status = message === 'User not authenticated' ? 401 : 500;

    return Response.json({ error: message }, { status });
  }
}
