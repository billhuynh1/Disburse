import { getUser } from '@/lib/db/queries';
import { RenderedClipLayout } from '@/lib/db/schema';
import {
  applyBrandTemplateSchema,
  applyBrandTemplateToClip,
} from '@/lib/disburse/brand-template-service';
import { triggerInternalJobProcessing } from '@/lib/disburse/internal-job-trigger';
import { enqueueFormatRenderedClipShortFormJob } from '@/lib/disburse/job-service';
import { ensureRenderedClipPending } from '@/lib/disburse/rendered-clip-service';
import { getRenderedClipVariantForEditConfig } from '@/lib/disburse/clip-edit-config-service';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const templateId = Number(id);

  if (!Number.isInteger(templateId) || templateId <= 0) {
    return Response.json({ error: 'Invalid brand template id.' }, { status: 400 });
  }

  const parsed = applyBrandTemplateSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json({ error: 'Invalid clip candidate.' }, { status: 400 });
  }

  try {
    const { template, editConfig, renderConfigs } = await applyBrandTemplateToClip({
      templateId,
      clipCandidateId: parsed.data.clipCandidateId,
      userId: user.id,
    });

    for (const renderConfig of renderConfigs) {
      const variant = getRenderedClipVariantForEditConfig(renderConfig);

      await ensureRenderedClipPending({
        clipCandidateId: renderConfig.clipCandidateId,
        userId: user.id,
        variant,
        layout: renderConfig.layout as RenderedClipLayout,
        renderConfig,
      });
      await enqueueFormatRenderedClipShortFormJob(
        renderConfig.clipCandidateId,
        renderConfig.contentPackId,
        renderConfig.sourceAssetId,
        user.id,
        renderConfig.generationRunId,
        variant,
        renderConfig.layout as RenderedClipLayout,
        renderConfig.captionsEnabled,
        renderConfig.captionFontAssetId ?? undefined,
        renderConfig.configHash,
        renderConfig.id
      );
    }
    triggerInternalJobProcessing();

    return Response.json({
      success: true,
      templateId: template.id,
      clipCandidateId: editConfig.clipCandidateId,
      editConfig,
      renderConfigs,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to apply brand template.',
      },
      { status: 400 }
    );
  }
}
