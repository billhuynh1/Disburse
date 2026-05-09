import 'server-only';

import type { LinkedAccount } from '@/lib/db/schema';

export const SUPPORTED_SOCIAL_ACCOUNT_PLATFORMS = ['youtube', 'tiktok'] as const;
export const SUPPORTED_PUBLISH_PLATFORMS = ['youtube', 'tiktok'] as const;

export type SupportedSocialAccountPlatform =
  (typeof SUPPORTED_SOCIAL_ACCOUNT_PLATFORMS)[number];
export type SupportedPublishPlatform =
  (typeof SUPPORTED_PUBLISH_PLATFORMS)[number];

function parseBooleanEnvVar(name: string) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function isSupportedSocialAccountPlatform(
  value: string
): value is SupportedSocialAccountPlatform {
  return SUPPORTED_SOCIAL_ACCOUNT_PLATFORMS.includes(
    value as SupportedSocialAccountPlatform
  );
}

export function isSupportedPublishPlatform(
  value: string
): value is SupportedPublishPlatform {
  return SUPPORTED_PUBLISH_PLATFORMS.includes(
    value as SupportedPublishPlatform
  );
}

export function isPlatformPublishEnabled(platform: SupportedPublishPlatform) {
  if (platform === 'youtube') {
    return true;
  }

  return parseBooleanEnvVar('ENABLE_TIKTOK_PUBLISH');
}

export function isLinkedAccountExpired(
  account: Pick<LinkedAccount, 'expiresAt'>
) {
  return Boolean(account.expiresAt && account.expiresAt <= new Date());
}

export function getLinkedAccountPublishBlockedReason(
  account: Pick<LinkedAccount, 'platform' | 'accessToken' | 'expiresAt'>
) {
  if (!isSupportedSocialAccountPlatform(account.platform)) {
    return 'This social platform is not supported in the current MVP.';
  }

  if (!account.accessToken.trim()) {
    return 'Reconnect this account before publishing.';
  }

  if (
    isSupportedPublishPlatform(account.platform) &&
    !isPlatformPublishEnabled(account.platform)
  ) {
    return `${formatPlatformLabel(account.platform)} publishing is not enabled in this environment yet.`;
  }

  if (isLinkedAccountExpired(account)) {
    return 'This account needs to be reconnected before publishing.';
  }

  return null;
}

export function isLinkedAccountPublishable(
  account: Pick<LinkedAccount, 'platform' | 'accessToken' | 'expiresAt'>
) {
  return getLinkedAccountPublishBlockedReason(account) === null;
}

export function formatPlatformLabel(platform: string) {
  if (platform === 'youtube') {
    return 'YouTube';
  }

  if (platform === 'tiktok') {
    return 'TikTok';
  }

  return platform.replaceAll('_', ' ');
}
