import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Activity, Settings, Shield } from 'lucide-react';
import { WorkspaceSettings } from '../workspace-settings';

const settingsLinks = [
  {
    href: '/dashboard/general',
    title: 'Profile',
    description: 'Update your account details and personal profile information.',
    icon: Settings
  },
  {
    href: '/dashboard/security',
    title: 'Security',
    description: 'Manage password changes and account removal controls.',
    icon: Shield
  },
  {
    href: '/dashboard/activity',
    title: 'Activity',
    description: 'Review sign-ins and recent account or collaborator actions.',
    icon: Activity
  }
];

export default function SettingsPage() {
  return (
    <div className="flex-1 p-4 lg:p-8">
      <section className="mb-10">
        <h1 className="text-lg font-medium text-foreground lg:text-2xl">
          Settings
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground lg:text-base">
          Settings combines billing and collaborator management with account,
          security, and activity tools already present in the app.
        </p>
      </section>

      <section className="mb-10 grid gap-4 md:grid-cols-3">
        {settingsLinks.map((item) => (
          <Link key={item.href} href={item.href} className="block">
            <Card className="h-full transition-colors hover:border-primary/35">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-secondary/18 p-2 text-secondary ring-1 ring-secondary/20">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <CardTitle>{item.title}</CardTitle>
                </div>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
              <CardContent className="text-sm font-medium text-primary">
                Open {item.title}
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>

      <WorkspaceSettings />
    </div>
  );
}
