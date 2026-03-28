'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Mic2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { createVoiceProfile } from '@/lib/disburse/actions';

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
    <Card>
      <CardHeader>
        <CardTitle>Create Voice Profile</CardTitle>
        <CardDescription>
          Save reusable creator preferences that future Disburse workflows can
          use for tone, audience, structure, and CTA guidance.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form ref={formRef} action={formAction} className="space-y-4">
          <div>
            <Label htmlFor="name" className="mb-2">
              Name
            </Label>
            <Input
              id="name"
              name="name"
              placeholder="Founder brand voice"
              maxLength={100}
              required
            />
          </div>

          <div>
            <Label htmlFor="description" className="mb-2">
              Description
            </Label>
            <Textarea
              id="description"
              name="description"
              rows={3}
              maxLength={5000}
              className="min-h-24"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="tone" className="mb-2">
                Tone
              </Label>
              <Input
                id="tone"
                name="tone"
                placeholder="Warm, direct, confident"
                maxLength={100}
              />
            </div>
            <div>
              <Label htmlFor="audience" className="mb-2">
                Audience
              </Label>
              <Input
                id="audience"
                name="audience"
                placeholder="Indie creators and consultants"
                maxLength={150}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="ctaStyle" className="mb-2">
              CTA Style
            </Label>
            <Input
              id="ctaStyle"
              name="ctaStyle"
              placeholder="Low-pressure, curious, one-step CTA"
              maxLength={150}
            />
          </div>

          <div>
            <Label htmlFor="writingStyleNotes" className="mb-2">
              Writing Style Notes
            </Label>
            <Textarea
              id="writingStyleNotes"
              name="writingStyleNotes"
              rows={4}
              maxLength={10000}
              className="min-h-24"
            />
          </div>

          <div>
            <Label htmlFor="bannedPhrases" className="mb-2">
              Banned Phrases
            </Label>
            <Textarea
              id="bannedPhrases"
              name="bannedPhrases"
              rows={4}
              maxLength={10000}
              className="min-h-24"
            />
          </div>

          <div>
            <Label htmlFor="prompt" className="mb-2">
              Prompt Guidance
            </Label>
            <Textarea
              id="prompt"
              name="prompt"
              rows={5}
              maxLength={20000}
              required
              className="min-h-28"
            />
          </div>

          {state.error && <p className="text-sm text-red-500">{state.error}</p>}
          {state.success && (
            <p className="text-sm text-green-600">{state.success}</p>
          )}

          <Button
            type="submit"
            disabled={isPending}
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Mic2 className="mr-2 h-4 w-4" />
                Create Voice Profile
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
