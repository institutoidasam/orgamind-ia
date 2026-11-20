import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_SOURCE_CELL } from '../../shared/spreadsheet/people-columns';
import type { ImportPerson } from './import-person';
import {
  authorizationLabel,
  diffPerson,
  patchSatisfied,
  personFingerprint,
  samePhone,
  type ResolvedRow,
} from './person-diff';
import type { StructureCatalog } from './structure-match';

const option = (id: string, name: string, isActive = true) => ({
  id,
  name,
  code: null,
  isActive,
});

const CATALOG: StructureCatalog = {
  sector: [option('s-prod', 'Produção'), option('s-log', 'Logística')],
  shift: [option('sh-man', 'Manhã'), option('sh-not', 'Noite', false)],
  level: [option('lv-op', 'Operacional'), option('lv-sen', 'Sênior')],
};

const PERSON: ImportPerson = {
  id: 'p-1',
  name: 'Marina Souza',
  phoneE164: '+5592991110001',
  registration: 'AB123',
  registrationKey: 'ab123',
  jobTitle: 'Analista',
  sectorId: 's-prod',
  shiftId: 'sh-man',
  levelId: 'lv-op',
  authorization: {
    status: 'AUTORIZADO',
    source: 'TERMO_ASSINADO',
    note: null,
    date: '2026-10-01',
  },
  isActive: true,
  hasAccess: false,
};

const EMPTY_ROW: ResolvedRow = {
  name: null,
  phoneE164: null,
  jobTitle: null,
  registration: null,
  sectorId: null,
  shiftId: null,
  levelId: null,
  authorization: null,
};

const CHANGED: ResolvedRow = {
  name: 'Marina S. Souza',
  phoneE164: '+5592991110002',
  jobTitle: 'Coordenadora',
  registration: 'CD456',
  sectorId: 's-log',
  shiftId: 'sh-not',
  levelId: 'lv-sen',
  authorization: {
    status: 'AUTORIZADO',
    source: 'OUTRO',
    note: 'Reunião de equipe',
    date: '2026-11-18',
  },
};

/** A pessoa depois de gravar `CHANGED`. */
const AFTER: ImportPerson = {
  ...PERSON,
  name: 'Marina S. Souza',
  phoneE164: '+5592991110002',
  jobTitle: 'Coordenadora',
  registration: 'CD456',
  registrationKey: 'cd456',
  sectorId: 's-log',
  shiftId: 'sh-not',
  levelId: 'lv-sen',
  authorization: {
    status: 'AUTORIZADO',
    source: 'OUTRO',
    note: 'Reunião de equipe',
    date: '2026-11-18',
  },
};

function diffOf(row: Partial<ResolvedRow>, person: ImportPerson = PERSON) {
  return diffPerson({
    person,
    row: { ...EMPTY_ROW, ...row },
    catalog: CATALOG,
  });
}

describe('diffPerson: o que entra no patch', () => {
  it('célula vazia não altera; nome e telefone nulos não entram no patch', () => {
    expect(diffOf({})).toEqual({ patch: {}, diff: [] });
    expect(diffOf({ name: '  ', jobTitle: '' })).toEqual({
      patch: {},
      diff: [],
    });
  });

  it('valores iguais aos atuais, mesmo com turno inativo, não entram no patch', () => {
    const person = { ...PERSON, shiftId: 'sh-not' };
    const row = {
      name: person.name,
      phoneE164: person.phoneE164,
      jobTitle: person.jobTitle,
      registration: person.registration,
      sectorId: person.sectorId,
      shiftId: 'sh-not',
      levelId: person.levelId,
      authorization: {
        status: 'AUTORIZADO',
        source: 'TERMO_ASSINADO',
      } as const,
    };
    expect(diffOf(row, person)).toEqual({ patch: {}, diff: [] });
  });

  it('telefone na outra grafia do nono dígito não é mudança', () => {
    expect(diffOf({ phoneE164: '+559291110001' }).patch).toEqual({});
    const legacy = { ...PERSON, phoneE164: '+559291110001' };
    expect(diffOf({ phoneE164: '+5592991110001' }, legacy).patch).toEqual({});
  });

  it('matrícula com outra caixa não é mudança', () => {
    expect(diffOf({ registration: 'ab123' }).patch).toEqual({});
    expect(diffOf({ registration: ' AB123 ' }).patch).toEqual({});
  });

  it('nome e função só com espaços a mais não são mudança', () => {
    expect(
      diffOf({ name: ' Marina Souza ', jobTitle: ' Analista ' }).patch,
    ).toEqual({});
  });
});

