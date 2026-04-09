import { desc, and, eq, isNull } from 'drizzle-orm';
import { db } from './drizzle';
import {
  activityLogs,
  ContentPackKind,
  contentPacks,
  projects,
  renderedClips,
  RenderedClipStatus,
  sourceAssets,
  SourceAssetType,
  TranscriptStatus,
  teamMembers,
  teams,
  users
} from './schema';
import { voiceProfiles } from './schema';
import { cookies } from 'next/headers';
import { verifyToken } from '@/lib/auth/session';

export async function getUser() {
  const sessionCookie = (await cookies()).get('session');
  if (!sessionCookie || !sessionCookie.value) {
    return null;
  }

  const sessionData = await verifyToken(sessionCookie.value);
  if (
    !sessionData ||
    !sessionData.user ||
    typeof sessionData.user.id !== 'number'
  ) {
    return null;
  }

  if (new Date(sessionData.expires) < new Date()) {
    return null;
  }

  const user = await db
    .select()
    .from(users)
    .where(and(eq(users.id, sessionData.user.id), isNull(users.deletedAt)))
    .limit(1);

  if (user.length === 0) {
    return null;
  }

  return user[0];
}

export async function getTeamByStripeCustomerId(customerId: string) {
  const result = await db
    .select()
    .from(teams)
    .where(eq(teams.stripeCustomerId, customerId))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

export async function updateTeamSubscription(
  teamId: number,
  subscriptionData: {
    stripeSubscriptionId: string | null;
    stripeProductId: string | null;
    planName: string | null;
    subscriptionStatus: string;
  }
) {
  await db
    .update(teams)
    .set({
      ...subscriptionData,
      updatedAt: new Date()
    })
    .where(eq(teams.id, teamId));
}

export async function getUserWithTeam(userId: number) {
  const result = await db
    .select({
      user: users,
      teamId: teamMembers.teamId
    })
    .from(users)
    .leftJoin(teamMembers, eq(users.id, teamMembers.userId))
    .where(eq(users.id, userId))
    .limit(1);

  return result[0];
}

export async function getActivityLogs() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  return await db
    .select({
      id: activityLogs.id,
      action: activityLogs.action,
      timestamp: activityLogs.timestamp,
      ipAddress: activityLogs.ipAddress,
      userName: users.name
    })
    .from(activityLogs)
    .leftJoin(users, eq(activityLogs.userId, users.id))
    .where(eq(activityLogs.userId, user.id))
    .orderBy(desc(activityLogs.timestamp))
    .limit(10);
}

export async function getTeamForUser() {
  const user = await getUser();
  if (!user) {
    return null;
  }

  const result = await db.query.teamMembers.findFirst({
    where: eq(teamMembers.userId, user.id),
    with: {
      team: {
        with: {
          teamMembers: {
            with: {
              user: {
                columns: {
                  id: true,
                  name: true,
                  email: true
                }
              }
            }
          }
        }
      }
    }
  });

  return result?.team || null;
}

export async function listProjects() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  return await db
    .select()
    .from(projects)
    .where(eq(projects.userId, user.id))
    .orderBy(desc(projects.updatedAt));
}

export async function getProjectById(projectId: number) {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  return await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.userId, user.id)),
    with: {
      sourceAssets: {
        with: {
          transcript: {
            with: {
              segments: true
            }
          }
        }
      },
      contentPacks: {
        with: {
          sourceAsset: true,
          transcript: true,
          clipCandidates: {
            with: {
              renderedClips: true
            }
          },
          renderedClips: true,
          generatedAssets: true
        }
      }
    }
  });
}

export async function listContentPacks() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  return await db.query.contentPacks.findMany({
    where: eq(contentPacks.userId, user.id),
    with: {
      project: true,
      sourceAsset: true,
      transcript: true,
      clipCandidates: {
        with: {
          renderedClips: true
        }
      },
      renderedClips: true,
      generatedAssets: true
    },
    orderBy: (contentPacks, { desc }) => [desc(contentPacks.updatedAt)]
  });
}

export async function listVoiceProfiles() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  return await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, user.id))
    .orderBy(desc(voiceProfiles.updatedAt));
}

export async function getVoiceProfileById(voiceProfileId: number) {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  return await db.query.voiceProfiles.findFirst({
    where: and(
      eq(voiceProfiles.id, voiceProfileId),
      eq(voiceProfiles.userId, user.id)
    )
  });
}

export async function listUploadedTranscriptStatuses() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  const uploadedSourceAssets = await db.query.sourceAssets.findMany({
    where: and(
      eq(sourceAssets.userId, user.id),
      eq(sourceAssets.assetType, SourceAssetType.UPLOADED_FILE)
    ),
    with: {
      transcript: true,
    },
    orderBy: (sourceAssets, { desc }) => [desc(sourceAssets.updatedAt)],
  });

  return uploadedSourceAssets.map((sourceAsset) => ({
    sourceAssetId: sourceAsset.id,
    sourceAssetTitle: sourceAsset.title,
    sourceAssetStatus: sourceAsset.status,
    transcriptId: sourceAsset.transcript?.id ?? null,
    transcriptStatus:
      sourceAsset.transcript?.status || TranscriptStatus.PENDING,
    failureReason:
      sourceAsset.transcript?.failureReason || sourceAsset.failureReason,
    updatedAt: (
      sourceAsset.transcript?.updatedAt || sourceAsset.updatedAt
    ).toISOString(),
  }));
}

export async function listRenderedClipStatuses() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  const items = await db.query.renderedClips.findMany({
    where: eq(renderedClips.userId, user.id),
    with: {
      sourceAsset: true,
      clipCandidate: true
    },
    orderBy: (renderedClips, { desc }) => [desc(renderedClips.updatedAt)]
  });

  return items.map((renderedClip) => ({
    renderedClipId: renderedClip.id,
    clipCandidateId: renderedClip.clipCandidateId,
    sourceAssetId: renderedClip.sourceAssetId,
    sourceAssetTitle: renderedClip.sourceAsset.title,
    clipTitle: renderedClip.title || renderedClip.clipCandidate.title,
    variant: renderedClip.variant,
    renderedClipStatus: renderedClip.status || RenderedClipStatus.PENDING,
    failureReason: renderedClip.failureReason,
    updatedAt: renderedClip.updatedAt.toISOString()
  }));
}

export async function listShortFormPackStatuses() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  const items = await db.query.contentPacks.findMany({
    where: and(
      eq(contentPacks.userId, user.id),
      eq(contentPacks.kind, ContentPackKind.SHORT_FORM_CLIPS)
    ),
    with: {
      sourceAsset: true,
    },
    orderBy: (contentPacks, { desc }) => [desc(contentPacks.updatedAt)]
  });

  return items.map((contentPack) => ({
    contentPackId: contentPack.id,
    sourceAssetId: contentPack.sourceAssetId,
    sourceAssetTitle: contentPack.sourceAsset.title,
    contentPackName: contentPack.name,
    contentPackStatus: contentPack.status,
    failureReason: contentPack.failureReason,
    updatedAt: contentPack.updatedAt.toISOString()
  }));
}
