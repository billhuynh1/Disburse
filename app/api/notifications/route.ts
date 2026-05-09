import {
  getUnreadNotificationCount,
  listNotifications,
} from '@/lib/db/queries';

export async function GET() {
  try {
    const [items, unreadCount] = await Promise.all([
      listNotifications(),
      getUnreadNotificationCount(),
    ]);

    return Response.json({
      items,
      unreadCount,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load notifications.';
    const status = message === 'User not authenticated' ? 401 : 500;

    return Response.json({ error: message }, { status });
  }
}
