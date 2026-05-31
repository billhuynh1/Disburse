'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  CircleIcon,
  HelpCircle,
  Home,
  LogOut,
  PanelLeftClose,
  Search,
  Settings,
  X,
  Zap
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { signOut } from '@/app/(login)/actions';
import { useRouter } from 'next/navigation';
import { User } from '@/lib/db/schema';
import useSWR, { mutate } from 'swr';
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar
} from '@/components/ui/sidebar';
import {
  dashboardNavItems,
  getActiveDashboardNavItem
} from '@/lib/disburse/dashboard-nav';
import { Toaster } from '@/components/ui/toaster';
import { TranscriptToastWatcher } from '@/components/dashboard/transcript-toast-watcher';
import { SocialAccountsModal } from '@/components/dashboard/social-accounts-modal';
import { Share2 } from 'lucide-react';
import { NotificationMenu } from '@/components/dashboard/notification-menu';
import {
  ProjectClipSearchProvider,
  useProjectClipSearch
} from '@/components/dashboard/project-clip-search-context';

const fetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  return response.json();
};

function UserMenu() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { data: user } = useSWR<User>('/api/user', fetcher);
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    mutate('/api/user');
    router.push('/');
  }

  if (!user) {
    return (
      <>
        <Link
          href="/pricing"
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Pricing
        </Link>
        <Button variant="ghost" asChild>
          <Link href="/sign-in">Sign in</Link>
        </Button>
        <Button asChild>
          <Link href="/sign-up">Sign Up</Link>
        </Button>
      </>
    );
  }

  return (
    <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <DropdownMenuTrigger>
        <Avatar className="cursor-pointer size-9">
          <AvatarImage alt={user.name || ''} />
          <AvatarFallback>
            {(user.name || user.email)
              .split(' ')
              .map((n) => n[0])
              .join('')}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="flex flex-col gap-1">
        <DropdownMenuItem className="cursor-pointer">
          <Link href="/dashboard" className="flex w-full items-center">
            <Home className="mr-2 h-4 w-4" />
            <span>Dashboard</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer">
          <Link href="/dashboard/settings" className="flex w-full items-center">
            <Settings className="mr-2 h-4 w-4" />
            <span>Settings</span>
          </Link>
        </DropdownMenuItem>
        <form action={handleSignOut} className="w-full">
          <button type="submit" className="flex w-full">
            <DropdownMenuItem className="w-full flex-1 cursor-pointer">
              <LogOut className="mr-2 h-4 w-4" />
              <span>Sign out</span>
            </DropdownMenuItem>
          </button>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Header() {
  return (
    <header className="border-b border-border/70 bg-shell">
      <div className="max-w-7xl mx-auto flex items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center">
          <CircleIcon className="h-6 w-6 text-primary" />
          <span className="ml-2 text-xl font-semibold text-foreground">
            Disburse
          </span>
        </Link>
        <div className="flex items-center space-x-4">
          <Suspense fallback={<div className="h-9" />}>
            <UserMenu />
          </Suspense>
        </div>
      </div>
    </header>
  );
}

function DashboardHeader() {
  const pathname = usePathname();
  const isProjectEditor = isProjectWorkspaceRoute(pathname);
  const { query, setQuery, clearQuery } = useProjectClipSearch();

  useEffect(() => {
    if (!isProjectEditor) {
      clearQuery();
    }
  }, [clearQuery, isProjectEditor]);

  return (
    <header className="z-30 border-b border-border/70 bg-shell/95 backdrop-blur">
      <div className="grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4">
        <div className="flex min-w-0 items-center justify-start">
          <SidebarTrigger className="lg:hidden" />
        </div>
        <div className="flex min-w-0 justify-center justify-self-center">
          {isProjectEditor ? (
            <div className="relative hidden w-full min-w-[18rem] max-w-md sm:block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search keywords or moments"
                className="h-9 w-full rounded-lg border border-border/70 bg-background/80 px-9 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-muted-foreground/70 focus:ring-1 focus:ring-muted-foreground/30 [&::-webkit-search-cancel-button]:appearance-none"
                aria-label="Search keywords or moments"
              />
              {query ? (
                <button
                  type="button"
                  onClick={clearQuery}
                  className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/20 hover:text-foreground"
                  aria-label="Clear clip search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 justify-self-end">
          <NotificationMenu />
          <div className="hidden items-center gap-1 rounded-lg border border-border/70 bg-surface-1 px-2.5 py-1.5 text-sm font-semibold text-foreground sm:flex">
            <Zap className="h-4 w-4 fill-warning text-warning" />
            90
          </div>
          <Button variant="outline" className="hidden sm:inline-flex">
            Add more credits
          </Button>
          <Suspense fallback={<div className="h-9" />}>
            <UserMenu />
          </Suspense>
        </div>
      </div>
    </header>
  );
}

function DashboardSidebar() {
  const pathname = usePathname();
  const activeItem = getActiveDashboardNavItem(pathname);
  const { open, setOpen, toggleSidebar, isMobile } = useSidebar();
  const [socialModalOpen, setSocialModalOpen] = useState(false);

  return (
    <Sidebar>
      <SocialAccountsModal open={socialModalOpen} onOpenChange={setSocialModalOpen} />
      <div className="flex w-full flex-col gap-5 border-b border-sidebar-border px-2 py-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="self-center border border-sidebar-border bg-sidebar-accent/60"
          onClick={() => {
            if (isMobile) {
              toggleSidebar();
              return;
            }

            setOpen(!open);
          }}
          aria-label="Toggle sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
        <Link
          href="/dashboard"
          className="flex items-center gap-3 rounded-xl px-2 py-1.5"
          aria-label="Disburse home"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-sidebar-accent text-white">
            <CircleIcon className="h-5 w-5" />
          </span>
          {open ? (
            <span className="truncate text-sm font-semibold text-sidebar-foreground">
              Disburse
            </span>
          ) : null}
        </Link>
      </div>
      <SidebarContent className="px-2 py-5">
        <SidebarMenu className="flex w-full flex-col gap-3 space-y-0">
          {dashboardNavItems.filter(item => item.href !== '/dashboard/settings').map((item) => (
            <SidebarMenuItem key={item.href} className="w-full">
              <SidebarMenuButton
                asChild
                isActive={activeItem.href === item.href}
                tooltip={item.label}
                className={
                  open
                    ? 'mx-auto h-10 w-full justify-start rounded-xl px-3 py-0'
                    : 'mx-auto size-10 justify-center rounded-xl px-0 py-0'
                }
              >
                <Link href={item.href} aria-label={item.label}>
                  <item.icon className="h-5 w-5 shrink-0" />
                  {open ? (
                    <span className="truncate lg:not-sr-only">{item.label}</span>
                  ) : (
                    <span className="lg:sr-only">{item.label}</span>
                  )}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}

          <SidebarMenuItem className="w-full">
            <SidebarMenuButton
              tooltip="Social Accounts"
              className={
                open
                  ? 'mx-auto h-10 w-full justify-start rounded-xl px-3 py-0 cursor-pointer'
                  : 'mx-auto size-10 justify-center rounded-xl px-0 py-0 cursor-pointer'
              }
              onClick={() => setSocialModalOpen(true)}
            >
              <Share2 className="h-5 w-5 shrink-0" />
              {open ? (
                <span className="truncate lg:not-sr-only">Social Accounts</span>
              ) : (
                <span className="lg:sr-only">Social Accounts</span>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>

          {dashboardNavItems.filter(item => item.href === '/dashboard/settings').map((item) => (
            <SidebarMenuItem key={item.href} className="w-full">
              <SidebarMenuButton
                asChild
                isActive={activeItem.href === item.href}
                tooltip={item.label}
                className={
                  open
                    ? 'mx-auto h-10 w-full justify-start rounded-xl px-3 py-0'
                    : 'mx-auto size-10 justify-center rounded-xl px-0 py-0'
                }
              >
                <Link href={item.href} aria-label={item.label}>
                  <item.icon className="h-5 w-5 shrink-0" />
                  {open ? (
                    <span className="truncate lg:not-sr-only">{item.label}</span>
                  ) : (
                    <span className="lg:sr-only">{item.label}</span>
                  )}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>
      <div className="flex w-full flex-col gap-4 px-2 py-4 text-sidebar-foreground/75">
        {[
          { icon: HelpCircle, label: 'Help' }
        ].map((item) => (
          <div
            key={item.label}
            className={
              open
                ? 'flex w-full items-center gap-3 rounded-xl px-3 py-2 cursor-pointer hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors'
                : 'flex mx-auto size-10 items-center justify-center rounded-xl cursor-pointer hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors'
            }
          >
            <item.icon className="h-5 w-5 shrink-0" />
            {open ? (
              <span className="truncate text-sm font-medium lg:not-sr-only">{item.label}</span>
            ) : (
              <span className="lg:sr-only">{item.label}</span>
            )}
          </div>
        ))}
      </div>
    </Sidebar>
  );
}

function isProjectWorkspaceRoute(pathname: string) {
  return /^\/dashboard\/projects\/\d+$/.test(pathname);
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isWorkspace = isProjectWorkspaceRoute(pathname);

  return (
    <section className="min-h-screen bg-shell">
      <div className="flex min-h-screen w-full overflow-hidden">
        <DashboardSidebar />
        <SidebarInset className="flex h-screen min-h-0 flex-col bg-background">
          <DashboardHeader />
          <main
            className={
              isWorkspace
                ? 'min-h-0 flex-1 overflow-hidden'
                : 'min-h-0 flex-1 overflow-y-auto'
            }
          >
            {children}
          </main>
        </SidebarInset>
      </div>
    </section>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isDashboardRoute =
    pathname === '/dashboard' || pathname.startsWith('/dashboard/');

  if (isDashboardRoute) {
    return (
      <SidebarProvider defaultOpen={false}>
        <ProjectClipSearchProvider>
          <DashboardShell>
            {children}
            <TranscriptToastWatcher />
            <Toaster />
          </DashboardShell>
        </ProjectClipSearchProvider>
      </SidebarProvider>
    );
  }

  return (
    <section className="flex flex-col min-h-screen">
      <Header />
      {children}
    </section>
  );
}
