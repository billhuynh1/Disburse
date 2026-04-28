'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Bell,
  BookOpen,
  CircleIcon,
  HelpCircle,
  Home,
  LogOut,
  PanelLeftClose,
  Search,
  Settings,
  Sparkles,
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
  const activeItem = getActiveDashboardNavItem(pathname);

  return (
    <header className="z-30 border-b border-border/70 bg-shell/95 backdrop-blur">
      <div className="flex min-h-14 w-full items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarTrigger className="lg:hidden" />
          <p className="truncate text-sm text-muted-foreground lg:min-w-48">
            <span className="truncate">{activeItem.label}</span>
          </p>
          <div className="hidden w-full max-w-[30rem] items-center gap-2 rounded-lg border border-border/70 bg-input/80 px-3 py-2 text-sm text-muted-foreground md:flex">
            <Search className="h-4 w-4" />
            <span className="truncate">Find keywords or moments...</span>
            <span className="ml-auto rounded border border-border/70 px-1.5 text-xs">
              ⌘ K
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="hidden sm:inline-flex">
            <Bell className="h-4 w-4" />
          </Button>
          <div className="hidden items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold text-foreground sm:flex">
            <Zap className="h-4 w-4 fill-amber-300 text-amber-300" />
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

  return (
    <Sidebar className="items-center">
      <div className="flex w-full flex-col gap-5 border-b border-sidebar-border px-2 py-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="self-center border border-sidebar-border"
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
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/15 text-primary">
            <CircleIcon className="h-5 w-5" />
          </span>
          {open ? (
            <span className="truncate text-sm font-semibold text-sidebar-foreground">
              Disburse
            </span>
          ) : null}
        </Link>
      </div>
      <SidebarContent className="items-center px-2 py-5">
        <SidebarMenu className="flex w-full flex-col items-center gap-3 space-y-0">
          {dashboardNavItems.map((item) => (
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
      <div className="flex w-full flex-col items-center gap-4 px-2 py-4 text-sidebar-foreground/75">
        {[
          { icon: Sparkles, label: 'Studio' },
          { icon: BookOpen, label: 'Docs' },
          { icon: HelpCircle, label: 'Help' }
        ].map((item) => (
          <div
            key={item.label}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2"
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {open ? (
              <span className="truncate text-sm lg:not-sr-only">{item.label}</span>
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
        <DashboardShell>
          {children}
          <TranscriptToastWatcher />
          <Toaster />
        </DashboardShell>
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
