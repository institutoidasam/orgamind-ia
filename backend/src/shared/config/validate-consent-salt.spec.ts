import { describe, expect, it, vi } from 'vitest';
import { CONSENT_SALT_VALIDATION_ERROR } from './consent-salt';
import { validateConsentSaltCli } from './validate-consent-salt';

describe('validateConsentSaltCli', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', '  \t  '],
    ['development default', 'orgamind-consent-dev'],
    [
      'production example sentinel',
      '__CHANGE_ME__generate_once_and_never_change__',
    ],
    [
      'trimmed production example sentinel',
      '  __CHANGE_ME__generate_once_and_never_change__  ',
    ],
  ])('returns failure with a constant error for %s', (_label, salt) => {
    const writeError = vi.fn();

    expect(
      validateConsentSaltCli({ PICOA_CONSENT_SALT: salt }, writeError),
    ).toBe(1);
    expect(writeError).toHaveBeenCalledExactlyOnceWith(
      CONSENT_SALT_VALIDATION_ERROR,
    );
  });

  it('returns success without output for a real salt', () => {
    const writeError = vi.fn();

    expect(
      validateConsentSaltCli(
        { PICOA_CONSENT_SALT: 'test-consent-salt-for-production' },
        writeError,
      ),
    ).toBe(0);
    expect(writeError).not.toHaveBeenCalled();
  });
});
