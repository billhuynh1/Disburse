'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createVoiceProfile } from '@/lib/disburse/actions';
import { FormMessage } from '@/components/dashboard/dashboard-ui';

type VoiceProfileActionState = {
  error?: string;
  success?: string;
};

export function VoiceProfileCreateForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<
    VoiceProfileActionState,
    FormData
  >(createVoiceProfile, {});

  useEffect(() => {
    if (!state.success) {
      return;
    }

    formRef.current?.reset();
    router.refresh();
  }, [router, state.success]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="max-w-3xl space-y-3 rounded-lg border border-dashed border-border/70 p-4"
    >
      <div>
        <Label htmlFor="name" className="mb-1 text-xs">
          Name
        </Label>
        <Input
          id="name"
          name="name"
          placeholder="Founder brand voice"
          maxLength={100}
          required
          className="h-8 text-xs"
        />
      </div>

      <div>
        <Label htmlFor="description" className="mb-1 text-xs">
          Description
        </Label>
        <Textarea
          id="description"
          name="description"
          rows={2}
          maxLength={5000}
          className="min-h-16 text-xs"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="tone" className="mb-1 text-xs">
            Tone
          </Label>
          <Input
            id="tone"
            name="tone"
            placeholder="Warm, direct, confident"
            maxLength={100}
            className="h-8 text-xs"
          />
        </div>
        <div>
          <Label htmlFor="audience" className="mb-1 text-xs">
            Audience
          </Label>
          <Input
            id="audience"
            name="audience"
            placeholder="Indie creators and consultants"
            maxLength={150}
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="ctaStyle" className="mb-1 text-xs">
          CTA Style
        </Label>
        <Input
          id="ctaStyle"
          name="ctaStyle"
          placeholder="Low-pressure, curious, one-step CTA"
          maxLength={150}
          className="h-8 text-xs"
        />
      </div>

      <div>
        <Label htmlFor="writingStyleNotes" className="mb-1 text-xs">
          Writing Style Notes
        </Label>
        <Textarea
          id="writingStyleNotes"
          name="writingStyleNotes"
          rows={3}
          maxLength={10000}
          className="min-h-16 text-xs"
        />
      </div>

      <div>
        <Label htmlFor="bannedPhrases" className="mb-1 text-xs">
          Banned Phrases
        </Label>
        <Textarea
          id="bannedPhrases"
          name="bannedPhrases"
          rows={3}
          maxLength={10000}
          className="min-h-16 text-xs"
        />
      </div>

      <div>
        <Label htmlFor="prompt" className="mb-1 text-xs">
          Prompt Guidance
        </Label>
        <Textarea
          id="prompt"
          name="prompt"
          rows={4}
          maxLength={20000}
          required
          className="min-h-20 text-xs"
        />
      </div>

      {state.error && <FormMessage tone="error">{state.error}</FormMessage>}
      {state.success && <FormMessage tone="success">{state.success}</FormMessage>}

      <Button type="submit" disabled={isPending} size="sm">
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
        Create profile
      </Button>
    </form>
  );
}
