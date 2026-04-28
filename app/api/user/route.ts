import { getUser } from '@/lib/db/queries';

export async function GET() {
  try {
    const user = await getUser();
    return Response.json(user);
  } catch (error) {
    console.error('Unable to load current user.', error);
    return Response.json(null, { status: 503 });
  }
}
