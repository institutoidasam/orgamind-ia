import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizationChoiceError,
  authorizationFlag,
  authorizationLabel,
  contactAuthorizationSchema,
  toAuthorizationInput,
  todayInManaus,
  type ContactAuthorization,
} from './authorization';

const base: ContactAuthorization = { status: 'AUTORIZADO', source: null, note: null, date: null, recordedAt: null };
const termo: ContactAuthorization = { ...base, source: 'TERMO_ASSINADO', date: '2026-11-03' };
const migrada: ContactAuthorization = { ...base, source: 'CADASTRO_ANTERIOR' };
const semAutorizacao: ContactAuthorization = { ...base, status: 'NAO_AUTORIZADO' };

afterEach(() => vi.useRealTimers());

describe('authorizationLabel: rótulo por extenso, sem enum cru', () => {
  it('cadastro anterior, origem com data, Outro com nota e sem autorização', () => {
    expect(authorizationLabel(migrada)).toBe('Cadastro anterior — origem não verificada');
    expect(authorizationLabel(termo)).toBe('Termo assinado em 03/11/2026');
    expect(authorizationLabel({ ...termo, source: 'OUTRO', note: 'Carta do RH' })).toBe('Outro (Carta do RH) em 03/11/2026');
    expect(authorizationLabel(semAutorizacao)).toBe('Sem autorização registrada');
  });
});

describe('authorizationFlag: o que o selo da lista sinaliza', () => {
  it('cadastro anterior é não verificada, sem autorização é bloqueada, origem verificada não sinaliza', () => {
    expect(authorizationFlag(migrada)).toBe('unverified');
    expect(authorizationFlag(semAutorizacao)).toBe('not_authorized');
    expect(authorizationFlag(termo)).toBeNull();
  });
});

describe('toAuthorizationInput: escolha da tela vira o corpo da API', () => {
  it('sem autorização envia só o status; origem envia data e, só no Outro, a nota aparada', () => {
    expect(toAuthorizationInput({ status: 'NAO_AUTORIZADO' })).toEqual({ status: 'NAO_AUTORIZADO' });
    expect(toAuthorizationInput({ status: 'AUTORIZADO', source: 'FICHA_ADMISSAO', note: 'resto', date: '2026-11-03' })).toEqual({
      status: 'AUTORIZADO',
      source: 'FICHA_ADMISSAO',
      date: '2026-11-03',
    });
    expect(toAuthorizationInput({ status: 'AUTORIZADO', source: 'OUTRO', note: '  Carta do RH ', date: '2026-11-03' })).toEqual({
      status: 'AUTORIZADO',
      source: 'OUTRO',
      note: 'Carta do RH',
      date: '2026-11-03',
    });
  });
});

describe('todayInManaus e authorizationChoiceError', () => {
  it('hoje vale no fuso de Manaus, não no UTC', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T02:30:00Z'));
    expect(todayInManaus()).toBe('2026-11-19');
  });

  it('exige escolha, texto no Outro e recusa data futura', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T15:00:00Z'));
    const outro = { status: 'AUTORIZADO', source: 'OUTRO', date: '2026-11-19' } as const;
    expect(authorizationChoiceError(null)).toBe('Escolha a autorização de contato');
    expect(authorizationChoiceError({ status: 'NAO_AUTORIZADO' })).toBeUndefined();
    expect(authorizationChoiceError({ ...outro, note: '  ' })).toBe('Descreva a origem da autorização');
    expect(authorizationChoiceError({ ...outro, note: 'Carta' })).toBeUndefined();
    expect(authorizationChoiceError({ ...outro, note: 'Carta', date: '2026-11-20' })).toBe('A data da autorização não pode ser futura');
  });
});

describe('contactAuthorizationSchema: espelho da saída da API', () => {
  it('aceita o objeto da API e recusa status desconhecido', () => {
    expect(contactAuthorizationSchema.safeParse(termo).success).toBe(true);
    expect(contactAuthorizationSchema.safeParse({ ...termo, status: 'TALVEZ' }).success).toBe(false);
  });
});
