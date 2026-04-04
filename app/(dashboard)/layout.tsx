'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { CircleIcon, Home, LogOut, Settings } from 'lucide-react';
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

const fetcher = (url: string) => fetch(url).then((res) => res.json());

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
    <header className="border-b border-border/80 bg-background/70 backdrop-blur-xl">
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
    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarTrigger className="lg:hidden" />
          <span className="truncate text-sm font-medium text-muted-foreground lg:text-base">
            {activeItem.label}
          </span>
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
    <section className="min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl">
        <Sidebar>
          <div className="flex items-center justify-between gap-3 border-b border-sidebar-border px-4 py-4">
            <Link href="/" className="flex min-w-0 items-center">
              <CircleIcon className="h-6 w-6 shrink-0 text-primary" />
              {open ? (
                <span className="ml-2 truncate text-xl font-semibold text-sidebar-foreground">
                  Disburse
                </span>
              ) : null}
            </Link>
            <SidebarTrigger className="hidden lg:inline-flex" />
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
        <SidebarInset className="min-h-screen">
          <DashboardHeader />
          <main className="flex-1 p-0 lg:p-4">{children}</main>
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
