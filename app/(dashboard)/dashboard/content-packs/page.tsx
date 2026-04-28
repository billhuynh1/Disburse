import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  DashboardPageHeader,
  DashboardPageShell,
  EmptyState
} from '@/components/dashboard/dashboard-ui';
import { listContentPacks } from '@/lib/db/queries';
import { ContentPackCard } from '../content-pack-card';

export default async function ContentPacksPage() {
  const contentPacks = await listContentPacks();

  return (
    <DashboardPageShell>
      <DashboardPageHeader
        title="Content Packs"
        description={
          <>
          Content packs connect a project and source asset to the repurposed
          outputs you will eventually generate from that source.
          </>
        }
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Your Content Packs</CardTitle>
          <CardDescription>
            {contentPacks.length === 0
              ? 'Create a content pack from a project to start structuring repurposed outputs.'
              : `${contentPacks.length} content pack${contentPacks.length === 1 ? '' : 's'} ready for future repurposing runs.`}
          </CardDescription>
        </CardHeader>
      </Card>

      {contentPacks.length > 0 ? (
        <div className="space-y-4">
          {contentPacks.map((contentPack) => (
            <ContentPackCard
              key={contentPack.id}
              projectId={contentPack.project?.id}
              contentPack={contentPack}
              showProjectName
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No content packs yet"
          description="Create a content pack from a project detail page after adding a source asset."
        />
      )}
    </DashboardPageShell>
  );
}
