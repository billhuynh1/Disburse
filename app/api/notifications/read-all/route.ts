import { markAllNotificationsRead } from '@/lib/db/queries';

export async function POST() {
  try {
    await markAllNotificationsRead();
    return Response.json({ success: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update notifications.';
    const status = message === 'User not authenticated' ? 401 : 500;

    return Response.json({ error: message }, { status });
  }
}
