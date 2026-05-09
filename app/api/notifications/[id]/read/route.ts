import { markNotificationRead } from '@/lib/db/queries';

function parseNotificationId(value: string) {
  const notificationId = Number(value);

  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    return null;
  }

  return notificationId;
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const notificationId = parseNotificationId(id);

    if (!notificationId) {
      return Response.json({ error: 'Invalid notification id.' }, { status: 400 });
    }

    const notification = await markNotificationRead(notificationId);

    if (!notification) {
      return Response.json({ error: 'Notification not found.' }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update notification.';
    const status = message === 'User not authenticated' ? 401 : 500;

    return Response.json({ error: message }, { status });
  }
}
