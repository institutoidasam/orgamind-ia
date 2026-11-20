import { describe, expect, it } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { PermissionChange } from '../../shared/authz/actor.test-fixtures';
import type { RawFields } from './cell-values';
import {
  cellsOf,
  classifyWith,
  lookupOf,
  personWith,
} from './classify-row.fixtures';
import { toImportActor, type ImportActor } from './import-actor';
import type { ImportPerson, RowVerdict } from './import-person';
import { ROW_TEXT } from './row-texts';

/** Gestor do setor Produção, com `pessoas.editar`. */
const managerWith = (change: PermissionChange): ImportActor =>
  toImportActor({
    ...actorWith('SUPERVISOR', { id: 'gestor', ...change }),
    managedSectorIds: ['s-prod'],
  });

const MANAGER = managerWith({
  grant: ['pessoas.editar'],
  revoke: ['telefone.ver_completo'],
});
const MANAGER_WITH_KEY = managerWith({
  grant: ['pessoas.editar', 'telefone.ver_completo'],
});

const MARINA = personWith();
const OUTSIDER = personWith({
  id: 'p-fora',
  name: 'Bruno Alves',
  phoneE164: '+5592991110003',
  registration: 'MAT-03',
  registrationKey: 'mat-03',
  sectorId: 's-log',
});
const WITH_LOGIN = personWith({
  id: 'p-login',
  name: 'Carla Dias',
  phoneE164: '+5592991110004',
  registration: 'MAT-04',
  registrationKey: 'mat-04',
  hasAccess: true,
});
const NO_PHONE = personWith({
  id: 'p-sem-telefone',
  name: 'Davi Rocha',
  phoneE164: null,
  registration: 'MAT-05',
  registrationKey: 'mat-05',
});
const PEOPLE = [MARINA, OUTSIDER, WITH_LOGIN, NO_PHONE];

/** EX16: a resposta única de pessoa fora do alcance ou com login. */
const CANNOT_EDIT_PERSON: RowVerdict = {
  classification: 'INVALID',
  reasons: [ROW_TEXT.cannotEditPerson],
  warnings: [],
  preview: null,
  plan: null,
  personId: null,
};

const asManager = (cells: Partial<RawFields>, actor = MANAGER) =>
  classifyWith({ actor, cells, people: PEOPLE });

const invalid = (reasons: string[]): RowVerdict => ({
  ...CANNOT_EDIT_PERSON,
  reasons,
});

describe('classifyRow, gestor: colunas de autorização (T10 M1)', () => {
  const AUTHORIZED = { status: 'AUTORIZADO', source: 'TERMO_ASSINADO' };
  const columns = {
    authorization: 'Sim',
    authorizationSource: 'Termo assinado',
  };

  it('pessoa nova: o gestor com pessoas.editar grava a autorização da linha', () => {
    const verdict = asManager({
      name: 'Elisa Prado',
      phone: '(92) 99111-0009',
      sector: 'Produção',
      ...columns,
    });

    expect(verdict.classification).toBe('CREATE');
    expect(verdict.warnings).toEqual([]);
    expect(verdict.plan).toHaveProperty(
      'input.contactAuthorization',
      AUTHORIZED,
    );
  });

  it('pessoa existente no alcance: a autorização entra no plano da atualização', () => {
    const verdict = asManager({ ...cellsOf(MARINA), ...columns });

    expect(verdict.classification).toBe('UPDATE');
    expect(verdict.plan).toHaveProperty(
      'patch.contactAuthorization',
      AUTHORIZED,
    );
    expect(verdict.preview?.diff.map((d) => d.field)).toEqual([
      'authorization',
    ]);
  });
});

