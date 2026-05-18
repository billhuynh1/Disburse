import {
  ContentPackKind,
  FacecamDetectionStatus,
  SourceAssetType,
} from '../db/schema.ts';

export const TERMINAL_FACECAM_DETECTION_STATUSES = new Set<string>([
  FacecamDetectionStatus.READY,
  FacecamDetectionStatus.NOT_FOUND,
  FacecamDetectionStatus.FAILED_TIMEOUT,
  FacecamDetectionStatus.FAILED_ABORTED,
  FacecamDetectionStatus.FAILED_NETWORK,
  FacecamDetectionStatus.FAILED_HTTP,
  FacecamDetectionStatus.FAILED_INVALID_RESPONSE,
  FacecamDetectionStatus.FAILED,
]);

export function isUploadedVideoSource(sourceAsset: {
  assetType: string;
  mimeType?: string | null;
}) {
  return (
    sourceAsset.assetType === SourceAssetType.UPLOADED_FILE &&
    (!sourceAsset.mimeType || sourceAsset.mimeType.startsWith('video/'))
  );
}

export function requiresFacecamDetectionBeforeRender(params: {
  contentPackKind: string;
  sourceAsset: {
    assetType: string;
    mimeType?: string | null;
  };
}) {
  return (
    params.contentPackKind === ContentPackKind.SHORT_FORM_CLIPS &&
    isUploadedVideoSource(params.sourceAsset)
  );
}

export function canRenderAfterFacecamDetection(status: string) {
  return TERMINAL_FACECAM_DETECTION_STATUSES.has(status);
}

export function assertCanRenderAfterFacecamDetection(params: {
  contentPackKind: string;
  sourceAsset: {
    assetType: string;
    mimeType?: string | null;
  };
  facecamDetectionStatus: string;
}) {
  if (
    requiresFacecamDetectionBeforeRender(params) &&
    !canRenderAfterFacecamDetection(params.facecamDetectionStatus)
  ) {
    throw new Error(
      'Facecam detection must finish before rendering this uploaded video clip.'
    );
  }
}
