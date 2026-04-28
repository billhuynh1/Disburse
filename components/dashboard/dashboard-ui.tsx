import * as React from 'react';
import { cn } from '@/lib/utils';
import { getWorkflowStatusClasses } from '@/lib/disburse/presentation';

export function DashboardPageShell({
  className,
  ...props
}: React.ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
        className
      )}
      {...props}
    />
  );
}

export function FocusedWorkspace({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('mx-auto w-full max-w-6xl space-y-10', className)}
      {...props}
    />
  );
}

export function DashboardPageHeader({
  title,
  description,
  children,
  className
}: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'relative mb-8 overflow-hidden rounded-2xl border border-border/70 bg-[linear-gradient(135deg,hsl(var(--surface-1)),hsl(var(--card))_52%,hsl(var(--shell)))] p-5 shadow-[0_24px_80px_rgba(2,6,23,0.28)] sm:flex sm:items-end sm:justify-between sm:gap-4 lg:p-7',
        className
      )}
    >
      <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute bottom-0 right-1/4 h-px w-1/2 bg-[linear-gradient(90deg,transparent,hsl(var(--primary)/0.45),transparent)]" />
      <div className="relative min-w-0">
        <div className="mb-3 h-1 w-12 rounded-full bg-primary" />
        <h1 className="text-2xl font-semibold tracking-normal text-foreground lg:text-3xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground lg:text-base">
            {description}
          </p>
        ) : null}
      </div>
      {children ? <div className="relative shrink-0">{children}</div> : null}
    </div>
  );
}

export function WorkflowStatusBadge({
  status,
  className
}: {
  status: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize ring-1 ring-inset',
        getWorkflowStatusClasses(status),
        className
      )}
    >
      {status.replaceAll('_', ' ')}
    </span>
  );
}

export function WorkflowPanel({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-1)),hsl(var(--card)))] p-4 shadow-[0_12px_34px_rgba(5,8,22,0.16)]',
        className
      )}
      {...props}
    />
  );
}

export function WorkspaceSection({
  eyebrow,
  title,
  description,
  children,
  className
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-4', className)}>
      <div>
        {eyebrow ? (
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="mt-2 text-xl font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function MetricTile({
  label,
  value,
  detail,
  className
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-1)),hsl(var(--card)))] p-4 shadow-[0_16px_45px_rgba(2,6,23,0.18)]',
        className
      )}
    >
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-3 text-2xl font-semibold text-foreground">{value}</div>
      {detail ? (
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}

export function WorkflowStage({
  label,
  status,
  active = false
}: {
  label: string;
  status?: string;
  active?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
          active
            ? 'border-primary/60 bg-primary/15 text-primary shadow-[0_0_24px_hsl(var(--primary)/0.2)]'
            : 'border-border/70 bg-surface-1 text-muted-foreground'
        )}
      >
        {active ? '•' : ''}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        {status ? (
          <p className="truncate text-xs capitalize text-muted-foreground">
            {status.replaceAll('_', ' ')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  className
}: {
  title?: string;
  description: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-dashed border-border/80 bg-surface-1/70 p-6 text-center',
        className
      )}
    >
      {title ? (
        <p className="text-sm font-medium text-foreground">{title}</p>
      ) : null}
      <p className={cn('text-sm leading-6 text-muted-foreground', title && 'mt-1')}>
        {description}
      </p>
    </div>
  );
}

export function FormMessage({
  tone = 'neutral',
  children
}: {
  tone?: 'neutral' | 'success' | 'error';
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        'text-sm leading-6',
        tone === 'success' && 'text-emerald-300',
        tone === 'error' && 'text-red-300',
        tone === 'neutral' && 'text-muted-foreground'
      )}
    >
      {children}
    </p>
  );
}
