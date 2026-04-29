import { unstable_rethrow } from 'next/navigation';
import { getUser, listProjectHubSummaries } from '@/lib/db/queries';
import {
  getUserStorageLimitBytes,
  getUserStorageUsageBytes
} from '@/lib/disburse/media-retention-service';
import { HomePage } from '../home-ui';

async function loadProjects() {
  try {
    return await listProjectHubSummaries();
  } catch (error) {
    unstable_rethrow(error);
    console.error('Unable to load video workspaces.', error);
    return [];
  }
}

export default async function ProjectsPage() {
  const [projects, user] = await Promise.all([loadProjects(), getUser()]);
  const storage = user
    ? await Promise.all([
        getUserStorageUsageBytes(user.id),
        getUserStorageLimitBytes(user.id)
      ]).then(([usedBytes, limitBytes]) => ({
        usedBytes,
        limitBytes
      }))
    : {
        usedBytes: 0,
        limitBytes: 0
      };

  return <HomePage projects={projects} storage={storage} />;
}
