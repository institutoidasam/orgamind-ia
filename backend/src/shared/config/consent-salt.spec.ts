import { describe, expect, it } from 'vitest';
import {
  CONSENT_SALT_VALIDATION_ERROR,
  consentSaltValidationError,
} from './consent-salt';

describe('consentSaltValidationError', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', ' \t '],
    ['development default', 'orgamind-consent-dev'],
    [
      'production example sentinel',
      '__CHANGE_ME__generate_once_and_never_change__',
    ],
    ['trimmed development default', '  orgamind-consent-dev  '],
    [
      'trimmed production example sentinel',
      '  __CHANGE_ME__generate_once_and_never_change__  ',
    ],
  ])('rejects %s without including the configured value', (_label, salt) => {
    expect(consentSaltValidationError(salt)).toBe(
      CONSENT_SALT_VALIDATION_ERROR,
    );
  });

  it('accepts a real salt without changing it', () => {
    const salt = '  salt-used-as-configured  ';

    expect(consentSaltValidationError(salt)).toBeUndefined();
  });
});
