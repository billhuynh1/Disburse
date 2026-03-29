'use client';

import * as React from 'react';
import { Slot as SlotPrimitive } from 'radix-ui';
import { PanelLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const SIDEBAR_COOKIE_NAME = 'dashboard_sidebar_state';
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const SIDEBAR_WIDTH = '16rem';
const SIDEBAR_WIDTH_ICON = '4.5rem';
const SIDEBAR_WIDTH_MOBILE = '16rem';

type SidebarContextValue = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: React.Dispatch<React.SetStateAction<boolean>>;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);

  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }

  return context;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1023px)');
    const handleChange = () => setIsMobile(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener('change', handleChange);

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isMobile;
}

function getSidebarCookie(defaultOpen: boolean) {
  if (typeof document === 'undefined') {
    return defaultOpen;
  }

  const cookieValue = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${SIDEBAR_COOKIE_NAME}=`))
    ?.split('=')[1];

  if (cookieValue === 'true') {
    return true;
  }

  if (cookieValue === 'false') {
    return false;
  }

  return defaultOpen;
}

function setSidebarCookie(open: boolean) {
  document.cookie = `${SIDEBAR_COOKIE_NAME}=${open}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
}

function SidebarProvider({
  children,
  defaultOpen = true,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [open, setOpenState] = React.useState(defaultOpen);

  React.useEffect(() => {
    setOpenState(getSidebarCookie(defaultOpen));
  }, [defaultOpen]);

  const setOpen = React.useCallback((value: boolean) => {
    setOpenState(value);
    setSidebarCookie(value);
  }, []);

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) {
      setOpenMobile((value) => !value);
      return;
    }

    setOpen(!open);
  }, [isMobile, open, setOpen]);

  return (
    <SidebarContext.Provider
      value={{
        state: open ? 'expanded' : 'collapsed',
        open,
        setOpen,
        openMobile,
        setOpenMobile,
        isMobile,
        toggleSidebar
      }}
    >
      <div
        data-slot="sidebar-provider"
        data-state={open ? 'expanded' : 'collapsed'}
        style={
          {
            '--sidebar-width': SIDEBAR_WIDTH,
            '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
            '--sidebar-width-mobile': SIDEBAR_WIDTH_MOBILE
          } as React.CSSProperties
        }
        className={cn('group/sidebar-wrapper', className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  className,
  children,
  ...props
}: React.ComponentProps<'aside'>) {
  const { open, openMobile, setOpenMobile } = useSidebar();

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-30 bg-black/30 transition-opacity lg:hidden',
          openMobile ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
        onClick={() => setOpenMobile(false)}
      />

      <aside
        data-slot="sidebar-mobile"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-(--sidebar-width-mobile) flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-[0_0_40px_rgba(7,9,22,0.4)] transition-transform duration-300 ease-in-out lg:hidden',
          openMobile ? 'translate-x-0' : '-translate-x-full',
          className
        )}
        {...props}
      >
        {children}
      </aside>

      <div
        data-slot="sidebar-desktop-shell"
        className={cn(
          'hidden shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-[0_0_40px_rgba(7,9,22,0.4)] transition-[width] duration-300 ease-in-out lg:sticky lg:top-0 lg:block lg:h-screen',
          open ? 'w-[--sidebar-width]' : 'w-[--sidebar-width-icon]'
        )}
      >
        <aside
          data-slot="sidebar"
          className={cn(
            'flex h-screen w-full flex-col',
            className
          )}
          {...props}
        >
          {children}
        </aside>
      </div>
    </>
  );
}

function SidebarContent({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto p-4', className)}
      {...props}
    />
  );
}

function SidebarMenu({
  className,
  ...props
}: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn('space-y-1', className)}
      {...props}
    />
  );
}

function SidebarMenuItem({
  className,
  ...props
}: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn(className)}
      {...props}
    />
  );
}

function SidebarMenuButton({
  className,
  isActive = false,
  asChild = false,
  tooltip,
  ...props
}: React.ComponentProps<'button'> & {
  isActive?: boolean;
  asChild?: boolean;
  tooltip?: string;
}) {
  const { open, setOpenMobile } = useSidebar();
  const Comp = asChild ? SlotPrimitive.Slot : 'button';

  return (
    <Comp
      data-slot="sidebar-menu-button"
      data-active={isActive}
      title={!open ? tooltip : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors outline-none',
        'rounded-xl hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        'focus-visible:ring-sidebar-ring focus-visible:ring-[3px]',
        !open && 'justify-center px-2',
        isActive &&
          'bg-[linear-gradient(135deg,hsl(var(--sidebar-primary)/0.24),hsl(var(--secondary)/0.18))] text-sidebar-accent-foreground shadow-[0_10px_26px_hsl(var(--glow-primary)/0.18)]',
        className
      )}
      onClick={() => setOpenMobile(false)}
      {...props}
    />
  );
}

function SidebarInset({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn('flex min-w-0 flex-1 flex-col', className)}
      {...props}
    />
  );
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();

  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeft className="h-5 w-5" />
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar
};
