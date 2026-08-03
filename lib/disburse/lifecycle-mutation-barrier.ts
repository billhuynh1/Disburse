import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { projects, sourceAssets } from '@/lib/db/schema';

export type LifecycleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class LifecycleMutationBlockedError extends Error {
  constructor() {
    super('This project or source asset is being deleted.');
    this.name = 'LifecycleMutationBlockedError';
  }
}

export async function lockProjectForLifecycleMutation(
  tx: LifecycleTransaction,
  projectId: number,
  userId: number
) {
  const [project] = await tx
    .select({
      id: projects.id,
      deletionRequestedAt: projects.deletionRequestedAt,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .for('update')
    .limit(1);

  if (!project) throw new Error('Project not found.');
  if (project.deletionRequestedAt) throw new LifecycleMutationBlockedError();
  return project;
}

export async function lockProjectAndSourceForLifecycleMutation(
  tx: LifecycleTransaction,
  params: { projectId: number; sourceAssetId: number; userId: number }
) {
  const project = await lockProjectForLifecycleMutation(
    tx,
    params.projectId,
    params.userId
  );
  const [sourceAsset] = await tx
    .select({
      id: sourceAssets.id,
      projectId: sourceAssets.projectId,
      title: sourceAssets.title,
      deletionRequestedAt: sourceAssets.deletionRequestedAt,
    })
    .from(sourceAssets)
    .where(and(
      eq(sourceAssets.id, params.sourceAssetId),
      eq(sourceAssets.projectId, params.projectId),
      eq(sourceAssets.userId, params.userId)
    ))
    .for('update')
    .limit(1);

  if (!sourceAsset) throw new Error('Source asset not found.');
  if (sourceAsset.deletionRequestedAt) throw new LifecycleMutationBlockedError();
  return { project, sourceAsset };
}
