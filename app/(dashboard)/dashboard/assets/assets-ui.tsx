'use client';

import { useState } from 'react';
import {
  FileAudio,
  FileImage,
  FileVideo,
  FolderOpen,
  Info,
  Library,
  Plus,
  Tags,
  Type,
  Upload
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { PageSectionHeader } from '@/components/dashboard/dashboard-ui';

type MediaTab = 'all' | 'images' | 'videos' | 'audio';

const vocabularyPreview = [
  'Disburse',
  'short-form clips',
  'creator workflow',
  'repurposing pack',
  'review queue'
];

const mediaTabs: {
  value: MediaTab;
  label: string;
  icon: typeof FileImage;
}[] = [
  { value: 'all', label: 'All', icon: Library },
  { value: 'images', label: 'Images', icon: FileImage },
  { value: 'videos', label: 'Videos', icon: FileVideo },
  { value: 'audio', label: 'Audio', icon: FileAudio }
];

function DisabledNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-300/20 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

function AssetDropzone({
  title,
  description,
  acceptLabel
}: {
  title: string;
  description: string;
  acceptLabel: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border/80 bg-background/35 p-5 text-center">
      <Upload className="mx-auto h-6 w-6 text-primary" />
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <p className="mt-2 text-xs text-muted-foreground">{acceptLabel}</p>
      <Button type="button" variant="outline" className="mt-4" disabled>
        <Upload className="h-4 w-4" />
        Upload
      </Button>
      {/* TODO: Wire this control to durable brand/media storage when tables and upload endpoints exist. */}
    </div>
  );
}

function BrandVocabularySection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tags className="h-4 w-4 text-primary" />
          Brand vocabulary
        </CardTitle>
        <CardDescription>
          Proper nouns, preferred spellings, and phrases generation should keep
          consistent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <Label htmlFor="brand-term" className="mb-2">
              Preferred word or proper noun
            </Label>
            <Input id="brand-term" placeholder="Add a term" disabled />
          </div>
          <Button type="button" className="self-end" disabled>
            <Plus className="h-4 w-4" />
            Add term
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{vocabularyPreview.length}/50 preview terms</span>
          <span>Storage not connected</span>
        </div>

        <div className="flex flex-wrap gap-2">
          {vocabularyPreview.map((term) => (
            <span
              key={term}
              className="rounded-full border border-border/70 bg-background/45 px-3 py-1 text-sm text-muted-foreground"
            >
              {term}
            </span>
          ))}
        </div>

        <DisabledNotice>
          Vocabulary is shown as a product placeholder. It is not saved because
          no brand vocabulary backend exists yet.
        </DisabledNotice>
      </CardContent>
    </Card>
  );
}

function FontUploadSection() {
  const fontSlots = ['Heading font', 'Body font', 'Caption font'];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Type className="h-4 w-4 text-primary" />
          Fonts
        </CardTitle>
        <CardDescription>
          Fonts for future captions, title cards, and brand templates.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AssetDropzone
          title="Upload brand fonts"
          description="Add font files for reusable caption and layout styles."
          acceptLabel="Planned support: OTF, TTF, WOFF, WOFF2"
        />

        <div className="grid gap-3">
          {fontSlots.map((slot) => (
            <div
              key={slot}
              className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/35 p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{slot}</p>
                <p className="text-xs text-muted-foreground">No font selected</p>
              </div>
              <Button type="button" variant="outline" size="sm" disabled>
                Choose
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function MediaPlaceholderCard({
  label,
  icon: Icon
}: {
  label: string;
  icon: typeof FileImage;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-background/35 p-4">
      <Icon className="mb-3 h-5 w-5 text-primary" />
      <p className="text-sm font-medium text-foreground">{label}</p>
      <p className="mt-1 text-sm text-muted-foreground">No files yet.</p>
    </div>
  );
}

function MediaLibrarySection() {
  const [activeTab, setActiveTab] = useState<MediaTab>('all');
  const visibleCards =
    activeTab === 'all'
      ? [
          { label: 'Images', icon: FileImage },
          { label: 'Videos', icon: FileVideo },
          { label: 'Audio', icon: FileAudio }
        ]
      : [
          {
            label: mediaTabs.find((tab) => tab.value === activeTab)?.label || 'Media',
            icon:
              mediaTabs.find((tab) => tab.value === activeTab)?.icon || FileImage
          }
        ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-primary" />
          Media
        </CardTitle>
        <CardDescription>
          Reusable images, videos, audio stings, and B-roll for future exports.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {mediaTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setActiveTab(tab.value)}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition',
                activeTab === tab.value
                  ? 'border-primary/50 bg-primary/15 text-primary'
                  : 'border-border/70 bg-background/35 text-muted-foreground hover:text-foreground'
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <AssetDropzone
          title="Upload reusable media"
          description="Drop images, videos, and audio files for future clip workflows."
          acceptLabel="Planned support: PNG, JPG, MP4, MOV, MP3, WAV"
        />

        <div className="grid gap-3 md:grid-cols-3">
          {visibleCards.map((card) => (
            <MediaPlaceholderCard
              key={card.label}
              label={card.label}
              icon={card.icon}
            />
          ))}
        </div>

        <DisabledNotice>
          Media uploads are intentionally disabled until a reusable asset model
          and upload endpoint are added.
        </DisabledNotice>
      </CardContent>
    </Card>
  );
}

export function AssetsPage() {
  return (
    <section className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <PageSectionHeader
          title="Assets"
          description="Manage reusable brand vocabulary, fonts, and media for future clip generation workflows."
        />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="space-y-6">
            <BrandVocabularySection />
            <FontUploadSection />
          </div>
          <MediaLibrarySection />
        </div>
      </div>
    </section>
  );
}
