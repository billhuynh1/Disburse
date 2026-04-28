'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

function Collapsible({
  className,
  defaultOpen = false,
  children,
  ...props
}: React.ComponentProps<'details'> & {
  defaultOpen?: boolean;
}) {
  return (
    <details
      data-slot="collapsible"
      className={cn('group rounded-xl border border-border/70 bg-background/50', className)}
      open={defaultOpen}
      {...props}
    >
      {children}
    </details>
  );
}

function CollapsibleTrigger({
  className,
  children,
  hideIcon = false,
  ...props
}: React.ComponentProps<'summary'> & {
  hideIcon?: boolean;
}) {
  return (
    <summary
      data-slot="collapsible-trigger"
      className={cn(
        'flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-medium text-foreground marker:hidden transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden',
        className
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {hideIcon ? null : (
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
      )}
    </summary>
  );
}

function CollapsibleContent({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="collapsible-content"
      className={cn('px-4 pb-4', className)}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
