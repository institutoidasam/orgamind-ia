import { describe, expect, it } from 'vitest';
import {
  authorizationSatisfied,
  parseAuthorizationCells,
  planAuthorization,
  type AuthorizationCells,
  type AuthorizationPlan,
  type AuthorizationRaw,
} from './authorization-plan';
import type { AuthorizationNow } from './import-person';
import { ROW_TEXT } from './row-texts';

const TODAY = '2026-11-19';
const NOT_AUTHORIZED: AuthorizationNow = {
  status: 'NAO_AUTORIZADO',
  source: null,
  note: null,
  date: null,
};
const AUTHORIZED: AuthorizationNow = {
  status: 'AUTORIZADO',
  source: 'TERMO_ASSINADO',
  note: null,
  date: '2026-10-01',
};
const LEGACY: AuthorizationNow = {
  status: 'AUTORIZADO',
  source: 'CADASTRO_ANTERIOR',
  note: null,
  date: '2026-01-10',
};

function raw(over: Partial<AuthorizationRaw> = {}): AuthorizationRaw {
  return {
    authorization: '',
    authorizationSource: '',
    authorizationNote: '',
    authorizationDate: '',
    ...over,
  };
}

function yes(over: Partial<AuthorizationCells> = {}): AuthorizationCells {
  return {
    answer: 'yes',
    source: null,
    sourceGiven: false,
    note: null,
    date: null,
    errors: [],
    ...over,
  };
}

function plan(
  cells: AuthorizationCells,
  current: AuthorizationNow | null,
  canEdit = true,
): AuthorizationPlan {
  return planAuthorization({ cells, current, canEdit });
}

/** Plano que não mexe na autorização nem invalida a linha. */
function ignored(...warnings: string[]): AuthorizationPlan {
  return { input: null, warnings, errors: [] };
}

describe('planAuthorization: data vazia com a mesma origem (revisão T8)', () => {
  it('mesma origem com outro detalhe mantém a data atual; origem diferente fica sem data', () => {
    const agreement: AuthorizationNow = {
      status: 'AUTORIZADO',
      source: 'OUTRO',
      note: 'convênio',
      date: '2026-01-10',
    };
    const partnership = yes({ source: 'OUTRO', note: 'parceria' });
    expect(plan(partnership, agreement)).toStrictEqual({
      input: {
        status: 'AUTORIZADO',
        source: 'OUTRO',
        note: 'parceria',
        date: '2026-01-10',
      },
      warnings: [],
      errors: [],
    });
    expect(plan(partnership, { ...agreement, date: null }).input).toEqual({
      status: 'AUTORIZADO',
      source: 'OUTRO',
      note: 'parceria',
    });
    expect(
      plan(yes({ source: 'TERMO_ASSINADO' }), agreement).input,
    ).toStrictEqual({ status: 'AUTORIZADO', source: 'TERMO_ASSINADO' });
  });
});

describe('planAuthorization: erro de célula e quem não pode alterar (ruling T8 R1)', () => {
  it('célula com erro invalida a linha de quem pode alterar; de quem não pode, as colunas são ignoradas', () => {
    const futureDate = yes({
      source: 'TERMO_ASSINADO',
      errors: [ROW_TEXT.futureDate],
    });
    expect(plan(futureDate, NOT_AUTHORIZED)).toStrictEqual({
      input: null,
      warnings: [],
      errors: [ROW_TEXT.futureDate],
    });
    expect(plan(futureDate, NOT_AUTHORIZED, false)).toStrictEqual(
      ignored(ROW_TEXT.cannotEditAuthorization),
    );
  });

  it('Não em pessoa autorizada, sem poder alterar: só o aviso de que a planilha não retira', () => {
    expect(plan(yes({ answer: 'no' }), AUTHORIZED, false)).toStrictEqual(
      ignored(ROW_TEXT.noRevoke),
    );
  });
});

