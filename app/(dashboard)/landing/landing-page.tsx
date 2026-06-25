import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ImageIcon, MinusCircle, PlusCircle } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

const problemSteps = [
  'You spend hours scrubbing through long VODs just to find the few moments worth posting.',
  'Editing clips for Shorts and TikTok means less time streaming, so highlights stay buried in old broadcasts.',
  'Getting facecam, captions, and vertical sizing right across platforms is a frustrating manual job.'
];

const solutionRows = [
  {
    title: 'Find your best moments without rewatching',
    description:
      'AI scans long stream VODs and highlights hype plays, funny fails, and standout moments so you stop wasting hours scrubbing footage.',
    placeholder: 'Placeholder: best moments mockup'
  },
  {
    title: 'Post more clips without cutting into stream time',
    description:
      'Get a batch of short clip suggestions in minutes, so your highlights stop sitting in old broadcasts and start bringing in new viewers.',
    placeholder: 'Placeholder: clip batch mockup'
  },
  {
    title: 'Get every clip sized and styled right',
    description:
      'Use facecam layouts, vertical formats, and brand templates to make clips fit each platform without manual resizing or extra editing.',
    placeholder: 'Placeholder: format and styling mockup'
  }
];

const capabilityCards = [
  {
    title: 'Upload full VODs',
    description: 'Drop in recorded streams and let the app handle the first pass for you.'
  },
  {
    title: 'Find best moments',
    description: 'AI spots hype plays and funny fails so you stop scrubbing through hours of footage.'
  },
  {
    title: 'Format for every feed',
    description: 'Get clip suggestions sized for YouTube Shorts, TikTok, and other vertical platforms.'
  },
  {
    title: 'Auto-detect facecam',
    description:
      'Facecam layouts like 30/70 are applied automatically so your clips look built for streaming.'
  },
  {
    title: 'Match your brand',
    description: 'Use custom templates for captions, colors, logos, and styles that fit your channel.'
  },
  {
    title: 'Export in batches',
    description: 'Pick your favorites and download multiple ready-to-post clips in one go.'
  }
];

const faqs = [
  {
    question: 'What does Disburse do?',
    answer:
      'Disburse takes your stream VOD and turns it into a batch of short clips in minutes. It looks for hype plays, funny moments, and other parts worth posting, then gives you clips ready for Shorts, TikTok, and other vertical feeds.'
  },
  {
    question: 'Who is this for?',
    answer:
      'Disburse is built for streamers, especially Twitch and YouTube Live creators who want to post more short-form content without spending hours editing old streams.'
  },
  {
    question: 'How is this different from editing clips by hand?',
    answer:
      'Instead of scrubbing through a long VOD yourself, Disburse does the first pass for you. It helps you find good moments faster, sizes clips for different platforms, and saves you from choosing between streaming and editing.'
  },
  {
    question: 'Can I use my facecam layout and branding?',
    answer:
      'Yes. Disburse can detect your facecam and apply layouts like a 30/70 split between your camera and gameplay. You can also use brand templates for captions, colors, logos, and more.'
  },
  {
    question: 'Which platforms can I post to?',
    answer:
      'You can create clips sized for YouTube Shorts, TikTok, and other vertical video feeds. That means you can post in more places without fixing the format each time.'
  },
  {
    question: 'Do I need a video editor or complicated software?',
    answer:
      'No. Disburse is a web app made for stream VODs, so you can upload your recorded streams, pick the clips you want, and download or export them in batches. It is a good fit if you want more clips without hiring an editor or learning complex tools.'
  }
];

export function LandingPage() {
  return (
    <main className="overflow-hidden bg-background text-foreground">
      <HeroSection />
      <ProblemSteps />
      <SolutionAlternates />
      <CapabilityGrid />
      <TestimonialSection />
      <FaqSection />
      <FinalCta />
    </main>
  );
}

