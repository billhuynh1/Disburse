import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { listVoiceProfiles } from '@/lib/db/queries';
import { VoiceProfileCard } from './voice-profile-card';
import { VoiceProfileCreateForm } from './voice-profile-create-form';
import {
  DashboardPageHeader,
  DashboardPageShell,
  EmptyState
} from '@/components/dashboard/dashboard-ui';

export default async function VoiceProfilesPage() {
  const voiceProfiles = await listVoiceProfiles();

  return (
    <DashboardPageShell>
      <DashboardPageHeader
        title="Voice Profiles"
        description={
          <>
          Voice profiles capture reusable creator preferences that future
          Disburse workflows can use for tone, formatting, and CTA direction.
          </>
        }
      />

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
            <EmptyState
              title="No voice profiles yet"
              description="Save tone, audience, banned phrases, and CTA preferences here so later Disburse workflows can reuse them consistently."
            />
          )}
        </div>
      </div>
    </DashboardPageShell>
  );
}
