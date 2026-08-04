const ISO_LANGUAGE_ALIASES: Record<string, string> = {
  arabic: 'ar',
  chinese: 'zh',
  dutch: 'nl',
  english: 'en',
  french: 'fr',
  german: 'de',
  hindi: 'hi',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  polish: 'pl',
  portuguese: 'pt',
  russian: 'ru',
  spanish: 'es',
  swedish: 'sv',
  turkish: 'tr',
  ukrainian: 'uk',
  vietnamese: 'vi',
};

const AUDITED_CANONICAL_LANGUAGE_CODES = new Set(
  Object.values(ISO_LANGUAGE_ALIASES)
);

export function normalizeTranscriptionLanguage(language?: string | null) {
  const normalized = language?.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (AUDITED_CANONICAL_LANGUAGE_CODES.has(normalized)) {
    return normalized;
  }

  return ISO_LANGUAGE_ALIASES[normalized] || null;
}

export function resolveProviderTranscriptionLanguage(
  providerLanguage: string | null | undefined,
  requestedLanguage: string | null | undefined
) {
  const trimmedProviderLanguage = providerLanguage?.trim();

  return trimmedProviderLanguage || normalizeTranscriptionLanguage(requestedLanguage);
}
