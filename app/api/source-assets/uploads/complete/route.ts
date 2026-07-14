import { getUser } from '@/lib/db/queries';
import {
  completeSourceAssetUpload,
  completeSourceAssetUploadSchema,
} from '@/lib/disburse/source-asset-upload-service';
import { createCompleteSourceAssetUploadRoute } from '@/lib/disburse/source-asset-upload-route-handlers';

export const POST = createCompleteSourceAssetUploadRoute({
  getUser,
  action: completeSourceAssetUpload,
  schema: completeSourceAssetUploadSchema,
});
