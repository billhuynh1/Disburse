import {
  FolderOpen,
  Home,
  Mic2,
  Settings,
  type LucideIcon
} from 'lucide-react';

export type DashboardNavItem = {
  href: string;
  icon: LucideIcon;
  label: string;
};

export const dashboardNavItems: DashboardNavItem[] = [
  { href: '/dashboard', icon: Home, label: 'Home' },
  { href: '/dashboard/assets', icon: FolderOpen, label: 'Assets' },
  {
    href: '/dashboard/voice-profiles',
    icon: Mic2,
    label: 'Voice Profiles'
  },
  { href: '/dashboard/settings', icon: Settings, label: 'Settings' }
];

export function getActiveDashboardNavItem(pathname: string) {
  return (
    dashboardNavItems.find((item) => {
      if (item.href === '/dashboard') {
        return pathname === item.href;
      }

      if (item.href === '/dashboard/settings') {
        return (
          pathname === item.href ||
          pathname === '/dashboard/general' ||
          pathname === '/dashboard/security' ||
          pathname === '/dashboard/activity' ||
          pathname.startsWith(`${item.href}/`)
        );
      }

      return pathname === item.href || pathname.startsWith(`${item.href}/`);
    }) || dashboardNavItems[0]
  );
}
