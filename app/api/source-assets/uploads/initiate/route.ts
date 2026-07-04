import { getUser } from '@/lib/db/queries';
import { createInitiateSourceAssetUploadRoute } from '@/lib/disburse/source-asset-upload-route-handlers';
import {
  initiateSourceAssetUpload,
  initiateSourceAssetUploadSchema,
} from '@/lib/disburse/source-asset-upload-service';

export const POST = createInitiateSourceAssetUploadRoute({
  action: initiateSourceAssetUpload,
  getUser,
  schema: initiateSourceAssetUploadSchema,
});
