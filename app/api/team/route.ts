import { getTeamForUser } from '@/lib/db/queries';

export async function GET() {
  try {
    const team = await getTeamForUser();
    return Response.json(team);
  } catch (error) {
    console.error('Unable to load current team.', error);
    return Response.json(null, { status: 503 });
  }
}
