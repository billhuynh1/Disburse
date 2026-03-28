import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { ArrowRight, FolderKanban, Layers3, Mic2, Settings } from 'lucide-react';

const sections = [
  {
    href: '/dashboard/projects',
    title: 'Projects',
    description: 'Organize source assets and track repurposing work by project.',
    icon: FolderKanban
  },
  {
    href: '/dashboard/content-packs',
    title: 'Content Packs',
    description:
      'Track repurposing bundles and their status across your creator workflow.',
    icon: Layers3
  },
  {
    href: '/dashboard/voice-profiles',
    title: 'Voice Profiles',
    description:
      'Store reusable tone, audience, and prompt guidance for future outputs.',
    icon: Mic2
  },
  {
    href: '/dashboard/settings',
    title: 'Settings',
    description: 'Manage billing, collaborators, account preferences, and activity.',
    icon: Settings
  }
];

export default function DashboardPage() {
  return (
    <section className="flex-1 p-4 lg:p-8">
      <div className="mb-8">
        <h1 className="text-lg font-medium text-foreground lg:text-2xl">
          Dashboard
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground lg:text-base">
          Use the sections below to manage projects, source material, content
          packs, voice profiles, and the account settings that support them.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {sections.map((section) => (
          <Link key={section.href} href={section.href} className="block">
            <Card className="h-full transition-colors hover:border-primary/35">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-primary/18 p-2 text-primary ring-1 ring-primary/20">
                    <section.icon className="h-5 w-5" />
                  </div>
                  <CardTitle>{section.title}</CardTitle>
                </div>
                <CardDescription>{section.description}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center text-sm font-medium text-primary">
                Open {section.title}
                <ArrowRight className="ml-2 h-4 w-4" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}
