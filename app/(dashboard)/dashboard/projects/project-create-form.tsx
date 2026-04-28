'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Upload } from 'lucide-react';
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
import { createProject } from '@/lib/disburse/actions';
import { FormMessage } from '@/components/dashboard/dashboard-ui';

type CreateProjectState = {
  error?: string;
  success?: string;
  project?: {
    id: number;
    name: string;
    description: string | null;
  };
};

export function ProjectCreateForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<
    CreateProjectState,
    FormData
  >(createProject, {});

  useEffect(() => {
    if (!state.success) {
      return;
    }

    formRef.current?.reset();
    if (state.project?.id) {
      router.push(`/dashboard/projects/${state.project.id}`);
      return;
    }

    router.refresh();
  }, [router, state.project?.id, state.success]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload video</CardTitle>
        <CardDescription>
          Start a video workspace, then upload the recording on the next screen.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form ref={formRef} action={formAction} className="space-y-4">
          <div>
            <Label htmlFor="name" className="mb-2">
              Video or workspace name
            </Label>
            <Input
              id="name"
              name="name"
              placeholder="Podcast episode, webinar, or video title"
              maxLength={150}
              required
            />
          </div>

          <div>
            <Label htmlFor="description" className="mb-2">
              Notes
            </Label>
            <Textarea
              id="description"
              name="description"
              placeholder="Optional context for this video"
              rows={4}
              maxLength={5000}
              className="min-h-24"
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
                Creating...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Continue to upload
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
