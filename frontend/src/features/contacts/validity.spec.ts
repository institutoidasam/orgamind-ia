import { describe, it, expect } from 'vitest';
import {
  CONTACT_VALIDITIES,
  CONTACT_VALIDITY_FILTER_LABELS,
  CONTACT_VALIDITY_HINTS,
  CONTACT_VALIDITY_LABELS,
  contactValidityOf,
} from './validity';

describe('validity — espelho do backend', () => {
  it('as três classes, na mesma ordem do back', () => {
    expect([...CONTACT_VALIDITIES]).toEqual(['valid', 'invalid', 'unvalidated']);
  });

  it('os rótulos são os mesmos textos que a planilha imprime', () => {
    expect(CONTACT_VALIDITY_LABELS).toEqual({
      valid: 'Válido',
      invalid: 'Inválido confirmado',
      unvalidated: 'Não validado',
    });
  });

  it('o filtro usa o plural, e cada opção tem uma explicação de uma linha', () => {
    expect(CONTACT_VALIDITY_FILTER_LABELS.invalid).toBe('Inválidos confirmados');
    expect(CONTACT_VALIDITY_HINTS.unvalidated).toContain('ninguém checou');
  });

  // A célula da coluna WA não sabe, sozinha, se houve entrega provada — por
  // isso a derivação de fallback usa só os dois campos, e o back manda
  // `validity` já classificado com os três sinais (B.6, review — achado 1).
  it('null em tudo => "unvalidated"', () => {
    expect(
      contactValidityOf({ whatsappValid: null, lastFailureReason: null }),
    ).toBe('unvalidated');
  });

  it('whatsappValid false => "invalid"', () => {
    expect(
      contactValidityOf({ whatsappValid: false, lastFailureReason: null }),
    ).toBe('invalid');
  });

  it('SEM_WHATSAPP => "invalid" mesmo com whatsappValid null', () => {
    expect(
      contactValidityOf({
        whatsappValid: null,
        lastFailureReason: 'SEM_WHATSAPP',
      }),
    ).toBe('invalid');
  });

  it('OPT_OUT não invalida o NÚMERO', () => {
    expect(
      contactValidityOf({ whatsappValid: null, lastFailureReason: 'OPT_OUT' }),
    ).toBe('unvalidated');
  });

  it('whatsappValid true + TELEFONE_INVALIDO => "invalid" (mesmo desempate do back)', () => {
    expect(
      contactValidityOf({
        whatsappValid: true,
        lastFailureReason: 'TELEFONE_INVALIDO',
      }),
    ).toBe('invalid');
  });

  // B.6, review (achado 1) — a linha original do bug: `whatsappValid: null`
  // (nunca validado ativamente), mas o back já sabe (sonda de entrega) que é
  // válido. Sem preferir `validity`, a célula usaria só os dois campos e
  // mostraria "Não validado" enquanto o filtro/export já contam a linha como
  // válida.
  it('usa contact.validity do back quando presente, mesmo que a derivação de 2 campos discorde', () => {
    expect(
      contactValidityOf({
        whatsappValid: null,
        lastFailureReason: null,
        validity: 'valid',
      }),
    ).toBe('valid');
  });

  it('sem contact.validity (resposta em cache antiga), cai na derivação de 2 campos', () => {
    expect(
      contactValidityOf({ whatsappValid: true, lastFailureReason: null }),
    ).toBe('valid');
  });
});
