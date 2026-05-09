import { listVoiceProfiles } from '@/lib/db/queries';
import { VoiceProfileCard } from './voice-profile-card';
import { VoiceProfileCreateForm } from './voice-profile-create-form';
import {
  DashboardPageShell,
  EmptyState
} from '@/components/dashboard/dashboard-ui';

export default async function VoiceProfilesPage() {
  const voiceProfiles = await listVoiceProfiles();

  return (
    <DashboardPageShell>
      <div className="mb-6 max-w-2xl">
        <h1 className="text-3xl font-semibold text-foreground">Voice Profiles</h1>
        <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
          Voice profiles capture reusable creator preferences that future
          Disburse workflows can use for tone, formatting, and CTA direction.
        </p>
      </div>

      <div className="max-w-4xl space-y-10">
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground">Create profile</h2>
          <VoiceProfileCreateForm />
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Profiles ({voiceProfiles.length})
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {voiceProfiles.length === 0
                ? 'Create your first reusable writing profile.'
                : `${voiceProfiles.length} saved for future content workflows.`}
            </p>
          </div>

          {voiceProfiles.length > 0 ? (
            <div className="max-w-3xl divide-y divide-border/60 border-y border-border/60">
              {voiceProfiles.map((voiceProfile) => (
                <VoiceProfileCard
                  key={voiceProfile.id}
                  voiceProfile={voiceProfile}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title="No voice profiles yet"
              description="Save tone, audience, banned phrases, and CTA preferences here so later Disburse workflows can reuse them consistently."
            />
          )}
        </section>
      </div>
    </DashboardPageShell>
  );
}
