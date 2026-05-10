'use client';

import * as React from 'react';
import useSWR from 'swr';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Filter, Plus, Youtube, Link2 } from 'lucide-react';

function TikTokIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 2.23-1.15 4.34-2.85 5.83-1.7 1.49-3.95 2.22-6.2 2.05-2.25-.17-4.36-1.26-5.83-2.99-1.47-1.73-2.12-4.04-1.84-6.3.28-2.26 1.44-4.33 3.2-5.74 1.76-1.41 4.06-1.95 6.27-1.48v4.11c-.96-.4-2.06-.39-3.01.03-.95.42-1.72 1.22-2.08 2.2-.36.98-.25 2.1.29 2.99.54.89 1.45 1.48 2.47 1.63 1.02.15 2.08-.12 2.89-.75.81-.63 1.3-1.58 1.34-2.61.02-4.72.01-9.44.01-14.16Z" />
    </svg>
  );
}

const SUPPORTED_ACCOUNTS = [
  { id: 'youtube', name: 'YouTube', icon: Youtube, color: 'text-[#FF0000]', enabled: true },
  { id: 'tiktok', name: 'TikTok', icon: TikTokIcon, color: 'text-foreground', enabled: true },
];

export function SocialAccountsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [filter, setFilter] = React.useState<string | null>(null);
  const [addAccountOpen, setAddAccountOpen] = React.useState(false);
  const router = useRouter();

  const { data, error, isLoading, mutate } = useSWR('/api/linked-accounts', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch accounts');
    return res.json();
  });

  const linkedAccounts = data?.accounts || [];

  const filteredAccounts = filter
    ? linkedAccounts.filter((acc: any) => acc.platform === filter)
    : linkedAccounts;

  const handleConnect = (platformId: string) => {
    // Redirect to the OAuth initiation route
    router.push(`/api/auth/${platformId}/connect`);
  };

  const handleDisconnect = async (accountId: number) => {
    try {
      const res = await fetch(`/api/linked-accounts?id=${accountId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        mutate();
      } else {
        console.error('Failed to disconnect account');
      }
    } catch (err) {
      console.error('Error disconnecting account', err);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md p-6">
          <DialogHeader className="mb-4">
            <DialogTitle className="text-xl">Social Accounts</DialogTitle>
          </DialogHeader>

          <div className="mb-2 flex justify-start">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8">
                  <Filter className="mr-2 h-4 w-4" />
                  {filter ? SUPPORTED_ACCOUNTS.find(a => a.id === filter)?.name : 'All Accounts'}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => setFilter(null)}>
                  All Accounts
                </DropdownMenuItem>
                {SUPPORTED_ACCOUNTS.filter((a) => a.enabled).map((acc) => (
                  <DropdownMenuItem
                    key={acc.id}
                    onClick={() => setFilter(acc.id)}
                    className="font-semibold"
                  >
                    <acc.icon className={cn("mr-2 h-4 w-4", acc.color)} />
                    {acc.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex min-h-[200px] flex-col gap-3">
            {isLoading ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <p className="text-sm text-muted-foreground animate-pulse">
                  Loading accounts...
                </p>
              </div>
            ) : filteredAccounts.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <p className="text-sm text-muted-foreground">
                  No accounts linked yet.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredAccounts.map((acc: any) => {
                  const platform = SUPPORTED_ACCOUNTS.find(
                    (p) => p.id === acc.platform
                  );
                  const Icon = platform?.icon || Link2;

                  return (
                    <div
                      key={acc.id}
                      className="flex items-center justify-between rounded-lg border border-border p-3 transition-colors hover:bg-muted/50"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 overflow-hidden items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                          <Icon className={cn("h-5 w-5", platform?.color)} />
                        </div>
                        <div>
                          <p className="text-sm font-semibold leading-none">
                            {acc.platformAccountName || 'Unknown User'}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {acc.platformAccountUsername || acc.platformAccountId}
                          </p>
                          {!acc.publishable ? (
                            <p className="mt-1 text-xs text-warning">
                              {acc.publishBlockedReason || 'Reconnect this account before publishing.'}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 text-xs">
                            Manage
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem 
                            className="text-danger focus:text-danger cursor-pointer"
                            onClick={() => handleDisconnect(acc.id)}
                          >
                            Disconnect
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 flex justify-end">
            <Button onClick={() => setAddAccountOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              <span className="font-semibold">Add account</span>
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={addAccountOpen} onOpenChange={setAddAccountOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect Social Account</DialogTitle>
          </DialogHeader>

          <div className="mt-4 grid grid-cols-2 gap-4">
            {SUPPORTED_ACCOUNTS.map((platform) => (
              <Button
                key={platform.id}
                variant="outline"
                className={cn(
                  'h-24 flex-col gap-3 bg-card hover:bg-accent/50',
                  !platform.enabled && 'opacity-50 cursor-not-allowed'
                )}
                disabled={!platform.enabled}
                onClick={() => {
                  if (platform.enabled) {
                    handleConnect(platform.id);
                  }
                }}
              >
                <platform.icon className={cn("h-8 w-8", platform.color)} />
                <span className="font-semibold">{platform.name}</span>
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
