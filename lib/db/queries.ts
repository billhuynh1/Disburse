import { desc, and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './drizzle';
import {
  activityLogs,
  clipCandidates,
  clipPublications,
  ClipPublicationStatus,
  ContentPackKind,
  contentPacks,
  FacecamDetectionStatus,
  notifications,
  projects,
  reusableAssets,
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

export type NotificationListItem = {
  id: number;
  type: string;
  outcome: string;
  title: string;
  message: string;
  actionUrl: string | null;
  read: boolean;
  createdAt: string;
};

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

export async function listProjectHubSummaries() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  return await db.query.projects.findMany({
    where: eq(projects.userId, user.id),
    with: {
      sourceAssets: {
        with: {
          transcript: true
        }
      },
      contentPacks: {
        with: {
          clipCandidates: true,
          renderedClips: true
        }
      }
    },
    orderBy: (projects, { desc }) => [desc(projects.updatedAt)]
  });
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
              renderedClips: true,
              facecamDetections: true,
              editConfig: true
            }
          },
          renderedClips: true,
          generatedAssets: true
        }
      }
    }
  });
}

export async function listClipPublicationsForRenderedClips(renderedClipIds: number[]) {
  const user = await getUser();
  if (!user || renderedClipIds.length === 0) {
    return [];
  }

  try {
    return await db.query.clipPublications.findMany({
      where: and(
        eq(clipPublications.userId, user.id),
        inArray(clipPublications.renderedClipId, renderedClipIds)
      ),
      with: {
        linkedAccount: true
      }
    });
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : null;

    if (code === '42P01' || code === '42703') {
      console.warn(
        'Clip publication metadata is unavailable because the database is missing the latest publishing migration.'
      );
      return [];
    }

    throw error;
  }
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
          renderedClips: true,
          facecamDetections: true,
          editConfig: true
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

export async function listReusableAssets() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  return await db.query.reusableAssets.findMany({
    where: eq(reusableAssets.userId, user.id),
    orderBy: (table, { desc }) => [desc(table.updatedAt), desc(table.createdAt)],
  });
}

export async function listNotifications(limit = 20): Promise<NotificationListItem[]> {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  const items = await db.query.notifications.findMany({
    where: eq(notifications.userId, user.id),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    limit,
  });

  return items.map((item) => ({
    id: item.id,
    type: item.type,
    outcome: item.status,
    title: item.title,
    message: item.message,
    actionUrl: item.actionUrl,
    read: Boolean(item.readAt),
    createdAt: item.createdAt.toISOString(),
  }));
}

export async function getUnreadNotificationCount() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));

  return Number(result?.count || 0);
}

export async function markNotificationRead(notificationId: number) {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  const now = new Date();
  const [notification] = await db
    .update(notifications)
    .set({
      readAt: now,
      updatedAt: now,
    })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, user.id)))
    .returning({ id: notifications.id });

  return notification || null;
}

export async function markAllNotificationsRead() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  const now = new Date();
  await db
    .update(notifications)
    .set({
      readAt: now,
      updatedAt: now,
    })
    .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));
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

export async function listClipPublicationStatuses() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  let items;

  try {
    items = await db.query.clipPublications.findMany({
      where: eq(clipPublications.userId, user.id),
      with: {
        renderedClip: {
          with: {
            clipCandidate: true,
          },
        },
        linkedAccount: true,
      },
      orderBy: (table, { desc }) => [desc(table.updatedAt)],
    });
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : null;

    if (code === '42P01' || code === '42703') {
      console.warn(
        'Clip publication statuses are unavailable because the database is missing the latest publishing migration.'
      );
      return [];
    }

    throw error;
  }

  return items.map((publication) => ({
    clipPublicationId: publication.id,
    renderedClipId: publication.renderedClipId,
    platform: publication.platform,
    clipTitle:
      publication.renderedClip.title || publication.renderedClip.clipCandidate.title,
    clipPublicationStatus:
      publication.status || ClipPublicationStatus.PENDING,
    failureReason: publication.failureReason,
    platformUrl: publication.platformUrl,
    updatedAt: publication.updatedAt.toISOString(),
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

export async function listFacecamDetectionStatuses() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  const items = await db.query.clipCandidates.findMany({
    where: eq(clipCandidates.userId, user.id),
    with: {
      sourceAsset: true,
    },
    orderBy: (clipCandidates, { desc }) => [desc(clipCandidates.updatedAt)]
  });

  return items.map((clipCandidate) => ({
    clipCandidateId: clipCandidate.id,
    sourceAssetId: clipCandidate.sourceAssetId,
    sourceAssetTitle: clipCandidate.sourceAsset.title,
    clipTitle: clipCandidate.title,
    facecamDetectionStatus:
      clipCandidate.facecamDetectionStatus ||
      FacecamDetectionStatus.NOT_STARTED,
    failureReason: clipCandidate.facecamDetectionFailureReason,
    updatedAt: clipCandidate.updatedAt.toISOString()
  }));
}
