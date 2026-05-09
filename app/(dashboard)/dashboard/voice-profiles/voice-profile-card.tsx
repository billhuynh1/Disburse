'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Edit3, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { updateVoiceProfile } from '@/lib/disburse/actions';
import { VoiceProfile } from '@/lib/db/schema';
import { FormMessage } from '@/components/dashboard/dashboard-ui';

type VoiceProfileActionState = {
  error?: string;
  success?: string;
};

function DetailBlock({
  label,
  value
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-background/25 p-2.5">
      <p className="text-[10px] font-medium uppercase text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-xs leading-5 text-foreground/90">
        {value || 'Not set yet.'}
      </p>
    </div>
  );
}

export function VoiceProfileCard({
  voiceProfile
}: {
  voiceProfile: VoiceProfile;
}) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [state, formAction, isPending] = useActionState<
    VoiceProfileActionState,
    FormData
  >(updateVoiceProfile, {});

  useEffect(() => {
    if (!state.success) {
      return;
    }

    setIsEditing(false);
    router.refresh();
  }, [router, state.success]);

  return (
    <div className="py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {voiceProfile.name}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Updated {new Date(voiceProfile.updatedAt).toLocaleDateString()}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsEditing((value) => !value)}
        >
          <Edit3 className="h-4 w-4" />
          {isEditing ? 'Close' : 'Edit'}
        </Button>
      </div>

      <div className="mt-3 space-y-3">
        <div className="grid gap-2 md:grid-cols-2">
          <DetailBlock label="Tone" value={voiceProfile.tone} />
          <DetailBlock label="Audience" value={voiceProfile.audience} />
          <DetailBlock label="CTA Style" value={voiceProfile.ctaStyle} />
          <DetailBlock label="Description" value={voiceProfile.description} />
        </div>

        <DetailBlock
          label="Writing Style Notes"
          value={voiceProfile.writingStyleNotes}
        />
        <DetailBlock label="Banned Phrases" value={voiceProfile.bannedPhrases} />
        <DetailBlock label="Prompt Guidance" value={voiceProfile.prompt} />

        {isEditing ? (
          <form
            action={formAction}
            className="space-y-3 rounded-lg border border-dashed border-border/70 p-4"
          >
            <input
              type="hidden"
              name="voiceProfileId"
              value={voiceProfile.id}
            />

            <div>
              <Label htmlFor={`name-${voiceProfile.id}`} className="mb-1 text-xs">
                Name
              </Label>
              <Input
                id={`name-${voiceProfile.id}`}
                name="name"
                defaultValue={voiceProfile.name}
                maxLength={100}
                required
                className="h-8 text-xs"
              />
            </div>

            <div>
              <Label
                htmlFor={`description-${voiceProfile.id}`}
                className="mb-1 text-xs"
              >
                Description
              </Label>
              <Textarea
                id={`description-${voiceProfile.id}`}
                name="description"
                rows={2}
                defaultValue={voiceProfile.description || ''}
                maxLength={5000}
                className="min-h-16 text-xs"
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label
                  htmlFor={`tone-${voiceProfile.id}`}
                  className="mb-1 text-xs"
                >
                  Tone
                </Label>
                <Input
                  id={`tone-${voiceProfile.id}`}
                  name="tone"
                  defaultValue={voiceProfile.tone || ''}
                  maxLength={100}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <Label
                  htmlFor={`audience-${voiceProfile.id}`}
                  className="mb-1 text-xs"
                >
                  Audience
                </Label>
                <Input
                  id={`audience-${voiceProfile.id}`}
                  name="audience"
                  defaultValue={voiceProfile.audience || ''}
                  maxLength={150}
                  className="h-8 text-xs"
                />
              </div>
            </div>

            <div>
              <Label
                htmlFor={`ctaStyle-${voiceProfile.id}`}
                className="mb-1 text-xs"
              >
                CTA Style
              </Label>
              <Input
                id={`ctaStyle-${voiceProfile.id}`}
                name="ctaStyle"
                defaultValue={voiceProfile.ctaStyle || ''}
                maxLength={150}
                className="h-8 text-xs"
              />
            </div>

            <div>
              <Label
                htmlFor={`writingStyleNotes-${voiceProfile.id}`}
                className="mb-1 text-xs"
              >
                Writing Style Notes
              </Label>
              <Textarea
                id={`writingStyleNotes-${voiceProfile.id}`}
                name="writingStyleNotes"
                rows={3}
                defaultValue={voiceProfile.writingStyleNotes || ''}
                maxLength={10000}
                className="min-h-16 text-xs"
              />
            </div>

            <div>
              <Label
                htmlFor={`bannedPhrases-${voiceProfile.id}`}
                className="mb-1 text-xs"
              >
                Banned Phrases
              </Label>
              <Textarea
                id={`bannedPhrases-${voiceProfile.id}`}
                name="bannedPhrases"
                rows={3}
                defaultValue={voiceProfile.bannedPhrases || ''}
                maxLength={10000}
                className="min-h-16 text-xs"
              />
            </div>

            <div>
              <Label htmlFor={`prompt-${voiceProfile.id}`} className="mb-1 text-xs">
                Prompt Guidance
              </Label>
              <Textarea
                id={`prompt-${voiceProfile.id}`}
                name="prompt"
                rows={4}
                defaultValue={voiceProfile.prompt}
                maxLength={20000}
                required
                className="min-h-20 text-xs"
              />
            </div>

            {state.error && <FormMessage tone="error">{state.error}</FormMessage>}
            {state.success && (
              <FormMessage tone="success">{state.success}</FormMessage>
            )}

            <Button type="submit" disabled={isPending} size="sm">
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save profile
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