describe('classifyRow, quem não é ADMIN: alcance e login (EX16)', () => {
  it('aceite 27: quem não é ADMIN recebe a mesma resposta para pessoa fora do alcance, com palpite certo ou errado', () => {
    const verdicts = [
      asManager(cellsOf(OUTSIDER)),
      asManager({
        registration: 'mat-03',
        name: 'Outro Nome',
        jobTitle: 'Técnico',
        sector: 'Produção',
      }),
      asManager(cellsOf(WITH_LOGIN)),
      asManager(cellsOf(OUTSIDER), MANAGER_WITH_KEY),
    ];

    for (const verdict of verdicts) {
      expect(verdict).toStrictEqual(CANNOT_EDIT_PERSON);
    }
  });

  it('linha com erro próprio responde pelo erro, antes da trava de alcance', () => {
    const longName = asManager({
      registration: 'MAT-03',
      name: 'x'.repeat(121),
    });
    const badPhone = asManager({ registration: 'MAT-04', phone: '123' });

    expect(longName).toStrictEqual(invalid([ROW_TEXT.tooLong('Nome', 120)]));
    expect(badPhone).toStrictEqual(invalid([ROW_TEXT.invalidPhone]));
  });

  it('travas vêm antes de Sem alteração', () => {
    const withoutSector = { ...cellsOf(MARINA), sector: '' };

    expect(asManager(cellsOf(WITH_LOGIN))).toStrictEqual(CANNOT_EDIT_PERSON);
    expect(asManager(withoutSector)).toStrictEqual(
      invalid([ROW_TEXT.sectorRequired]),
    );
    expect(asManager(cellsOf(MARINA))).toMatchObject({
      classification: 'UNCHANGED',
      warnings: [ROW_TEXT.cannotEditPhone],
    });
  });
});

describe('classifyRow, quem não é ADMIN: setor e telefone (EX17.1)', () => {
  it('quem não é ADMIN: setor obrigatório e no alcance', () => {
    const newPerson = { name: 'Elisa Prado', phone: '+5592991110009' };

    expect(
      asManager({ registration: 'MAT-01', jobTitle: 'Gerente' }),
    ).toStrictEqual(invalid([ROW_TEXT.sectorRequired]));
    expect(asManager(newPerson)).toStrictEqual(
      invalid([ROW_TEXT.sectorRequired]),
    );
    for (const sector of ['Logística', 'Galpão 9']) {
      expect(asManager({ ...newPerson, sector })).toStrictEqual(
        invalid([ROW_TEXT.notInReach(sector)]),
      );
    }
    expect(asManager({ ...newPerson, sector: 'produção' }).classification).toBe(
      'CREATE',
    );
  });

  it('aceite 24: sem telefone.ver_completo, célula de telefone igual, diferente e de outra pessoa dão a mesma classificação e o mesmo aviso', () => {
    const { lookup, phoneReads } = lookupOf(PEOPLE);
    const cells = {
      registration: 'MAT-01',
      jobTitle: 'Gerente',
      sector: 'Produção',
    };
    const phones = ['+5592991110001', '+5592991110009', '+5592991110003'];

    const verdicts = phones.map((phone) =>
      classifyWith({ actor: MANAGER, cells: { ...cells, phone }, lookup }),
    );

    for (const verdict of verdicts) {
      expect(verdict.classification).toBe('UPDATE');
      expect(verdict.warnings).toEqual([ROW_TEXT.cannotEditPhone]);
      expect(verdict.plan).not.toHaveProperty('patch.phone');
      expect(verdict.preview?.diff.map((d) => d.field)).toEqual(['jobTitle']);
    }
    expect(phoneReads).toEqual([]);
  });
});

describe('classifyRow, quem não é ADMIN: telefone mascarado', () => {
  it('sem telefone.ver_completo: telefone mascarado conta como vazio, sem aviso', () => {
    const cells = { registration: 'MAT-01', sector: 'Produção' };

    const masked = asManager({ ...cells, phone: '•••• 0001' });

    expect(masked).toStrictEqual(asManager(cells));
    expect(masked).toMatchObject({ classification: 'UNCHANGED', warnings: [] });
  });
});

describe('Conselho S: telefone sem a chave, pessoa nova (S1)', () => {
  const LEGACY = personWith({
    id: 'p-legado',
    name: 'Fábio Nunes',
    phoneE164: '+559291110008',
    registration: 'MAT-08',
    registrationKey: 'mat-08',
  });

  it.each([
    ['dono sem login no alcance', MARINA, '+5592991110001'],
    ['dono com login', WITH_LOGIN, '+5592991110004'],
    ['dono fora do alcance', OUTSIDER, '+5592991110003'],
    ['outra grafia do 9º dígito', LEGACY, '(92) 99111-0008'],
  ] as const)(
    'S1-1: sem telefone.ver_completo, pessoa nova com número já cadastrado (%s) dá o mesmo resultado que com número livre',
    (_label, owner: ImportPerson, phone) => {
      const cells = { name: 'Elisa Prado', phone, sector: 'Produção' };
      const taken = lookupOf([...PEOPLE, LEGACY]);

      const withOwner = classifyWith({
        actor: MANAGER,
        cells,
        lookup: taken.lookup,
      });
      const others = PEOPLE.filter((person) => person.id !== owner.id);
      const free = classifyWith({ actor: MANAGER, cells, people: others });

      expect(withOwner).toStrictEqual(free);
      expect(withOwner.classification).toBe('CREATE');
      expect(withOwner.reasons).toEqual([]);
      expect(taken.phoneReads).toEqual([]);
    },
  );
});

