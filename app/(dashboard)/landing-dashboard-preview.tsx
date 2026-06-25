'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Check, Clock3, Film, Scissors, Youtube } from 'lucide-react';
import { useState } from 'react';

const queues = {
  tiktok: {
    label: 'TikTok',
    icon: Scissors,
    items: [
      ['Apex final ring panic', 'Hook + captions ready', 'Ready'],
      ['Valorant 1v4 ace', 'Cutdown in review', 'Review'],
      ['Fortnite box fight win', 'Title variants ready', 'Ready']
    ]
  },
  youtube: {
    label: 'YouTube',
    icon: Youtube,
    items: [
      ['CS2 retake breakdown', 'Shorts draft ready', 'Ready'],
      ['League Baron steal', 'Caption pass queued', 'Queued'],
      ['Apex ranked lesson', 'Thumbnail notes ready', 'Ready']
    ]
  }
};

const sourceMoments = [
  ['00:08:14', 'Setup', 'Enemy team overcommits mid'],
  ['00:09:02', 'Payoff', 'Flash, swing, ace, crowd reaction'],
  ['00:09:51', 'CTA', 'Ask viewers for their rank prediction']
];

export function LandingDashboardPreview() {
  const [activeQueue, setActiveQueue] = useState<keyof typeof queues>('tiktok');
  const queue = queues[activeQueue];
  const QueueIcon = queue.icon;

  return (
    <div className="grid overflow-hidden rounded-2xl border border-border/80 bg-[linear-gradient(180deg,hsl(var(--card)),hsl(var(--shell)))] shadow-[0_22px_70px_rgba(0,0,0,0.36)] lg:grid-cols-[260px_1fr]">
      <aside className="border-b border-border/70 bg-shell/70 p-4 lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Film className="h-4 w-4" />
          Stream source
        </div>
        <div className="mt-4 rounded-xl border border-border/70 bg-surface-1 p-3">
          <div className="aspect-video rounded-lg bg-[linear-gradient(135deg,hsl(var(--surface-2)),hsl(var(--muted)))]" />
          <p className="mt-3 text-sm font-medium text-foreground">
            Friday ranked session
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            2h 14m · Valorant / Apex queue
          </p>
        </div>
        <div className="mt-4 space-y-2">
          {sourceMoments.map(([time, type, copy]) => (
            <div key={time} className="rounded-lg border border-border/60 bg-background/50 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">{time}</span>
                <span className="text-muted-foreground">{type}</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{copy}</p>
            </div>
          ))}
        </div>
      </aside>

      <div className="p-4 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm text-muted-foreground">Content pack</p>
            <h3 className="mt-1 text-xl font-semibold text-foreground">
              One recording, two platform queues
            </h3>
          </div>
          <div className="flex rounded-lg border border-border/70 bg-surface-1 p-1">
            {(Object.keys(queues) as Array<keyof typeof queues>).map((key) => {
              const item = queues[key];
              const Icon = item.icon;

              return (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={activeQueue === key ? 'secondary' : 'ghost'}
                  onClick={() => setActiveQueue(key)}
                  className="min-w-24"
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_280px]">
          <div className="rounded-xl border border-border/70 bg-surface-1 p-4">
            <div className="flex items-center gap-2">
              <QueueIcon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-foreground">
                {queue.label} drafts
              </span>
            </div>
            <div className="mt-4 space-y-3">
              {queue.items.map(([title, detail, status], index) => (
                <div
                  key={title}
                  className="group grid gap-3 rounded-xl border border-border/70 bg-background/50 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent/40 sm:grid-cols-[1fr_auto]"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md border border-border/70 bg-surface-2 text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      <p className="text-sm font-medium text-foreground">{title}</p>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
                  </div>
                  <span
                    className={cn(
                      'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs',
                      status === 'Ready'
                        ? 'border-success/30 bg-success/10 text-success'
                        : 'border-border/70 bg-surface-2 text-muted-foreground'
                    )}
                  >
                    {status === 'Ready' ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Clock3 className="h-3 w-3" />
                    )}
                    {status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-surface-1 p-4">
            <p className="text-sm font-medium text-foreground">AI workflow</p>
            <div className="mt-4 space-y-4">
              {['Transcribe source', 'Detect moments', 'Draft hooks', 'Format outputs'].map(
                (step, index) => (
                  <div key={step}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{step}</span>
                      <span className="text-foreground">{index === 3 ? '82%' : '100%'}</span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-muted">
                      <div
                        className={cn(
                          'h-full rounded-full bg-foreground transition-all duration-500',
                          index === 3 ? 'w-[82%]' : 'w-full'
                        )}
                      />
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
