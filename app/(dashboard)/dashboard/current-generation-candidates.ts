import { ContentPackKind } from "@/lib/db/schema";

type ClipCandidateForCurrentGeneration = {
  generationRunId?: string | null;
  reviewStatus: string;
};

type ContentPackForCurrentGeneration = {
  kind: string;
  sourceAssetId?: number;
  generationRunId?: string | null;
  clipCandidates: ClipCandidateForCurrentGeneration[];
};

export function getCurrentGenerationCandidatesForSelectedPack(
  contentPacks: ContentPackForCurrentGeneration[],
  sourceAssetId: number | null
) {
  const selectedPack =
    contentPacks.find(
      (pack) =>
        pack.kind === ContentPackKind.SHORT_FORM_CLIPS &&
        (sourceAssetId === null || pack.sourceAssetId === sourceAssetId)
    ) ||
    contentPacks.find(
      (pack) => pack.kind === ContentPackKind.SHORT_FORM_CLIPS
    );

  if (!selectedPack?.generationRunId) {
    return [];
  }

  return selectedPack.clipCandidates.filter(
    (candidate) => candidate.generationRunId === selectedPack.generationRunId
  );
}
