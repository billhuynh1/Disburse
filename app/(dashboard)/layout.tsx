'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { CircleIcon, Home, LogOut, Search, Settings, Sparkles } from 'lucide-react';
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
  const { isMobile } = useSidebar();
  const activeItem = getActiveDashboardNavItem(pathname);

  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-shell/95 backdrop-blur">
      <div className="flex w-full items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarTrigger className="lg:hidden" />
          <div className="hidden min-w-0 items-center gap-2 rounded-full border border-border/70 bg-background/60 px-3 py-1.5 text-sm text-muted-foreground sm:flex">
            <Search className="h-3.5 w-3.5" />
            <span className="truncate">{activeItem.label}</span>
          </div>
        </div>
        <div className="flex items-center space-x-4">
          <Suspense fallback={<div className="h-9" />}>
            <UserMenu />
          </Suspense>
        </div>
      </div>
    </header>
  );
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { open } = useSidebar();
  const activeItem = getActiveDashboardNavItem(pathname);

  return (
    <section className="min-h-screen bg-shell">
      <div className="flex min-h-screen w-full">
        <Sidebar>
          <div className="border-b border-sidebar-border px-4 py-4">
            <div className="flex items-center justify-between gap-3">
            <Link href="/" className="flex min-w-0 items-center">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/12 text-primary shadow-[0_0_28px_hsl(var(--primary)/0.15)]">
                <CircleIcon className="h-5 w-5" />
              </span>
              {open ? (
                <span className="ml-3 truncate text-lg font-semibold text-sidebar-foreground">
                  Disburse
                </span>
              ) : null}
            </Link>
            <SidebarTrigger className="hidden lg:inline-flex" />
            </div>
            {open ? (
              <div className="mt-4 rounded-xl border border-sidebar-border bg-sidebar-accent/45 p-3">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-primary">
                  <Sparkles className="h-3.5 w-3.5" />
                  Studio
                </div>
                <p className="mt-2 text-xs leading-5 text-sidebar-foreground/65">
                  Source to transcript to clips, managed in one workflow.
                </p>
              </div>
            ) : null}
          </div>
          <SidebarContent className="pt-5">
            <SidebarMenu>
              {dashboardNavItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={activeItem.href === item.href}
                    tooltip={item.label}
                  >
                    <Link href={item.href}>
                      <item.icon className="h-4 w-4 shrink-0" />
                      {open ? <span>{item.label}</span> : null}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <SidebarInset className="min-h-screen bg-background">
          <DashboardHeader />
          <main className="flex-1">{children}</main>
        </SidebarInset>
      </div>
    </section>
  );
}

function isProjectWorkspaceRoute(pathname: string) {
  return /^\/dashboard\/projects\/\d+$/.test(pathname);
}

function WorkspaceShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <TranscriptToastWatcher />
      <Toaster />
    </>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isDashboardRoute =
    pathname === '/dashboard' || pathname.startsWith('/dashboard/');

  if (isDashboardRoute) {
    if (isProjectWorkspaceRoute(pathname)) {
      return <WorkspaceShell>{children}</WorkspaceShell>;
    }

    return (
      <SidebarProvider defaultOpen>
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
