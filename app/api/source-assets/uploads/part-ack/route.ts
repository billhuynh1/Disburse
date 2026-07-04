import { getUser } from '@/lib/db/queries';
import { createAcknowledgeSourceAssetUploadPartRoute } from '@/lib/disburse/source-asset-upload-route-handlers';
import {
  acknowledgeSourceAssetUploadPart,
  sourceAssetUploadPartAckSchema,
} from '@/lib/disburse/source-asset-upload-service';

export const POST = createAcknowledgeSourceAssetUploadPartRoute({
  action: acknowledgeSourceAssetUploadPart,
  getUser,
  schema: sourceAssetUploadPartAckSchema,
});
