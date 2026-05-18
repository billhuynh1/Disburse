export type ProjectJobRelationParams = {
  jobs: Array<{ id: number; status: string; payload: unknown }>;
  projectId: number;
  sourceAssetIds: number[];
  contentPackIds: number[];
  clipCandidateIds: number[];
};

export function getRelatedProjectJobIds(params: ProjectJobRelationParams) {
  return params.jobs
    .filter((job) => {
      const payload = job.payload;

      if (!payload || typeof payload !== 'object') {
        return false;
      }

      return (
        ('projectId' in payload &&
          typeof payload.projectId === 'number' &&
          payload.projectId === params.projectId) ||
        ('sourceAssetId' in payload &&
          typeof payload.sourceAssetId === 'number' &&
          params.sourceAssetIds.includes(payload.sourceAssetId)) ||
        ('contentPackId' in payload &&
          typeof payload.contentPackId === 'number' &&
          params.contentPackIds.includes(payload.contentPackId)) ||
        ('clipCandidateId' in payload &&
          typeof payload.clipCandidateId === 'number' &&
          params.clipCandidateIds.includes(payload.clipCandidateId))
      );
    })
    .map((job) => ({ id: job.id, status: job.status }));
}
