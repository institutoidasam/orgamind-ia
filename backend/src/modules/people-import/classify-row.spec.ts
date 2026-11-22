import { describe, expect, it } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { RawFields } from './cell-values';
import { classifyWith, personWith } from './classify-row.fixtures';
import { toImportActor } from './import-actor';
import type { ImportPerson, RowVerdict } from './import-person';
import { personFingerprint } from './person-diff';
import { ROW_TEXT } from './row-texts';

const ADMIN = toImportActor({ ...actorWith('ADMIN'), managedSectorIds: [] });

const MARINA = personWith();
const RAFAEL = personWith({
  id: 'p-rafael',
  name: 'Rafael Lima',
  phoneE164: '+5592991110002',
  registration: 'MAT-02',
  registrationKey: 'mat-02',
});
const NO_REGISTRATION = personWith({
  id: 'p-sem-matricula',
  name: 'Ana Costa',
  phoneE164: '+5592991110006',
  registration: null,
  registrationKey: null,
});

const asAdmin = (
  cells: Partial<RawFields>,
  people: readonly ImportPerson[] = [MARINA, RAFAEL, NO_REGISTRATION],
) => classifyWith({ actor: ADMIN, cells, people });

const rejected = (
  classification: RowVerdict['classification'],
  reasons: string[],
): RowVerdict => ({
  classification,
  reasons,
  warnings: [],
  preview: null,
  plan: null,
  personId: null,
});

describe('classifyRow, ADMIN: Conflito sem revelar o dono', () => {
  it('aceite 17: matrícula de uma pessoa e telefone de outra dá Conflito sem revelar quem', () => {
    const verdict = asAdmin({
      registration: 'MAT-01',
      phone: '+5592991110002',
    });

    expect(verdict).toStrictEqual(rejected('CONFLICT', [ROW_TEXT.phoneTaken]));
  });

  it('telefone de pessoa com outra matrícula dá Conflito', () => {
    const verdict = asAdmin({
      registration: 'MAT-77',
      name: 'Elisa Prado',
      phone: '(92) 99111-0002',
    });

    expect(verdict).toStrictEqual(rejected('CONFLICT', [ROW_TEXT.phoneTaken]));
  });

  it('pessoa achada pelo telefone e sem matrícula recebe a da planilha', () => {
    const verdict = asAdmin({
      registration: 'MAT-06',
      phone: '+5592991110006',
    });

    expect(verdict.classification).toBe('UPDATE');
    expect(verdict.personId).toBe('p-sem-matricula');
    expect(verdict.plan).toMatchObject({
      kind: 'update',
      personId: 'p-sem-matricula',
      patch: { registration: 'MAT-06' },
    });
  });
});

describe('classifyRow, ADMIN: Conflito com o texto fixo (Conselho S)', () => {
  it('S1-3: com telefone.ver_completo e para o ADMIN, Conflito de telefone traz só o texto fixo', () => {
    const verdict = asAdmin({
      registration: 'MAT-01',
      phone: '+5592991110002',
    });

    expect(verdict).toStrictEqual(rejected('CONFLICT', [ROW_TEXT.phoneTaken]));
    const text = JSON.stringify(verdict);
    for (const owner of ['Rafael', 'MAT-02', 'mat-02', 'p-rafael', 's-prod']) {
      expect(text).not.toContain(owner);
    }
    expect(text).not.toContain('Produção');
  });
});

describe('classifyRow, ADMIN: linhas Inválidas e Ignoradas', () => {
  it('aceite 18: setor inexistente deixa a linha Inválida com o nome', () => {
    const reason = ROW_TEXT.notFound('Setor', 'Galpão 9');
    const newPerson = { name: 'Elisa Prado', phone: '+5592991110009' };

    expect(asAdmin({ ...newPerson, sector: 'Galpão 9' })).toStrictEqual(
      rejected('INVALID', [reason]),
    );
    expect(
      asAdmin({ registration: 'MAT-01', sector: 'Galpão 9' }),
    ).toStrictEqual(rejected('INVALID', [reason]));
  });

  it('sem matrícula nem telefone válido: Inválida', () => {
    for (const phone of ['', '•••• 0001', '123']) {
      expect(asAdmin({ name: 'Elisa Prado', phone })).toStrictEqual(
        rejected('INVALID', [ROW_TEXT.noKey]),
      );
    }
  });

  it('pessoa nova exige nome e telefone; nome mascarado é Nome inválido', () => {
    expect(
      asAdmin({ registration: 'MAT-50', jobTitle: 'Técnico' }),
    ).toStrictEqual(
      rejected('INVALID', [ROW_TEXT.newNeedsName, ROW_TEXT.newNeedsPhone]),
    );
    expect(
      asAdmin({
        registration: 'MAT-50',
        name: '•••• 2008',
        phone: '•••• 0009',
      }),
    ).toStrictEqual(
      rejected('INVALID', [ROW_TEXT.invalidName, ROW_TEXT.newNeedsPhone]),
    );
  });
});

