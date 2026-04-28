import { unstable_rethrow } from 'next/navigation';
import { listProjectHubSummaries } from '@/lib/db/queries';
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
  const projects = await loadProjects();

  return <HomePage projects={projects} />;
}
