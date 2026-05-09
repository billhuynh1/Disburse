import {
  getUser,
  listClipPublicationStatuses,
  listFacecamDetectionStatuses,
  listShortFormPackStatuses,
  listRenderedClipStatuses,
  listUploadedTranscriptStatuses
} from '@/lib/db/queries';
import { triggerInternalJobProcessing } from '@/lib/disburse/internal-job-trigger';
import {
  recoverStalledFacecamDetectionJobsForUser,
  recoverStalledTranscriptionJobsForUser
} from '@/lib/disburse/job-service';

const ACTIVE_TRANSCRIPT_STATUSES = new Set(['pending', 'processing']);
const ACTIVE_RENDERED_CLIP_STATUSES = new Set(['pending', 'rendering']);
const ACTIVE_SHORT_FORM_PACK_STATUSES = new Set(['pending', 'generating']);
const ACTIVE_FACECAM_DETECTION_STATUSES = new Set(['pending', 'detecting']);
const ACTIVE_CLIP_PUBLICATION_STATUSES = new Set(['pending', 'publishing']);

export async function GET() {
  try {
    const user = await getUser();

    if (!user) {
      return Response.json({ error: 'User not authenticated' }, { status: 401 });
    }

    await Promise.all([
      recoverStalledTranscriptionJobsForUser(user.id),
      recoverStalledFacecamDetectionJobsForUser(user.id)
    ]);

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
      ) ||
      clipPublicationItems.some((item) =>
        ACTIVE_CLIP_PUBLICATION_STATUSES.has(item.clipPublicationStatus)
      )
    ) {
      triggerInternalJobProcessing();
    }

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
