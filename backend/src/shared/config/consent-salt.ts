/**
 * The development default is allowed only outside production. Keep the value
 * here so every production entry point compares against the same placeholder.
 */
export const CONSENT_SALT_DEVELOPMENT_DEFAULT = 'orgamind-consent-dev';

export const CONSENT_SALT_EXAMPLE =
  '__CHANGE_ME__generate_once_and_never_change__';

/** Never include a configured salt in an error or log. */
export const CONSENT_SALT_VALIDATION_ERROR =
  'PICOA_CONSENT_SALT must be set to a real non-placeholder value';

/**
 * Returns the stable public error for an unusable salt. Comparisons use a
 * trimmed copy only: a real salt is never normalized or modified here.
 */
export function consentSaltValidationError(value: unknown): string | undefined {
  if (typeof value !== 'string') return CONSENT_SALT_VALIDATION_ERROR;

  const comparable = value.trim();
  if (
    !comparable ||
    comparable === CONSENT_SALT_DEVELOPMENT_DEFAULT ||
    comparable === CONSENT_SALT_EXAMPLE
  ) {
    return CONSENT_SALT_VALIDATION_ERROR;
  }

  return undefined;
}
