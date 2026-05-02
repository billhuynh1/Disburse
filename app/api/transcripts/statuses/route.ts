import {
  getUser,
  listFacecamDetectionStatuses,
  listShortFormPackStatuses,
  listRenderedClipStatuses,
  listUploadedTranscriptStatuses
} from '@/lib/db/queries';
import { triggerInternalJobProcessing } from '@/lib/disburse/internal-job-trigger';
import { recoverStalledTranscriptionJobsForUser } from '@/lib/disburse/job-service';

const ACTIVE_TRANSCRIPT_STATUSES = new Set(['pending', 'processing']);
const ACTIVE_RENDERED_CLIP_STATUSES = new Set(['pending', 'rendering']);
const ACTIVE_SHORT_FORM_PACK_STATUSES = new Set(['pending', 'generating']);
const ACTIVE_FACECAM_DETECTION_STATUSES = new Set(['pending', 'detecting']);

export async function GET() {
  try {
    const user = await getUser();

    if (!user) {
      return Response.json({ error: 'User not authenticated' }, { status: 401 });
    }

    await recoverStalledTranscriptionJobsForUser(user.id);

    const [
      transcriptItems,
      renderedClipItems,
      shortFormPackItems,
      facecamDetectionItems
    ] = await Promise.all([
      listUploadedTranscriptStatuses(),
      listRenderedClipStatuses(),
      listShortFormPackStatuses(),
      listFacecamDetectionStatuses()
    ]);

    if (
      transcriptItems.some((item) =>
        ACTIVE_TRANSCRIPT_STATUSES.has(item.transcriptStatus)
      ) ||
      renderedClipItems.some((item) =>
        ACTIVE_RENDERED_CLIP_STATUSES.has(item.renderedClipStatus)
      ) ||
      shortFormPackItems.some((item) =>
        ACTIVE_SHORT_FORM_PACK_STATUSES.has(item.contentPackStatus)
      ) ||
      facecamDetectionItems.some((item) =>
        ACTIVE_FACECAM_DETECTION_STATUSES.has(item.facecamDetectionStatus)
      )
    ) {
      triggerInternalJobProcessing();
    }

    return Response.json({
      transcriptItems,
      renderedClipItems,
      shortFormPackItems,
      facecamDetectionItems
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load transcript statuses.';
    const status = message === 'User not authenticated' ? 401 : 500;

    return Response.json({ error: message }, { status });
  }
}
