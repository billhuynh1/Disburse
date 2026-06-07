import { getUser } from '@/lib/db/queries';
import {
  brandTemplateInputSchema,
  createBrandTemplate,
  deleteBrandTemplate,
  listBrandTemplatesForUser,
  toBrandTemplateView,
  updateBrandTemplate,
} from '@/lib/disburse/brand-template-service';

export async function GET() {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const templates = await listBrandTemplatesForUser(user.id);
    return Response.json({ templates: templates.map(toBrandTemplateView) });
  } catch (error) {
    console.error('Unable to load brand templates.', error);
    return Response.json(
      { error: 'Unable to load brand templates.' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = brandTemplateInputSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json({ error: 'Invalid brand template.' }, { status: 400 });
  }

  try {
    const template = await createBrandTemplate(parsed.data, user);
    return Response.json({ template: toBrandTemplateView(template) }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to create brand template.',
      },
      { status: 400 }
    );
  }
}

export async function PUT(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const templateId = Number(url.searchParams.get('id'));

  if (!Number.isInteger(templateId) || templateId <= 0) {
    return Response.json({ error: 'Invalid brand template id.' }, { status: 400 });
  }

  const parsed = brandTemplateInputSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json({ error: 'Invalid brand template.' }, { status: 400 });
  }

  try {
    const template = await updateBrandTemplate(templateId, parsed.data, user);

    if (!template) {
      return Response.json({ error: 'Brand template not found.' }, { status: 404 });
    }

    return Response.json({ template: toBrandTemplateView(template) });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to update brand template.',
      },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const templateId = Number(new URL(request.url).searchParams.get('id'));

  if (!Number.isInteger(templateId) || templateId <= 0) {
    return Response.json({ error: 'Invalid brand template id.' }, { status: 400 });
  }

  try {
    const template = await deleteBrandTemplate(templateId, user.id);

    if (!template) {
      return Response.json({ error: 'Brand template not found.' }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to delete brand template.',
      },
      { status: 400 }
    );
  }
}
