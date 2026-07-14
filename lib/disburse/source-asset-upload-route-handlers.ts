import {
  SourceUploadCompletionInProgressError,
} from './source-asset-upload-service-core.ts';
import {
  SOURCE_UPLOAD_COMPLETION_IN_PROGRESS_CODE,
  SOURCE_UPLOAD_COMPLETION_IN_PROGRESS_MESSAGE,
  SOURCE_UPLOAD_COMPLETION_RETRY_AFTER_SECONDS,
} from './source-upload-completion-contract.ts';

type CreateUploadHandlerDeps<TSchema, TResult, TUser extends { id: number }> = {
  action: (input: TSchema, user: TUser) => Promise<TResult>;
  defaultErrorMessage: string;
  getUser: () => Promise<TUser | null>;
  invalidMessage: string;
  notFoundMessage?: string;
  responseMessage?: (message: string) => string;
  errorResponse?: (error: unknown) => Response | null;
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
      const classifiedResponse = deps.errorResponse?.(error);
      if (classifiedResponse) return classifiedResponse;

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

export function createCompleteSourceAssetUploadRoute<
  TSchema,
  TResult,
  TUser extends { id: number }
>(
  deps: Omit<
    CreateUploadHandlerDeps<TSchema, TResult, TUser>,
    | 'defaultErrorMessage'
    | 'invalidMessage'
    | 'notFoundMessage'
    | 'responseMessage'
    | 'errorResponse'
  >
) {
  return createUploadRouteHandler({
    defaultErrorMessage: 'Failed to complete upload.',
    invalidMessage: 'Invalid upload completion request.',
    notFoundMessage: 'Project not found.',
    responseMessage: (message) =>
      message === 'Project not found.'
        ? message
        : 'Unable to finish this upload right now.',
    errorResponse: (error) => {
      if (
        !(error instanceof SourceUploadCompletionInProgressError) ||
        error.code !== SOURCE_UPLOAD_COMPLETION_IN_PROGRESS_CODE
      ) {
        return null;
      }

      return Response.json(
        {
          error: SOURCE_UPLOAD_COMPLETION_IN_PROGRESS_MESSAGE,
          code: SOURCE_UPLOAD_COMPLETION_IN_PROGRESS_CODE,
          retryable: true,
        },
        {
          status: 409,
          headers: {
            'Retry-After': String(SOURCE_UPLOAD_COMPLETION_RETRY_AFTER_SECONDS),
          },
        }
      );
    },
    ...deps,
  });
}
