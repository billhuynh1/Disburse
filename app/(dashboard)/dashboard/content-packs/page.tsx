import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { listContentPacks } from '@/lib/db/queries';
import { ContentPackCard } from '../content-pack-card';

export default async function ContentPacksPage() {
  const contentPacks = await listContentPacks();

  return (
    <section className="flex-1 p-4 lg:p-8">
      <div className="mb-8">
        <h1 className="text-lg font-medium text-foreground lg:text-2xl">
          Content Packs
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground lg:text-base">
          Content packs connect a project and source asset to the repurposed
          outputs you will eventually generate from that source.
        </p>
      </div>

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
        <Card>
          <CardHeader>
            <CardTitle>No content packs yet</CardTitle>
            <CardDescription>
              Create a content pack from a project detail page after adding a
              source asset.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </section>
  );
}
