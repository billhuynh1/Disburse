import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { listVoiceProfiles } from '@/lib/db/queries';
import { VoiceProfileCard } from './voice-profile-card';
import { VoiceProfileCreateForm } from './voice-profile-create-form';

export default async function VoiceProfilesPage() {
  const voiceProfiles = await listVoiceProfiles();

  return (
    <section className="flex-1 p-4 lg:p-8">
      <div className="mb-8">
        <h1 className="text-lg font-medium text-foreground lg:text-2xl">
          Voice Profiles
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground lg:text-base">
          Voice profiles capture reusable creator preferences that future
          Disburse workflows can use for tone, formatting, and CTA direction.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div>
          <VoiceProfileCreateForm />
        </div>

        <div>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Your Voice Profiles</CardTitle>
              <CardDescription>
                {voiceProfiles.length === 0
                  ? 'Create your first voice profile to save creator-specific writing preferences.'
                  : `${voiceProfiles.length} voice profile${voiceProfiles.length === 1 ? '' : 's'} saved for future content workflows.`}
              </CardDescription>
            </CardHeader>
          </Card>

          {voiceProfiles.length > 0 ? (
            <div className="space-y-4">
              {voiceProfiles.map((voiceProfile) => (
                <VoiceProfileCard
                  key={voiceProfile.id}
                  voiceProfile={voiceProfile}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>No voice profiles yet</CardTitle>
                <CardDescription>
                  Save tone, audience, banned phrases, and CTA preferences here
                  so later Disburse workflows can reuse them consistently.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </div>
      </div>
    </section>
  );
}