function HeroSection() {
  return (
    <LandingSection className="relative isolate bg-[linear-gradient(135deg,hsl(var(--surface-2)),hsl(var(--background)))] pb-10 pt-16 sm:pb-20 sm:pt-24 lg:pb-28">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-10 text-center lg:gap-16">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground sm:text-base">
            AI clip generator for streamers
          </p>
          <h1 className="mt-6 text-balance text-5xl font-black leading-[1.05] tracking-tight text-foreground sm:text-6xl lg:text-7xl">
            Turn stream VODs into ready-to-post clips in minutes
          </h1>
          <p className="mx-auto mt-8 max-w-2xl text-balance text-lg leading-8 text-muted-foreground sm:text-xl">
            AI finds hype plays and funny moments, formats them for Shorts and TikTok, and saves hours of editing after every stream.
          </p>
          <div className="mt-10 flex justify-center">
            <PrimaryCta />
          </div>
        </div>
        <PlaceholderMedia label="Placeholder: hero product mockup" className="aspect-square sm:aspect-video" />
      </div>
    </LandingSection>
  );
}

function ProblemSteps() {
  return (
    <LandingSection className="bg-background py-16 sm:py-24 lg:py-28">
      <div className="mx-auto max-w-2xl lg:py-10">
        <h2 className="max-w-xl text-pretty text-4xl font-extrabold leading-tight tracking-tight text-foreground sm:text-5xl">
          Clipping your streams takes too much time
        </h2>
        <ol className="mt-10 flex flex-col gap-8">
          {problemSteps.map((step, index) => (
            <li key={step} className="flex min-h-8 gap-4 sm:gap-5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold text-foreground">
                {index + 1}
              </span>
              <p className="pt-0.5 text-pretty text-lg leading-8 text-muted-foreground">
                {step}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </LandingSection>
  );
}

function SolutionAlternates() {
  return (
    <LandingSection className="bg-background py-16 sm:py-24 lg:py-28">
      <SectionHeader
        title="Let AI find and format your best stream moments"
        description="Upload your VOD, let AI find the best moments, and get a batch of clips formatted for Shorts, TikTok, and more."
      />
      <div className="mt-12 space-y-10 lg:mt-16 lg:space-y-16">
        {solutionRows.map((row, index) => (
          <FeatureSplitRow key={row.title} row={row} reverse={index % 2 === 1} />
        ))}
      </div>
    </LandingSection>
  );
}

function FeatureSplitRow({
  row,
  reverse
}: {
  row: (typeof solutionRows)[number];
  reverse: boolean;
}) {
  return (
    <div className="grid overflow-hidden rounded-lg border border-border/60 bg-surface-1 lg:grid-cols-2">
      <div className={cn('min-h-80', reverse && 'lg:order-2')}>
        <PlaceholderMedia label={row.placeholder} className="h-full min-h-80 rounded-none border-0" />
      </div>
      <div className="flex min-h-80 flex-col justify-center p-8 sm:p-10 lg:p-12">
        <h3 className="max-w-md text-pretty text-3xl font-extrabold leading-tight tracking-tight text-foreground">
          {row.title}
        </h3>
        <p className="mt-6 max-w-md text-pretty text-lg leading-8 text-muted-foreground">
          {row.description}
        </p>
      </div>
    </div>
  );
}

function CapabilityGrid() {
  return (
    <LandingSection className="bg-surface-1 py-16 sm:py-24 lg:py-28">
      <SectionHeader
        title="Everything you need to go from VOD to posted clip"
        description="AI handles the editing so you can spend more time streaming."
      />
      <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:mt-16 lg:grid-cols-3">
        {capabilityCards.map((card) => (
          <CapabilityCard key={card.title} card={card} />
        ))}
      </div>
    </LandingSection>
  );
}

function CapabilityCard({ card }: { card: (typeof capabilityCards)[number] }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="order-2 p-8">
        <h3 className="text-pretty text-2xl font-bold leading-tight text-foreground">
          {card.title}
        </h3>
        <p className="mt-5 text-pretty text-base leading-7 text-muted-foreground">
          {card.description}
        </p>
      </div>
      <PlaceholderMedia
        label={`Placeholder: ${card.title.toLowerCase()} mockup`}
        className="order-1 aspect-square rounded-none border-0"
      />
    </article>
  );
}

function TestimonialSection() {
  return (
    <LandingSection className="bg-surface-1 py-16 sm:py-24 lg:py-28">
      <blockquote className="mx-auto max-w-4xl rounded-lg border border-border/60 bg-card p-8 text-center sm:p-10">
        <p className="mx-auto max-w-3xl text-balance text-2xl font-semibold leading-9 text-foreground sm:text-3xl">
          Before Disburse, I had to sit through my own VODs for hours just to find a few good moments, and most weeks I never got clips posted at all. Now it pulls the hype plays and funny bits for me, and I can post Shorts and TikToks way more often.
        </p>
        <footer className="mt-8 flex flex-col items-center gap-1 text-sm text-muted-foreground">
          <cite className="not-italic font-bold text-foreground">Jake Turner</cite>
          <span>Twitch streamer</span>
          <span>Northlight Gaming</span>
        </footer>
      </blockquote>
    </LandingSection>
  );
}

function FaqSection() {
  return (
    <LandingSection className="bg-background py-16 sm:py-24 lg:py-28">
      <SectionHeader title="Frequently Asked Questions" />
      <div className="mx-auto mt-12 w-full max-w-3xl space-y-2 lg:mt-16">
        {faqs.map((faq) => (
          <details
            key={faq.question}
            className="group rounded-lg border border-border/70 bg-background"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-left text-lg font-bold text-foreground [&::-webkit-details-marker]:hidden">
              <h3 className="text-pretty">{faq.question}</h3>
              <span className="shrink-0 text-muted-foreground">
                <PlusCircle className="size-6 group-open:hidden" />
                <MinusCircle className="hidden size-6 group-open:block" />
              </span>
            </summary>
            <div className="px-5 pb-5 pr-12">
              <p className="text-pretty text-base leading-7 text-muted-foreground">
                {faq.answer}
              </p>
            </div>
          </details>
        ))}
      </div>
    </LandingSection>
  );
}

function FinalCta() {
  return (
    <LandingSection className="relative isolate bg-[linear-gradient(135deg,hsl(var(--surface-2)),hsl(var(--background)))] py-16 sm:py-24 lg:py-28">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <h2 className="text-balance text-4xl font-extrabold leading-tight tracking-tight text-foreground sm:text-5xl">
          Your next batch of clips is ready when you are
        </h2>
        <p className="mt-6 max-w-2xl text-balance text-lg leading-8 text-muted-foreground">
          Stop digging through long VODs. Get ready-to-post Shorts and TikToks from your best stream moments in minutes.
        </p>
        <div className="mt-10">
          <PrimaryCta />
        </div>
      </div>
    </LandingSection>
  );
}

function LandingSection({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('px-5', className)}>
      <div className="mx-auto w-full max-w-5xl">{children}</div>
    </section>
  );
}

function SectionHeader({
  title,
  description
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
      <h2 className="text-balance text-4xl font-extrabold leading-tight tracking-tight text-foreground sm:text-5xl">
        {title}
      </h2>
      {description ? (
        <p className="mt-6 max-w-2xl text-balance text-lg leading-8 text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}

function PlaceholderMedia({
  label,
  className
}: {
  label: string;
  className?: string;
}) {
  return (
    <figure
      aria-label={label}
      className={cn(
        'relative flex w-full items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-[repeating-linear-gradient(-45deg,hsla(0,0%,100%,0.95),hsla(0,0%,100%,0.95)_10px,hsla(0,0%,98%,0.95)_10px,hsla(0,0%,98%,0.95)_20px)]',
        className
      )}
    >
      <div className="relative z-10 flex flex-col items-center gap-3 px-6 text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-white/80 text-gray-300">
          <ImageIcon className="size-9" />
        </span>
        <figcaption className="max-w-56 rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-gray-500">
          {label}
        </figcaption>
      </div>
    </figure>
  );
}

function PrimaryCta() {
  return (
    <Button asChild size="lg" className="rounded-md font-bold">
      <Link href="/sign-up">Start clipping now</Link>
    </Button>
  );
}
