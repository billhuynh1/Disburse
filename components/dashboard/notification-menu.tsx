'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import {
  Bell,
  CheckCircle2,
  CircleAlert,
  CircleX,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { NOTIFICATIONS_REFRESH_EVENT } from '@/lib/disburse/notification-copy';

type NotificationListItem = {
  id: number;
  type: string;
  outcome: string;
  title: string;
  message: string;
  actionUrl: string | null;
  read: boolean;
  createdAt: string;
};

type NotificationsResponse = {
  items: NotificationListItem[];
  unreadCount: number;
};

const fetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Failed to load notifications.');
  }

  return (await response.json()) as NotificationsResponse;
};

function emitNotificationsRefresh() {
  window.dispatchEvent(new Event(NOTIFICATIONS_REFRESH_EVENT));
}

function formatRelativeTime(value: string) {
  const date = new Date(value);
  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / (60 * 1000));
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, 'minute');
  }

  const diffHours = Math.round(diffMinutes / 60);

  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, 'hour');
  }

  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, 'day');
}

function getOutcomeIcon(outcome: string) {
  if (outcome === 'success') {
    return CheckCircle2;
  }

  if (outcome === 'warning') {
    return CircleAlert;
  }

  return CircleX;
}

function isExternalUrl(value: string) {
  return /^https?:\/\//.test(value);
}

export function NotificationMenu() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [pendingNotificationId, setPendingNotificationId] = useState<number | null>(
    null
  );
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<NotificationsResponse>(
    '/api/notifications',
    fetcher,
    {
      refreshInterval: 4000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    }
  );

  useEffect(() => {
    const handleRefresh = () => {
      void mutate();
    };

    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, handleRefresh);
    return () => {
      window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, handleRefresh);
    };
  }, [mutate]);

  const items = data?.items || [];
  const unreadCount = data?.unreadCount || 0;

  async function handleMarkAllRead() {
    if (isMarkingAllRead || unreadCount === 0) {
      return;
    }

    setIsMarkingAllRead(true);

    try {
      const response = await fetch('/api/notifications/read-all', {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to update notifications.');
      }

      await mutate(
        (current) =>
          current
            ? {
                unreadCount: 0,
                items: current.items.map((item) => ({ ...item, read: true })),
              }
            : current,
        { revalidate: false }
      );
      emitNotificationsRefresh();
    } catch (error) {
      console.error('Unable to mark notifications as read.', error);
    } finally {
      setIsMarkingAllRead(false);
    }
  }

  async function handleSelectNotification(item: NotificationListItem) {
    if (pendingNotificationId === item.id) {
      return;
    }

    setPendingNotificationId(item.id);

    try {
      if (!item.read) {
        const response = await fetch(`/api/notifications/${item.id}/read`, {
          method: 'POST',
        });

        if (!response.ok) {
          throw new Error('Failed to update notification.');
        }

        await mutate(
          (current) =>
            current
              ? {
                  unreadCount: Math.max(
                    0,
                    current.unreadCount - (item.read ? 0 : 1)
                  ),
                  items: current.items.map((currentItem) =>
                    currentItem.id === item.id
                      ? { ...currentItem, read: true }
                      : currentItem
                  ),
                }
              : current,
          { revalidate: false }
        );
        emitNotificationsRefresh();
      }

      setIsOpen(false);

      if (item.actionUrl) {
        if (isExternalUrl(item.actionUrl)) {
          window.location.assign(item.actionUrl);
          return;
        }

        router.push(item.actionUrl);
        router.refresh();
      }
    } catch (error) {
      console.error('Unable to open notification.', error);
    } finally {
      setPendingNotificationId(null);
    }
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'relative',
            isOpen && 'bg-accent text-foreground'
          )}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 ? (
            <span className="absolute right-1.5 top-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between px-3 py-2.5">
          <DropdownMenuLabel className="px-0 py-0">Notifications</DropdownMenuLabel>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            disabled={unreadCount === 0 || isMarkingAllRead}
            onClick={handleMarkAllRead}
          >
            {isMarkingAllRead ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Mark all read
          </Button>
        </div>
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-96 overflow-y-auto p-1.5">
          {isLoading ? (
            <div className="flex items-center justify-center px-3 py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading notifications
            </div>
          ) : error ? (
            <div className="px-3 py-10 text-sm text-muted-foreground">
              Notifications are unavailable right now.
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-10 text-sm text-muted-foreground">
              No notifications yet.
            </div>
          ) : (
            items.map((item) => {
              const Icon = getOutcomeIcon(item.outcome);

              return (
                <DropdownMenuItem
                  key={item.id}
                  className="items-start gap-3 rounded-lg p-3"
                  onSelect={(event) => {
                    event.preventDefault();
                    void handleSelectNotification(item);
                  }}
                >
                  <span
                    className={cn(
                      'mt-0.5 rounded-full',
                      item.outcome === 'success'
                        ? 'text-success'
                        : item.outcome === 'warning'
                          ? 'text-warning'
                          : 'text-danger'
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <p
                        className={cn(
                          'text-sm leading-5 text-foreground',
                          item.read ? 'font-medium' : 'font-semibold'
                        )}
                      >
                        {item.title}
                      </p>
                      {!item.read ? (
                        <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {item.message}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground/80">
                      {formatRelativeTime(item.createdAt)}
                    </p>
                  </div>
                  {pendingNotificationId === item.id ? (
                    <Loader2 className="mt-1 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : null}
                </DropdownMenuItem>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