describe('parseAuthorizationCells: resposta, origem e detalhe', () => {
  it('Sim aceita s, x e 1; Não aceita n e 0; outro valor invalida', () => {
    const answer = (text: string) =>
      parseAuthorizationCells(raw({ authorization: text }), TODAY);
    for (const text of ['Sim', 's', 'X', '1']) {
      expect(answer(text).answer).toBe('yes');
    }
    for (const text of ['Não', 'nao', 'N', '0']) {
      expect(answer(text).answer).toBe('no');
    }
    expect(answer('')).toMatchObject({ answer: null, errors: [] });
    expect(answer('talvez')).toMatchObject({
      answer: null,
      errors: [ROW_TEXT.invalidYesNo],
    });
  });

  it('origem pelo rótulo sem caixa nem acento; texto sem par fica sem origem; detalhe longo invalida', () => {
    const cells = (source: string, note = '') =>
      parseAuthorizationCells(
        raw({ authorizationSource: source, authorizationNote: note }),
        TODAY,
      );
    expect(cells('FICHA DE ADMISSÃO')).toMatchObject({
      source: 'FICHA_ADMISSAO',
      sourceGiven: true,
    });
    expect(cells('Cadastro anterior').source).toBe('CADASTRO_ANTERIOR');
    expect(cells('Aceite  por whatsapp').source).toBe('ACEITE_WHATSAPP');
    expect(cells('')).toMatchObject({ source: null, sourceGiven: false });
    expect(cells('Carta')).toMatchObject({ source: null, sourceGiven: true });
    expect(cells('Outro', ' convênio ').note).toBe('convênio');
    expect(cells('Outro', 'a'.repeat(121))).toMatchObject({
      note: null,
      errors: [ROW_TEXT.tooLong('Detalhe da origem', 120)],
    });
  });
});

describe('parseAuthorizationCells: data', () => {
  it('data futura e formato inválido invalidam; DD/MM/AAAA e AAAA-MM-DD valem', () => {
    const date = (text: string) =>
      parseAuthorizationCells(raw({ authorizationDate: text }), TODAY);
    expect(date('05/03/2026')).toMatchObject({
      date: '2026-03-05',
      errors: [],
    });
    expect(date('2026-03-05')).toMatchObject({
      date: '2026-03-05',
      errors: [],
    });
    expect(date('19/11/2026').date).toBe(TODAY);
    expect(date('')).toMatchObject({ date: null, errors: [] });
    expect(date('20/11/2026')).toMatchObject({
      date: null,
      errors: [ROW_TEXT.futureDate],
    });
    expect(date('2026-12-01').errors).toEqual([ROW_TEXT.futureDate]);
    for (const text of [
      '31/02/2026',
      '5 de março',
      '2026/03/05',
      '05-03-2026',
    ]) {
      expect(date(text)).toMatchObject({
        date: null,
        errors: [ROW_TEXT.invalidDate],
      });
    }
  });
});

describe('planAuthorization: Sim com e sem origem', () => {
  it('aceite 15: Sim sem origem não autoriza e avisa; Sim com origem autoriza com origem e data', () => {
    const withoutSource = ignored(ROW_TEXT.authorizationWithoutSource);
    expect(plan(yes(), NOT_AUTHORIZED)).toEqual(withoutSource);
    expect(plan(yes({ sourceGiven: true }), NOT_AUTHORIZED)).toEqual(
      withoutSource,
    );
    expect(
      plan(
        yes({ source: 'TERMO_ASSINADO', date: '2026-11-01' }),
        NOT_AUTHORIZED,
      ),
    ).toStrictEqual({
      input: {
        status: 'AUTORIZADO',
        source: 'TERMO_ASSINADO',
        date: '2026-11-01',
      },
      warnings: [],
      errors: [],
    });
  });

  it('Cadastro anterior não autoriza; igual ao atual não muda nada nem avisa', () => {
    const legacy = yes({ source: 'CADASTRO_ANTERIOR' });
    const withoutSource = ignored(ROW_TEXT.authorizationWithoutSource);
    expect(plan(legacy, NOT_AUTHORIZED)).toEqual(withoutSource);
    expect(plan(legacy, AUTHORIZED)).toEqual(withoutSource);
    expect(plan(legacy, LEGACY)).toEqual(ignored());
  });
});

describe('planAuthorization: data da autorização', () => {
  it('data vazia: ausente quando nova ou muda a origem; mantém a atual com a mesma origem', () => {
    const termo = yes({ source: 'TERMO_ASSINADO' });
    const absentDate = {
      input: { status: 'AUTORIZADO', source: 'TERMO_ASSINADO' },
      warnings: [],
      errors: [],
    };
    expect(plan(termo, null)).toStrictEqual(absentDate);
    expect(plan(termo, NOT_AUTHORIZED)).toStrictEqual(absentDate);
    expect(plan(termo, LEGACY)).toStrictEqual(absentDate);
    expect(plan(termo, AUTHORIZED)).toEqual(ignored());
    expect(plan(yes({ source: 'FICHA_ADMISSAO' }), AUTHORIZED).input).toEqual({
      status: 'AUTORIZADO',
      source: 'FICHA_ADMISSAO',
    });
    expect(plan({ ...termo, date: '2026-11-01' }, AUTHORIZED).input).toEqual({
      status: 'AUTORIZADO',
      source: 'TERMO_ASSINADO',
      date: '2026-11-01',
    });
    expect(plan({ ...termo, date: '2026-10-01' }, AUTHORIZED).input).toBeNull();
  });
});

