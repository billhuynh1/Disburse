'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Edit3, Loader2, Save } from 'lucide-react';
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
    <div className="rounded-xl border border-border/70 bg-surface-1/80 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-sm text-foreground/90">
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
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{voiceProfile.name}</CardTitle>
            <CardDescription className="mt-2">
              Updated {new Date(voiceProfile.updatedAt).toLocaleDateString()}
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setIsEditing((value) => !value)}
          >
            <Edit3 className="mr-2 h-4 w-4" />
            {isEditing ? 'Close Editor' : 'Edit'}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
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
            className="space-y-4 rounded-xl border border-border/70 bg-surface-1/80 p-4"
          >
            <input
              type="hidden"
              name="voiceProfileId"
              value={voiceProfile.id}
            />

            <div>
              <Label htmlFor={`name-${voiceProfile.id}`} className="mb-2">
                Name
              </Label>
              <Input
                id={`name-${voiceProfile.id}`}
                name="name"
                defaultValue={voiceProfile.name}
                maxLength={100}
                required
              />
            </div>

            <div>
              <Label
                htmlFor={`description-${voiceProfile.id}`}
                className="mb-2"
              >
                Description
              </Label>
              <Textarea
                id={`description-${voiceProfile.id}`}
                name="description"
                rows={3}
                defaultValue={voiceProfile.description || ''}
                maxLength={5000}
                className="min-h-24"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor={`tone-${voiceProfile.id}`} className="mb-2">
                  Tone
                </Label>
                <Input
                  id={`tone-${voiceProfile.id}`}
                  name="tone"
                  defaultValue={voiceProfile.tone || ''}
                  maxLength={100}
                />
              </div>
              <div>
                <Label htmlFor={`audience-${voiceProfile.id}`} className="mb-2">
                  Audience
                </Label>
                <Input
                  id={`audience-${voiceProfile.id}`}
                  name="audience"
                  defaultValue={voiceProfile.audience || ''}
                  maxLength={150}
                />
              </div>
            </div>

            <div>
              <Label htmlFor={`ctaStyle-${voiceProfile.id}`} className="mb-2">
                CTA Style
              </Label>
              <Input
                id={`ctaStyle-${voiceProfile.id}`}
                name="ctaStyle"
                defaultValue={voiceProfile.ctaStyle || ''}
                maxLength={150}
              />
            </div>

            <div>
              <Label
                htmlFor={`writingStyleNotes-${voiceProfile.id}`}
                className="mb-2"
              >
                Writing Style Notes
              </Label>
              <Textarea
                id={`writingStyleNotes-${voiceProfile.id}`}
                name="writingStyleNotes"
                rows={4}
                defaultValue={voiceProfile.writingStyleNotes || ''}
                maxLength={10000}
                className="min-h-24"
              />
            </div>

            <div>
              <Label
                htmlFor={`bannedPhrases-${voiceProfile.id}`}
                className="mb-2"
              >
                Banned Phrases
              </Label>
              <Textarea
                id={`bannedPhrases-${voiceProfile.id}`}
                name="bannedPhrases"
                rows={4}
                defaultValue={voiceProfile.bannedPhrases || ''}
                maxLength={10000}
                className="min-h-24"
              />
            </div>

            <div>
              <Label htmlFor={`prompt-${voiceProfile.id}`} className="mb-2">
                Prompt Guidance
              </Label>
              <Textarea
                id={`prompt-${voiceProfile.id}`}
                name="prompt"
                rows={5}
                defaultValue={voiceProfile.prompt}
                maxLength={20000}
                required
                className="min-h-28"
              />
            </div>

            {state.error && <FormMessage tone="error">{state.error}</FormMessage>}
            {state.success && (
              <FormMessage tone="success">{state.success}</FormMessage>
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
                  <Save className="mr-2 h-4 w-4" />
                  Save Voice Profile
                </>
              )}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
