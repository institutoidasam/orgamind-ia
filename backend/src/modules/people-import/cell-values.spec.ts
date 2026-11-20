import { describe, expect, it } from 'vitest';
import {
  IMPORT_FIELDS,
  type ColumnMapping,
} from '../../schemas/contracts/people-import.schema';
import { phoneView, nameView } from '../../shared/authz/phone-visibility';
import {
  fieldsOf,
  isMaskedPhoneText,
  parseFields,
  rowCellsOf,
  type RawFields,
} from './cell-values';
import { ROW_TEXT } from './row-texts';

const PHONE = '+5592991112008';

function raw(over: Partial<RawFields> = {}): RawFields {
  const empty = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, '']));
  return { ...empty, ...over } as RawFields;
}

function mappingOf(over: Partial<ColumnMapping>): ColumnMapping {
  const none = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null]));
  return { ...none, ...over } as ColumnMapping;
}

describe('leitura das células e telefone', () => {
  it('fieldsOf lê só as colunas mapeadas e apara', () => {
    const cells = rowCellsOf([' 123 ', ' Ana Souza ', '(92) 99111-2008', 'x']);
    expect(cells).toEqual({
      '0': ' 123 ',
      '1': ' Ana Souza ',
      '2': '(92) 99111-2008',
      '3': 'x',
    });
    const mapping = mappingOf({ registration: 0, name: 1, phone: 2, level: 9 });
    expect(fieldsOf(cells, mapping)).toEqual(
      raw({ registration: '123', name: 'Ana Souza', phone: '(92) 99111-2008' }),
    );
  });

  it('telefone em todas as grafias vira E.164', () => {
    const spellings = [
      '(92) 99111-2008',
      '92991112008',
      '5592991112008',
      '+55 92 99111-2008',
    ];
    for (const phone of spellings) {
      expect(parseFields(raw({ phone })).phoneE164).toBe(PHONE);
    }
    expect(parseFields(raw({ phone: '+1 415 555 2671' })).phoneE164).toBe(
      '+14155552671',
    );
    expect(parseFields(raw({ phone: '(92) 9111-2008' })).phoneE164).toBe(
      '+559291112008',
    );
  });
});

describe('texto mascarado da exportação', () => {
  it('telefone e nome no padrão mascarado contam como vazio', () => {
    const maskedPhone = phoneView(PHONE, { full: false }).phoneMasked ?? '';
    const shortMask = phoneView('+559', { full: false }).phoneMasked ?? '';
    const maskedName = nameView('(92) 99111-2008', { full: false });
    expect([maskedPhone, shortMask, maskedName]).toEqual([
      '•••• 2008',
      '••••',
      '•••• 2008',
    ]);
    for (const text of [maskedPhone, shortMask, maskedName]) {
      expect(isMaskedPhoneText(text)).toBe(true);
    }
    for (const text of [
      '•••',
      '••••• 2008',
      '•••• 200',
      '•••• 2008 x',
      'Ana',
      PHONE,
      '',
    ]) {
      expect(isMaskedPhoneText(text)).toBe(false);
    }
    const parsed = parseFields(raw({ name: maskedName, phone: maskedPhone }));
    expect(parsed).toMatchObject({
      name: null,
      nameMasked: true,
      phoneE164: null,
      phoneMasked: true,
      errors: [],
    });
    expect(parseFields(raw({ name: 'Ana', phone: PHONE }))).toMatchObject({
      name: 'Ana',
      nameMasked: false,
      phoneE164: PHONE,
      phoneMasked: false,
    });
  });
});

describe('motivos de linha e marcas de exemplo e branco', () => {
  it('telefone inválido e tamanhos acima do limite viram motivos', () => {
    expect(parseFields(raw({ phone: 'abc' })).errors).toEqual([
      ROW_TEXT.invalidPhone,
    ]);
    const atLimit = raw({
      name: 'n'.repeat(120),
      jobTitle: 'f'.repeat(80),
      registration: 'm'.repeat(30),
    });
    expect(parseFields(atLimit).errors).toEqual([]);
    const over = raw({
      name: 'n'.repeat(121),
      jobTitle: 'f'.repeat(81),
      registration: 'm'.repeat(31),
      phone: '123',
    });
    expect(parseFields(over).errors).toEqual([
      ROW_TEXT.tooLong('Matrícula', 30),
      ROW_TEXT.tooLong('Nome', 120),
      ROW_TEXT.invalidPhone,
      ROW_TEXT.tooLong('Função', 80),
    ]);
  });

  it('matrícula EXEMPLO marca a linha de exemplo; tudo vazio marca linha em branco', () => {
    const example = parseFields(raw({ registration: 'ExEmPlO', name: 'Ana' }));
    expect(example).toMatchObject({ isExample: true, isBlank: false });
    const blank = parseFields(raw());
    expect(blank).toMatchObject({
      isBlank: true,
      isExample: false,
      errors: [],
    });
    expect(parseFields(raw({ sector: 'Logística' })).isBlank).toBe(false);
    const viaCells = fieldsOf(
      rowCellsOf(['  ', '']),
      mappingOf({ registration: 0, name: 1 }),
    );
    expect(parseFields(viaCells).isBlank).toBe(true);
  });
});

describe('campos de identidade e cadastro', () => {
  it('matrícula gera a chave em minúsculas', () => {
    expect(parseFields(raw({ registration: 'AB-123' })).registration).toEqual({
      value: 'AB-123',
      key: 'ab-123',
    });
    expect(parseFields(raw()).registration).toBeNull();
  });

  it('função, setor, turno e nível saem aparados; vazio vira null', () => {
    const parsed = parseFields(
      raw({ jobTitle: 'Técnica', sector: 'Logística', shift: 'Noite' }),
    );
    expect(parsed).toMatchObject({
      jobTitle: 'Técnica',
      sector: 'Logística',
      shift: 'Noite',
      level: null,
    });
  });
});