describe('planAuthorization: Outro e Não', () => {
  it('Outro sem detalhe é ignorado com aviso; com detalhe autoriza; nas demais origens o detalhe é descartado', () => {
    const outro = yes({ source: 'OUTRO' });
    expect(plan(outro, NOT_AUTHORIZED)).toEqual(
      ignored(ROW_TEXT.authorizationWithoutNote),
    );
    expect(plan(outro, null).warnings).toEqual([
      ROW_TEXT.authorizationWithoutNote,
      ROW_TEXT.newWithoutAuthorization,
    ]);
    expect(plan({ ...outro, note: 'convênio' }, NOT_AUTHORIZED).input).toEqual({
      status: 'AUTORIZADO',
      source: 'OUTRO',
      note: 'convênio',
    });
    const termoWithNote = yes({ source: 'TERMO_ASSINADO', note: 'x' });
    expect(plan(termoWithNote, NOT_AUTHORIZED).input).toStrictEqual({
      status: 'AUTORIZADO',
      source: 'TERMO_ASSINADO',
    });
  });

  it('Não em pessoa autorizada é ignorado com aviso', () => {
    const no = yes({ answer: 'no' });
    expect(plan(no, AUTHORIZED)).toEqual(ignored(ROW_TEXT.noRevoke));
    expect(plan(no, NOT_AUTHORIZED)).toEqual(ignored());
  });
});

describe('planAuthorization: pessoa nova e quem não pode alterar', () => {
  it('ator que não pode alterar a autorização: colunas ignoradas com aviso', () => {
    const termo = yes({ source: 'TERMO_ASSINADO', date: '2026-11-01' });
    expect(plan(termo, NOT_AUTHORIZED, false)).toEqual(
      ignored(ROW_TEXT.cannotEditAuthorization),
    );
    expect(plan(termo, NOT_AUTHORIZED, true).input).not.toBeNull();
    expect(plan(yes({ source: 'TERMO_ASSINADO' }), AUTHORIZED, false)).toEqual(
      ignored(),
    );
  });

  it('pessoa nova sem autorização ganha o aviso de mensagens', () => {
    const notice = ignored(ROW_TEXT.newWithoutAuthorization);
    expect(plan(yes({ answer: null }), null)).toEqual(notice);
    expect(plan(yes({ answer: 'no' }), null)).toEqual(notice);
    expect(plan(yes({ answer: null }), NOT_AUTHORIZED)).toEqual(ignored());
  });
});

describe('authorizationSatisfied', () => {
  it('mesma origem e detalhe com data ausente é satisfeita', () => {
    const termo = { status: 'AUTORIZADO', source: 'TERMO_ASSINADO' } as const;
    expect(authorizationSatisfied(AUTHORIZED, termo)).toBe(true);
    expect(
      authorizationSatisfied(AUTHORIZED, { ...termo, date: '2026-10-01' }),
    ).toBe(true);
    expect(
      authorizationSatisfied(AUTHORIZED, { ...termo, date: '2026-10-02' }),
    ).toBe(false);
    expect(
      authorizationSatisfied(AUTHORIZED, {
        ...termo,
        source: 'FICHA_ADMISSAO',
      }),
    ).toBe(false);
    expect(authorizationSatisfied(NOT_AUTHORIZED, termo)).toBe(false);
    const other = { ...AUTHORIZED, source: 'OUTRO', note: 'convênio' } as const;
    expect(
      authorizationSatisfied(other, {
        status: 'AUTORIZADO',
        source: 'OUTRO',
        note: 'convênio',
      }),
    ).toBe(true);
    expect(
      authorizationSatisfied(other, {
        status: 'AUTORIZADO',
        source: 'OUTRO',
        note: 'parceria',
      }),
    ).toBe(false);
  });

  it('não autorizado só compara o status', () => {
    const no = { status: 'NAO_AUTORIZADO' } as const;
    expect(authorizationSatisfied(NOT_AUTHORIZED, no)).toBe(true);
    expect(authorizationSatisfied(AUTHORIZED, no)).toBe(false);
  });
});
