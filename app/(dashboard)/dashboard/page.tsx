import { unstable_rethrow } from 'next/navigation';
import { listProjectHubSummaries } from '@/lib/db/queries';
import { HomePage } from './home-ui';

async function loadProjects() {
  try {
    return await listProjectHubSummaries();
  } catch (error) {
    unstable_rethrow(error);
    console.error('Unable to load project hub.', error);
    return [];
  }
}

export default async function DashboardPage() {
  const projects = await loadProjects();

  return <HomePage projects={projects} />;
}
