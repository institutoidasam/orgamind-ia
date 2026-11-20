import { describe, expect, it, vi } from 'vitest';
import { phoneSkipReason, sendPhoneOf } from './recipient-skip';
import { member } from './team-whatsapp.test-fixtures';

const PHONE = '+5592991110001';
const CONTACT_PHONE = '+5592991110002';

/** Só a supressão do consentimento importa aqui. */
const consentWith = (suppressed: readonly string[]) => ({
  isSuppressed: vi.fn((phone: string) =>
    Promise.resolve(suppressed.includes(phone)),
  ),
});

describe('phoneSkipReason — pulo de telefone (DF3, ordem do skipReasonOf)', () => {
  it('sem telefone vem antes da supressão e da autorização', async () => {
    const consent = consentWith([]);
    const m = member({
      phoneE164: null,
      contact: null,
      contactAuthorization: 'NAO_AUTORIZADO',
    });

    await expect(phoneSkipReason(m, consent)).resolves.toBe('NO_PHONE');
    expect(consent.isSuppressed).not.toHaveBeenCalled();
  });

  it('número bloqueado vem antes de sem autorização', async () => {
    const m = member({
      phoneE164: PHONE,
      contactAuthorization: 'NAO_AUTORIZADO',
    });

    await expect(phoneSkipReason(m, consentWith([PHONE]))).resolves.toBe(
      'SUPPRESSED',
    );
  });

  it('sem autorização de contato vira NOT_AUTHORIZED', async () => {
    const m = member({
      phoneE164: PHONE,
      contactAuthorization: 'NAO_AUTORIZADO',
    });

    await expect(phoneSkipReason(m, consentWith([]))).resolves.toBe(
      'NOT_AUTHORIZED',
    );
  });

  it('CADASTRO_ANTERIOR autorizado passa', async () => {
    const m = member({
      phoneE164: PHONE,
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'CADASTRO_ANTERIOR',
    });

    await expect(phoneSkipReason(m, consentWith([]))).resolves.toBeNull();
  });
});

describe('sendPhoneOf — o telefone que o envio usa', () => {
  it('o do contato ligado vale por cima do do usuário; a supressão confere esse', async () => {
    const m = member({
      phoneE164: PHONE,
      contact: { phoneE164: CONTACT_PHONE },
    });
    const consent = consentWith([CONTACT_PHONE]);

    expect(sendPhoneOf(m)).toBe(CONTACT_PHONE);
    await expect(phoneSkipReason(m, consent)).resolves.toBe('SUPPRESSED');
  });
});
