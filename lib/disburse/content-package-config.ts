export const CONTENT_PACKAGE_VALUES = [
  'clips_only',
  'clips_x_posts',
  'clips_linkedin_posts',
  'full_content_pack'
] as const;

export type ContentPackageValue = (typeof CONTENT_PACKAGE_VALUES)[number];

export const DEFAULT_CONTENT_PACKAGE: ContentPackageValue = 'clips_only';
export const X_POST_ASSET_TYPE = 'x_post';
export const LINKEDIN_POST_ASSET_TYPE = 'linkedin_post';
export const PACKAGE_GENERATED_ASSET_TYPES = [
  X_POST_ASSET_TYPE,
  LINKEDIN_POST_ASSET_TYPE
] as const;

export function isContentPackageValue(value: string): value is ContentPackageValue {
  return CONTENT_PACKAGE_VALUES.includes(value as ContentPackageValue);
}

export function normalizeContentPackage(value: string | null | undefined) {
  if (!value || !isContentPackageValue(value)) {
    return DEFAULT_CONTENT_PACKAGE;
  }

  return value;
}

export function getPackageGeneratedAssetCounts(
  contentPackage: ContentPackageValue
) {
  return {
    [X_POST_ASSET_TYPE]:
      contentPackage === 'clips_x_posts' || contentPackage === 'full_content_pack'
        ? 3
        : 0,
    [LINKEDIN_POST_ASSET_TYPE]:
      contentPackage === 'clips_linkedin_posts' ||
      contentPackage === 'full_content_pack'
        ? 2
        : 0
  };
}

export function packageCreatesGeneratedAssets(contentPackage: ContentPackageValue) {
  const counts = getPackageGeneratedAssetCounts(contentPackage);

  return counts[X_POST_ASSET_TYPE] > 0 || counts[LINKEDIN_POST_ASSET_TYPE] > 0;
}

export function buildContentPackageInstruction(contentPackage: ContentPackageValue) {
  return `Content package: ${contentPackage}`;
}

export function parseContentPackageFromInstructions(
  instructions: string | null | undefined
) {
  const match = instructions?.match(/^Content package:\s*(\S+)/m);

  return normalizeContentPackage(match?.[1]);
}
