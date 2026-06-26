'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { signIn, signUp } from './actions';
import { ActionState } from '@/lib/auth/middleware';

const fieldBackgroundClassName =
  'border-border/60 bg-transparent shadow-none focus-visible:border-ring/50 focus-visible:ring-ring/20';
const labelClassName =
  'text-sm font-medium tracking-normal text-muted-foreground';

export function Login({ mode = 'signin' }: { mode?: 'signin' | 'signup' }) {
  const searchParams = useSearchParams();
  const redirect = searchParams.get('redirect');
  const priceId = searchParams.get('priceId');
  const inviteId = searchParams.get('inviteId');
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    mode === 'signin' ? signIn : signUp,
    { error: '' }
  );
  const switchParams = new URLSearchParams(searchParams.toString());
  const switchPath = mode === 'signin' ? '/sign-up' : '/sign-in';
  const switchHref = switchParams.size
    ? `${switchPath}?${switchParams.toString()}`
    : switchPath;
  const isSignIn = mode === 'signin';

  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-5 py-10 text-foreground sm:px-6 sm:py-14">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,hsl(var(--surface-2)),hsl(var(--background)))]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[28rem] bg-[radial-gradient(ellipse_at_top,hsl(var(--glow-primary)/0.16),transparent_62%)]" />

      <div className="relative w-full max-w-md">
        <Link
          href="/"
          className="mx-auto flex w-fit items-center gap-2 text-sm font-bold tracking-tight text-foreground transition-opacity hover:opacity-75"
        >
          <span className="grid size-6 grid-cols-2 gap-0.5 rounded-md border border-border bg-surface-1 p-1">
            <span className="rounded-[2px] bg-foreground" />
            <span className="rounded-[2px] bg-muted-foreground" />
            <span className="rounded-[2px] bg-muted-foreground" />
            <span className="rounded-[2px] bg-foreground" />
          </span>
          Disburse
        </Link>

        <div className="mt-10 text-center">
          <p className="text-sm font-medium text-muted-foreground">
            {isSignIn ? 'Welcome back' : 'Start creating more from every recording'}
          </p>
          <h1 className="mt-4 text-balance text-4xl font-extrabold leading-tight tracking-tight text-foreground sm:text-5xl">
            {isSignIn ? 'Sign in to Disburse' : 'Create your Disburse account'}
          </h1>
          <p className="mx-auto mt-4 max-w-sm text-pretty text-base leading-7 text-muted-foreground">
            {isSignIn
              ? 'Pick up where you left off and keep your content workflow moving.'
              : 'Turn one long-form recording into content ready for every channel.'}
          </p>
        </div>

        <Card className="relative mt-10 overflow-hidden border-border/70 bg-surface-1 shadow-[0_20px_50px_rgba(0,0,0,0.32)]">
          <CardContent className="p-6 sm:p-8">
            <form className="space-y-6" action={formAction}>
              <input type="hidden" name="redirect" value={redirect || ''} />
              <input type="hidden" name="priceId" value={priceId || ''} />
              <input type="hidden" name="inviteId" value={inviteId || ''} />
              <div className="space-y-1.5">
                <Label htmlFor="email" className={labelClassName}>
                  Email
                </Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  defaultValue={state.email}
                  required
                  maxLength={50}
                  placeholder="Enter your email"
                  className={fieldBackgroundClassName}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className={labelClassName}>
                  Password
                </Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={
                    mode === 'signin' ? 'current-password' : 'new-password'
                  }
                  defaultValue={state.password}
                  required
                  minLength={8}
                  maxLength={100}
                  placeholder="Enter your password"
                  className={fieldBackgroundClassName}
                />
              </div>

              {state?.error && (
                <div className="text-sm text-danger">{state.error}</div>
              )}

              <Button type="submit" className="w-full" disabled={pending}>
                {pending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading...
                  </>
                ) : mode === 'signin' ? (
                  'Sign in'
                ) : (
                  'Sign up'
                )}
              </Button>
            </form>

            <div className="mt-8 border-t border-border/70 pt-6 text-center">
              <p className="text-sm text-muted-foreground">
                {isSignIn ? 'New to Disburse?' : 'Already have an account?'}
              </p>
              <div className="mt-3">
                <Button asChild variant="outline" className="w-full">
                  <Link href={switchHref}>
                    {isSignIn
                      ? 'Create an account'
                      : 'Sign in to existing account'}
                  </Link>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