describe('Conselho S: com a chave, Conflito sem dizer de quem (S1-3)', () => {
  it('S1-3: com telefone.ver_completo e para o ADMIN, Conflito de telefone traz só o texto fixo', () => {
    for (const owner of [OUTSIDER, WITH_LOGIN]) {
      const verdict = asManager(
        { ...cellsOf(MARINA), phone: owner.phoneE164 ?? '' },
        MANAGER_WITH_KEY,
      );

      expect(verdict).toStrictEqual({
        ...CANNOT_EDIT_PERSON,
        classification: 'CONFLICT',
        reasons: [ROW_TEXT.phoneTaken],
      });
      const text = JSON.stringify(verdict);
      for (const secret of [owner.name, owner.registration, owner.id]) {
        if (secret === null) continue;
        expect(text).not.toContain(secret);
      }
      expect(text).not.toContain('Logística');
    }
  });
});

describe('Conselho S: telefone sem a chave, pessoa existente (S1-4, S2)', () => {
  it('S1-4: aceite 17 sem telefone.ver_completo (matrícula de A, telefone de B) nunca dá Conflito', () => {
    const empty = asManager({ ...cellsOf(NO_PHONE), phone: '+5592991110001' });
    const filled = asManager({ ...cellsOf(MARINA), phone: '+5592991110003' });

    expect(empty.classification).toBe('UPDATE');
    expect(empty.plan).toHaveProperty('patch.phone', '+5592991110001');
    expect(filled.classification).toBe('UNCHANGED');
    expect(filled.warnings).toEqual([ROW_TEXT.cannotEditPhone]);
  });

  it('S2-1: sem telefone.ver_completo, pessoa achada pela matrícula e sem telefone: Atualizar com o telefone no plano e na prévia', () => {
    const verdict = asManager({
      registration: 'MAT-05',
      phone: '(92) 99111-0011',
      sector: 'Produção',
    });

    expect(verdict.classification).toBe('UPDATE');
    expect(verdict.warnings).toEqual([]);
    expect(verdict.plan).toMatchObject({
      kind: 'update',
      personId: 'p-sem-telefone',
      keys: { registrationKey: 'mat-05', phoneE164: '+5592991110011' },
      patch: { phone: '+5592991110011' },
    });
    expect(verdict.preview?.diff).toEqual([
      { field: 'phone', before: null, after: '+5592991110011' },
    ]);
  });
});

describe('Conselho S: pessoa com telefone, com login ou fora do alcance (S2-2, S2-6)', () => {
  it('S2-2: pessoa com telefone: célula igual e célula diferente dão o mesmo resultado', () => {
    const cells = {
      registration: 'MAT-01',
      name: 'Marina S.',
      sector: 'Produção',
    };

    const same = asManager({ ...cells, phone: '+5592991110001' });
    const other = asManager({ ...cells, phone: '+5592991110009' });

    expect(same).toStrictEqual(other);
    expect(same.warnings).toEqual([ROW_TEXT.cannotEditPhone]);
    expect(same.plan).toMatchObject({
      kind: 'update',
      patch: { name: 'Marina S.' },
    });
    expect(same.plan).not.toHaveProperty('patch.phone');
    expect(same.preview?.diff.map((d) => d.field)).toEqual(['name']);
  });

  it('S2-6: pessoa com login ou fora do alcance: resposta da EX16 com qualquer telefone', () => {
    for (const person of [WITH_LOGIN, OUTSIDER]) {
      const own = person.phoneE164 ?? '';
      for (const phone of ['', own, '+5592991110009', '+5592991110001']) {
        expect(asManager({ ...cellsOf(person), phone })).toStrictEqual(
          CANNOT_EDIT_PERSON,
        );
      }
    }
  });
});
