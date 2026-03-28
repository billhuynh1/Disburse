import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { ArrowRight } from 'lucide-react';
import { listProjects } from '@/lib/db/queries';
import { ProjectCreateForm } from './project-create-form';

export default async function ProjectsPage() {
  const projects = await listProjects();

  return (
    <section className="flex-1 p-4 lg:p-8">
      <div className="mb-8">
        <h1 className="text-lg font-medium text-foreground lg:text-2xl">
          Projects
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground lg:text-base">
          Projects organize your source assets, transcripts, content packs, and
          generated outputs in one place.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <div>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Your Projects</CardTitle>
              <CardDescription>
                {projects.length === 0
                  ? 'Create your first project to start organizing source material and repurposing work.'
                  : `${projects.length} project${projects.length === 1 ? '' : 's'} in your account.`}
              </CardDescription>
            </CardHeader>
          </Card>

          {projects.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {projects.map((project) => (
                <Link key={project.id} href={`/dashboard/projects/${project.id}`}>
                  <Card className="h-full transition-colors hover:border-primary/35">
                    <CardHeader>
                      <CardTitle>{project.name}</CardTitle>
                      <CardDescription>
                        Updated {new Date(project.updatedAt).toLocaleDateString()}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="mb-4 text-sm text-muted-foreground">
                        {project.description || 'No project description yet.'}
                      </p>
                      <p className="flex items-center text-sm font-medium text-primary">
                        Open project
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>No projects yet</CardTitle>
                <CardDescription>
                  Use the form to create a project for source assets and future
                  content pack workflows.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </div>

        <div>
          <ProjectCreateForm />
        </div>
      </div>
    </section>
  );
}
