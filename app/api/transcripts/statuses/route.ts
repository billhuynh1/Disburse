import {
  getUser,
  listClipPublicationStatuses,
  listFacecamDetectionStatuses,
  listShortFormPackStatuses,
  listRenderedClipStatuses,
  listUploadedTranscriptStatuses
} from '@/lib/db/queries';

export async function GET() {
  try {
    const user = await getUser();

    if (!user) {
      return Response.json({ error: 'User not authenticated' }, { status: 401 });
    }

    const [
      transcriptItems,
      renderedClipItems,
      shortFormPackItems,
      facecamDetectionItems,
      clipPublicationItems
    ] = await Promise.all([
      listUploadedTranscriptStatuses(),
      listRenderedClipStatuses(),
      listShortFormPackStatuses(),
      listFacecamDetectionStatuses(),
      listClipPublicationStatuses()
    ]);

    return Response.json({
      transcriptItems,
      renderedClipItems,
      shortFormPackItems,
      facecamDetectionItems,
      clipPublicationItems
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load transcript statuses.';
    const status = message === 'User not authenticated' ? 401 : 500;

    return Response.json({ error: message }, { status });
  }
}
