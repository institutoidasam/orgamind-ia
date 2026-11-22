import { describe, expect, it } from 'vitest';
import {
  IMPORT_FIELD_LABEL,
  IMPORT_FIELDS,
  type ColumnMapping,
} from '../../schemas/contracts/people-import.schema';
import {
  PEOPLE_EXPORT_COLUMNS,
  PEOPLE_TEMPLATE_COLUMNS,
} from '../../shared/spreadsheet/people-columns';
import {
  mappedColumns,
  mappingProblem,
  normalizeHeader,
  suggestMapping,
  unmappedColumns,
} from './mapping';

function emptyMapping(overrides: Partial<ColumnMapping> = {}): ColumnMapping {
  const base = Object.fromEntries(
    IMPORT_FIELDS.map((field) => [field, null]),
  ) as ColumnMapping;
  return { ...base, ...overrides };
}

const MESSAGE_KEY =
  'Escolha a coluna de Nome e pelo menos uma entre Telefone e Matrícula.';
const MESSAGE_SECTOR =
  'Escolha a coluna de Setor: quem não é administrador informa o setor em todas as linhas.';

describe('suggestMapping: rótulos exibidos na tela (T5 m1)', () => {
  it('o rótulo de cada campo, como a tela o mostra, sugere o próprio campo', () => {
    const labels = IMPORT_FIELDS.map((field) => IMPORT_FIELD_LABEL[field]);
    const expected = Object.fromEntries(
      IMPORT_FIELDS.map((field, index) => [field, index]),
    );

    expect(suggestMapping(labels)).toEqual(expected);
  });
});

describe('normalizeHeader', () => {
  it('tira acento, caixa, espaço, sublinhado e hífen', () => {
    expect(normalizeHeader(' Autorização_de-Contato ')).toBe(
      'autorizacaodecontato',
    );
  });
});

describe('suggestMapping', () => {
  it('aceite 13: celular e cargo são reconhecidos, sem diferenciar acento, caixa, espaço e sublinhado', () => {
    const mapping = suggestMapping([
      'Celular',
      ' CARGO ',
      'Área',
      'Crachá',
      'Funcionário',
    ]);
    expect(mapping).toEqual(
      emptyMapping({
        phone: 0,
        jobTitle: 1,
        sector: 2,
        registration: 3,
        name: 4,
      }),
    );
  });

  it('cabeçalhos do modelo mapeiam os onze campos; situacao e tem_acesso ficam Não usar', () => {
    const mapping = suggestMapping([...PEOPLE_EXPORT_COLUMNS]);
    expect(mapping).toEqual({
      registration: 0,
      name: 1,
      phone: 2,
      jobTitle: 3,
      sector: 4,
      shift: 5,
      level: 6,
      authorization: 7,
      authorizationSource: 8,
      authorizationNote: 9,
      authorizationDate: 10,
    });
    expect(PEOPLE_TEMPLATE_COLUMNS).toHaveLength(11);
    expect(unmappedColumns(mapping, PEOPLE_EXPORT_COLUMNS.length)).toEqual([
      11, 12,
    ]);
  });

  it('campo recebe só a primeira coluna que casa', () => {
    const mapping = suggestMapping(['Nome', 'Colaborador', 'Fone', 'WhatsApp']);
    expect(mapping.name).toBe(0);
    expect(mapping.phone).toBe(2);
    expect(mappedColumns(mapping)).toEqual([0, 2]);
  });
});

describe('mappingProblem', () => {
  const ok = emptyMapping({ name: 0, phone: 1, sector: 2 });

  it('mappingProblem: Nome e Telefone ou Matrícula; Setor para quem não é ADMIN; coluna fora do arquivo; coluna repetida', () => {
    const base = { headerCount: 3, isAdmin: false };
    expect(mappingProblem(ok, base)).toBeNull();
    expect(mappingProblem(emptyMapping({ phone: 0, sector: 1 }), base)).toBe(
      MESSAGE_KEY,
    );
    expect(mappingProblem(emptyMapping({ name: 0, sector: 1 }), base)).toBe(
      MESSAGE_KEY,
    );
    expect(
      mappingProblem(
        emptyMapping({ name: 0, registration: 1, sector: 2 }),
        base,
      ),
    ).toBeNull();
    expect(mappingProblem(emptyMapping({ name: 0, phone: 1 }), base)).toBe(
      MESSAGE_SECTOR,
    );
    expect(
      mappingProblem(emptyMapping({ name: 0, phone: 1 }), {
        ...base,
        isAdmin: true,
      }),
    ).toBeNull();
    expect(mappingProblem({ ...ok, sector: 3 }, base)).toBe(
      'Coluna inexistente no arquivo.',
    );
    expect(mappingProblem({ ...ok, sector: 1 }, base)).toBe(
      'Cada coluna serve a um campo só.',
    );
  });
});

describe('mappedColumns e unmappedColumns', () => {
  it('mappedColumns e unmappedColumns em ordem crescente', () => {
    const mapping = emptyMapping({ name: 4, phone: 1, sector: 2 });
    expect(mappedColumns(mapping)).toEqual([1, 2, 4]);
    expect(unmappedColumns(mapping, 6)).toEqual([0, 3, 5]);
  });
});
