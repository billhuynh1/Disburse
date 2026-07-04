type CreateUploadHandlerDeps<TSchema, TResult, TUser extends { id: number }> = {
  action: (input: TSchema, user: TUser) => Promise<TResult>;
  defaultErrorMessage: string;
  getUser: () => Promise<TUser | null>;
  invalidMessage: string;
  notFoundMessage?: string;
  responseMessage?: (message: string) => string;
  schema: {
    safeParse: (
      value: unknown
    ) =>
      | { success: true; data: TSchema }
      | { success: false; error: { errors: Array<{ message?: string }> } };
  };
};

function createUploadRouteHandler<
  TSchema,
  TResult,
  TUser extends { id: number }
>(
  deps: CreateUploadHandlerDeps<TSchema, TResult, TUser>
) {
  return async function POST(request: Request) {
    const user = await deps.getUser();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const parsedBody = deps.schema.safeParse(body);

    if (!parsedBody.success) {
      return Response.json(
        {
          error:
            parsedBody.error.errors[0]?.message || deps.invalidMessage,
        },
        { status: 400 }
      );
    }

    try {
      return Response.json(await deps.action(parsedBody.data, user));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : deps.defaultErrorMessage;
      const status = message === deps.notFoundMessage ? 404 : 400;

      return Response.json(
        {
          error: deps.responseMessage ? deps.responseMessage(message) : message,
        },
        { status }
      );
    }
  };
}

export function createInitiateSourceAssetUploadRoute<
  TSchema,
  TResult,
  TUser extends { id: number }
>(
  deps: Omit<
    CreateUploadHandlerDeps<TSchema, TResult, TUser>,
    'defaultErrorMessage' | 'invalidMessage' | 'notFoundMessage' | 'responseMessage'
  >
) {
  return createUploadRouteHandler({
    defaultErrorMessage: 'Failed to initiate upload.',
    invalidMessage: 'Invalid upload request.',
    notFoundMessage: 'Project not found.',
    responseMessage: (message) =>
      message === 'Project not found.'
        ? message
        : 'Unable to start this upload right now.',
    ...deps,
  });
}

export function createAcknowledgeSourceAssetUploadPartRoute<
  TSchema,
  TResult,
  TUser extends { id: number }
>(
  deps: Omit<
    CreateUploadHandlerDeps<TSchema, TResult, TUser>,
    'defaultErrorMessage' | 'invalidMessage' | 'notFoundMessage'
  >
) {
  return createUploadRouteHandler({
    defaultErrorMessage: 'Failed to acknowledge part.',
    invalidMessage: 'Invalid part acknowledgement.',
    notFoundMessage: 'Upload session not found.',
    ...deps,
  });
}
