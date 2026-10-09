import {
  consentSaltValidationError,
  CONSENT_SALT_VALIDATION_ERROR,
} from './consent-salt';

type ConsentSaltEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Preflight used by the production migration container before any database
 * operation. Its output is deliberately constant, so configured values never
 * reach deploy logs.
 */
export function validateConsentSaltCli(
  env: ConsentSaltEnvironment,
  writeError: (message: string) => void,
): number {
  if (consentSaltValidationError(env.PICOA_CONSENT_SALT)) {
    writeError(CONSENT_SALT_VALIDATION_ERROR);
    return 1;
  }

  return 0;
}

if (require.main === module) {
  process.exitCode = validateConsentSaltCli(process.env, console.error);
}