describe('diffPerson: o que mostra', () => {
  it('diff mostra antes e depois por campo, com nomes de setor, turno e nível e a autorização por extenso', () => {
    const { patch, diff } = diffOf(CHANGED);
    expect(patch).toEqual({
      name: 'Marina S. Souza',
      phone: '+5592991110002',
      registration: 'CD456',
      jobTitle: 'Coordenadora',
      sectorId: 's-log',
      shiftId: 'sh-not',
      levelId: 'lv-sen',
      contactAuthorization: CHANGED.authorization,
    });
    expect(diff).toEqual([
      { field: 'name', before: 'Marina Souza', after: 'Marina S. Souza' },
      { field: 'phone', before: '+5592991110001', after: '+5592991110002' },
      { field: 'registration', before: 'AB123', after: 'CD456' },
      { field: 'jobTitle', before: 'Analista', after: 'Coordenadora' },
      { field: 'sector', before: 'Produção', after: 'Logística' },
      { field: 'shift', before: 'Manhã', after: 'Noite' },
      { field: 'level', before: 'Operacional', after: 'Sênior' },
      {
        field: 'authorization',
        before: 'Sim — Termo assinado — 01/10/2026',
        after: 'Sim — Outro — Reunião de equipe — 18/11/2026',
      },
    ]);
  });

  it('campo que a pessoa não tem aparece com antes nulo', () => {
    const bare = { ...PERSON, jobTitle: null, sectorId: null };
    const { diff } = diffOf({ jobTitle: 'Analista', sectorId: 's-log' }, bare);
    expect(diff).toEqual([
      { field: 'jobTitle', before: null, after: 'Analista' },
      { field: 'sector', before: null, after: 'Logística' },
    ]);
  });
});

describe('patchSatisfied', () => {
  it('patchSatisfied é verdadeiro depois de aplicar o patch e falso antes', () => {
    const { patch } = diffOf(CHANGED);
    expect(patchSatisfied(PERSON, patch)).toBe(false);
    expect(patchSatisfied(AFTER, patch)).toBe(true);
    expect(patchSatisfied({ ...AFTER, levelId: 'lv-op' }, patch)).toBe(false);
  });

  it('não compara o que não está no patch, como o telefone gravado', () => {
    const other = { ...PERSON, phoneE164: '+5592991119999' };
    expect(patchSatisfied(other, { name: 'Marina Souza' })).toBe(true);
    expect(patchSatisfied(other, {})).toBe(true);
  });
});

describe('personFingerprint', () => {
  it('personFingerprint muda quando um campo importado muda e não depende do id', () => {
    const base = personFingerprint(PERSON);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(personFingerprint({ ...PERSON })).toBe(base);
    expect(personFingerprint({ ...PERSON, id: 'p-2' })).toBe(base);
    const changes: Partial<ImportPerson>[] = [
      { name: 'Outra Pessoa' },
      { phoneE164: '+5592991110002' },
      { registration: 'AB124' },
      { jobTitle: 'Gerente' },
      { sectorId: 's-log' },
      { shiftId: 'sh-not' },
      { levelId: 'lv-sen' },
      { authorization: { ...PERSON.authorization, date: '2026-10-02' } },
      { authorization: { ...PERSON.authorization, source: 'OUTRO' } },
      { authorization: { ...PERSON.authorization, note: 'detalhe' } },
      { isActive: false },
      { hasAccess: true },
    ];
    const prints = changes.map((c) => personFingerprint({ ...PERSON, ...c }));
    expect(new Set([base, ...prints]).size).toBe(changes.length + 1);
  });
});

describe('authorizationLabel', () => {
  it('escreve Não, e Sim com origem, detalhe só em Outro e data', () => {
    expect(
      authorizationLabel({
        status: 'NAO_AUTORIZADO',
        source: null,
        note: null,
        date: null,
      }),
    ).toBe('Não');
    expect(authorizationLabel({ status: 'NAO_AUTORIZADO' })).toBe('Não');
    expect(authorizationLabel(PERSON.authorization)).toBe(
      'Sim — Termo assinado — 01/10/2026',
    );
    expect(
      authorizationLabel({
        status: 'AUTORIZADO',
        source: 'TERMO_ASSINADO',
        note: 'ignorado',
        date: '2026-11-19',
      }),
    ).toBe('Sim — Termo assinado — 19/11/2026');
  });

  it('data ausente vira "data da gravação"', () => {
    expect(
      authorizationLabel({ status: 'AUTORIZADO', source: 'FICHA_ADMISSAO' }),
    ).toBe('Sim — Ficha de admissão — data da gravação');
    expect(
      authorizationLabel({
        status: 'AUTORIZADO',
        source: 'OUTRO',
        note: 'Reunião',
      }),
    ).toBe('Sim — Outro — Reunião — data da gravação');
  });
});

describe('authorizationLabel: estado gravado sem data', () => {
  it('date nulo (backfill de Cadastro anterior) vira "sem data registrada"', () => {
    expect(
      authorizationLabel({
        status: 'AUTORIZADO',
        source: 'CADASTRO_ANTERIOR',
        note: null,
        date: null,
      }),
    ).toBe(
      `Sim — ${AUTHORIZATION_SOURCE_CELL.CADASTRO_ANTERIOR} — sem data registrada`,
    );
  });
});

describe('samePhone', () => {
  it('as duas grafias do nono dígito são o mesmo telefone; nulo só é igual a nulo', () => {
    expect(samePhone('+5592991110001', '+559291110001')).toBe(true);
    expect(samePhone('+5592991110001', '+5592991110001')).toBe(true);
    expect(samePhone('+5592991110001', '+5592991110002')).toBe(false);
    expect(samePhone(null, '+5592991110001')).toBe(false);
    expect(samePhone(null, null)).toBe(true);
  });
});
