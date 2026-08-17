export type ProjectRenderedClipIdentity = {
  id: number;
  clipRenderConfigId: number | null;
  generationRunId: string;
  variant: string;
  layout: string;
  editConfigHash: string | null;
  status: string;
};

type LegacyEditConfig = {
  aspectRatio: string;
  layout: string;
  configHash: string;
};

export type ProjectClipProjectionInput<
  TCandidate extends { currentRenderConfigId: number | null; generationRunId: string },
  TEditConfig extends LegacyEditConfig,
  TRenderConfig extends { id: number; renderedClips: TRenderedClip[] },
  TRenderedClip extends ProjectRenderedClipIdentity
> = {
  candidate: TCandidate;
  editConfig: TEditConfig | null;
  generationMode: 'legacy' | 'snapshot';
  currentRenderConfig: TRenderConfig | null;
  legacyRenderedClips: TRenderedClip[];
};

export type ProjectClipProjection<TCandidate, TEditConfig, TRenderConfig, TRenderedClip> = {
  candidate: TCandidate;
  editConfig: TEditConfig | null;
  effectiveRenderConfig: TRenderConfig | null;
  renderedClip: TRenderedClip | null;
};

export type ProjectClipPresentationState =
  | 'preparing'
  | 'rendering'
  | 'ready'
  | 'failed'
  | 'legacy';

export function getProjectClipPresentationState({
  generationMode,
  currentRenderConfigId,
  effectiveRenderConfig,
  renderedClip
}: {
  generationMode: 'legacy' | 'snapshot';
  currentRenderConfigId: number | null;
  effectiveRenderConfig: { id: number } | null;
  renderedClip: { status: string } | null;
}): ProjectClipPresentationState {
  if (generationMode === 'legacy') {
    return 'legacy';
  }

  if (currentRenderConfigId === null || effectiveRenderConfig === null) {
    return 'preparing';
  }

  if (renderedClip?.status === 'failed') {
    return 'failed';
  }

  if (!renderedClip || renderedClip.status === 'pending' || renderedClip.status === 'rendering') {
    return 'rendering';
  }

  return 'ready';
}

export function projectRenderedClip<
  TCandidate extends { currentRenderConfigId: number | null; generationRunId: string },
  TEditConfig extends LegacyEditConfig,
  TRenderConfig extends { id: number; renderedClips: TRenderedClip[] },
  TRenderedClip extends ProjectRenderedClipIdentity
>(input: ProjectClipProjectionInput<TCandidate, TEditConfig, TRenderConfig, TRenderedClip>): ProjectClipProjection<TCandidate, TEditConfig, TRenderConfig, TRenderedClip> {
  if (input.generationMode === 'snapshot') {
    const effectiveRenderConfig = input.currentRenderConfig && input.currentRenderConfig.id === input.candidate.currentRenderConfigId
      ? input.currentRenderConfig
      : null;

    return {
      candidate: input.candidate,
      editConfig: input.editConfig,
      effectiveRenderConfig,
      renderedClip: effectiveRenderConfig?.renderedClips.find(
        (clip) => clip.clipRenderConfigId === effectiveRenderConfig.id
      ) || null
    };
  }

  const aspectRatio = input.editConfig?.aspectRatio || '9_16';
  const layout = input.editConfig?.layout || 'preserve_aspect';
  const configHash = input.editConfig?.configHash || null;
  const variant = aspectRatio === '1_1'
    ? 'square_short_form'
    : aspectRatio === '16_9'
      ? 'landscape_short_form'
      : 'vertical_short_form';
  const matchesSelectedConfig = (clip: TRenderedClip) =>
    clip.generationRunId === input.candidate.generationRunId &&
    clip.layout === layout &&
    (!configHash || clip.editConfigHash === configHash);
  const preferredRenderedClip = input.legacyRenderedClips.find(
    (clip) => matchesSelectedConfig(clip) && clip.variant === variant
  );
  const compatibleConfigBackedRenderedClip = input.legacyRenderedClips.find(
    (clip) =>
      clip.generationRunId === input.candidate.generationRunId &&
      clip.variant === variant &&
      clip.layout === layout &&
      clip.clipRenderConfigId !== null &&
      clip.status === 'ready'
  );
  const renderedClip =
    (preferredRenderedClip?.status === 'ready' ? preferredRenderedClip : null) ||
    compatibleConfigBackedRenderedClip ||
    input.legacyRenderedClips.find(
      (clip) =>
        matchesSelectedConfig(clip) &&
        clip.variant !== 'trimmed_original' &&
        clip.status === 'ready'
    ) ||
    input.legacyRenderedClips.find(
      (clip) =>
        clip.generationRunId === input.candidate.generationRunId &&
        clip.variant === 'trimmed_original' &&
        clip.status === 'ready'
    ) ||
    null;

  return {
    candidate: input.candidate,
    editConfig: input.editConfig,
    effectiveRenderConfig: null,
    renderedClip
  };
}