describe('classifyRow, ADMIN: autorização inválida e linhas Ignoradas', () => {
  it('erro de célula da autorização invalida a linha de quem pode alterá-la', () => {
    const verdict = asAdmin({
      name: 'Elisa Prado',
      phone: '+5592991110009',
      authorization: 'talvez',
      authorizationDate: '31/02/2026',
    });

    expect(verdict).toStrictEqual(
      rejected('INVALID', [ROW_TEXT.invalidYesNo, ROW_TEXT.invalidDate]),
    );
  });

  it('linha de exemplo e linha em branco ficam Ignoradas', () => {
    const example = asAdmin({ registration: 'Exemplo', name: 'Maria Exemplo' });

    expect(example).toStrictEqual(rejected('IGNORED', [ROW_TEXT.example]));
    expect(asAdmin({})).toStrictEqual(rejected('IGNORED', [ROW_TEXT.blank]));
  });
});

describe('classifyRow, ADMIN: Sem alteração e pessoa inativa', () => {
  const INACTIVE = personWith({
    id: 'p-inativa',
    registration: 'MAT-07',
    registrationKey: 'mat-07',
    phoneE164: '+5592991110007',
    sectorId: 's-old',
    isActive: false,
  });

  it('ADMIN: Sem alteração vale para pessoa inativa e setor inativo iguais aos atuais', () => {
    const verdict = asAdmin(
      {
        registration: 'mat-07',
        phone: '(92) 99111-0007',
        sector: 'galpao antigo',
      },
      [INACTIVE],
    );

    expect(verdict).toStrictEqual({
      classification: 'UNCHANGED',
      reasons: [],
      warnings: [],
      preview: { personName: 'Marina Souza', diff: [] },
      plan: null,
      personId: 'p-inativa',
    });
  });

  it('pessoa inativa com mudança: Inválida, reative na ficha', () => {
    const verdict = asAdmin({ registration: 'MAT-07', jobTitle: 'Gerente' }, [
      INACTIVE,
    ]);

    expect(verdict).toStrictEqual(
      rejected('INVALID', [ROW_TEXT.inactivePerson]),
    );
  });
});

describe('classifyRow, ADMIN: pessoa com login', () => {
  it('troca de setor de pessoa com login avisa que terá de entrar de novo', () => {
    const withLogin = [personWith({ hasAccess: true })];

    const moved = asAdmin(
      { registration: 'MAT-01', sector: 'Logística' },
      withLogin,
    );
    const renamed = asAdmin(
      { registration: 'MAT-01', name: 'Marina S.' },
      withLogin,
    );

    expect(moved.classification).toBe('UPDATE');
    expect(moved.warnings).toEqual([ROW_TEXT.mustLoginAgain]);
    expect(renamed.classification).toBe('UPDATE');
    expect(renamed.warnings).toEqual([]);
  });
});

describe('classifyRow, ADMIN: Atualizar e Criar', () => {
  it('Atualizar traz plan com personId, fingerprint e patch, e preview com o diff', () => {
    const verdict = asAdmin({
      registration: 'MAT-01',
      name: 'Marina Souza Lima',
      shift: 'Noite',
    });

    expect(verdict).toStrictEqual({
      classification: 'UPDATE',
      reasons: [],
      warnings: [],
      preview: {
        personName: 'Marina Souza',
        diff: [
          { field: 'name', before: 'Marina Souza', after: 'Marina Souza Lima' },
          { field: 'shift', before: 'Manhã', after: 'Noite' },
        ],
      },
      plan: {
        kind: 'update',
        keys: { registrationKey: 'mat-01', phoneE164: null },
        personId: 'p-marina',
        fingerprint: personFingerprint(MARINA),
        patch: { name: 'Marina Souza Lima', shiftId: 'sh-not' },
      },
      personId: 'p-marina',
    });
  });
});

describe('classifyRow, ADMIN: Criar', () => {
  it('Criar traz o plano da pessoa nova; sem autorização, o aviso', () => {
    const cells = { name: 'Elisa Prado', phone: '(92) 99111-0009' };
    const bare = asAdmin(cells);
    const full = asAdmin({
      ...cells,
      registration: 'MAT-09',
      jobTitle: 'Técnica',
      sector: 'Produção',
      shift: 'Noite',
      authorization: 'Sim',
      authorizationSource: 'Termo assinado',
    });

    expect(bare).toStrictEqual({
      ...rejected('CREATE', []),
      warnings: [ROW_TEXT.newWithoutAuthorization],
      plan: {
        kind: 'create',
        keys: { registrationKey: null, phoneE164: '+5592991110009' },
        input: { name: 'Elisa Prado', phone: '+5592991110009' },
      },
    });
    expect(full.warnings).toEqual([]);
    expect(full.plan).toStrictEqual({
      kind: 'create',
      keys: { registrationKey: 'mat-09', phoneE164: '+5592991110009' },
      input: {
        name: 'Elisa Prado',
        phone: '+5592991110009',
        sectorId: 's-prod',
        shiftId: 'sh-not',
        jobTitle: 'Técnica',
        registration: 'MAT-09',
        contactAuthorization: {
          status: 'AUTORIZADO',
          source: 'TERMO_ASSINADO',
        },
      },
    });
  });
});
