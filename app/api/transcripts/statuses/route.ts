import {
  listShortFormPackStatuses,
  listRenderedClipStatuses,
  listUploadedTranscriptStatuses
} from '@/lib/db/queries';

export async function GET() {
  try {
    const [transcriptItems, renderedClipItems, shortFormPackItems] = await Promise.all([
      listUploadedTranscriptStatuses(),
      listRenderedClipStatuses(),
      listShortFormPackStatuses()
    ]);
    return Response.json({ transcriptItems, renderedClipItems, shortFormPackItems });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load transcript statuses.';
    const status = message === 'User not authenticated' ? 401 : 500;

    return Response.json({ error: message }, { status });
  }
}
