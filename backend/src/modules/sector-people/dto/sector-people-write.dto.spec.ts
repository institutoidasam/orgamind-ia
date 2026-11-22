import { ZodValidationPipe } from 'nestjs-zod';
import { describe, expect, it } from 'vitest';
import {
  addFromContactsBodySchema,
  createSectorPersonBodySchema,
  movePeopleBodySchema,
  removeSectorPersonBodySchema,
  sectorPeopleListQuerySchema,
  sectorPersonStatusBodySchema,
  updateSectorPersonBodySchema,
} from '../../../schemas/contracts/sector-people.schema';
import { RemoveSectorPersonDto } from './remove-sector-person.dto';

const NEW_PERSON = { name: 'Rita', phone: '92991110001', shiftId: 'shift_1' };
const SCHEMAS = {
  create: { schema: createSectorPersonBodySchema, body: NEW_PERSON },
  update: { schema: updateSectorPersonBodySchema, body: { jobTitle: 'Aux' } },
  fromContacts: {
    schema: addFromContactsBodySchema,
    body: { contactIds: ['contact_1'], shiftId: 'shift_1' },
  },
  move: { schema: movePeopleBodySchema, body: { userIds: ['user_1'] } },
};
type SchemaName = keyof typeof SCHEMAS;

const FORBIDDEN_KEYS = [
  ['email', 'ana@test.local'],
  ['role', 'ADMIN'],
  ['hasAccess', true],
  ['sectorId', 'sector_it'],
] as const;
const ROWS = (['create', 'update'] as const).flatMap((name) =>
  FORBIDDEN_KEYS.map(([key, value]) => ({ name, key, value })),
);

describe('DTOs da lista e do status do setor (A3, D6)', () => {
  it('lista: sem parâmetro ou "false" → só ativos; "true" → inclui inativos; outro valor → 400', () => {
    const parse = (query: unknown) =>
      sectorPeopleListQuerySchema.safeParse(query);
    expect(parse({})).toMatchObject({ data: { includeInactive: false } });
    expect(parse({ includeInactive: 'false' })).toMatchObject({
      data: { includeInactive: false },
    });
    expect(parse({ includeInactive: 'true' })).toMatchObject({
      data: { includeInactive: true },
    });
    expect(parse({ includeInactive: 'sim' }).success).toBe(false);
  });

  it('status: isActive booleano, motivo aparado de até 200 e nada além disso', () => {
    const parse = (body: unknown) =>
      sectorPersonStatusBodySchema.safeParse(body);
    expect(parse({ isActive: false, reason: ' Desligamento ' })).toMatchObject({
      data: { isActive: false, reason: 'Desligamento' },
    });
    expect(parse({ isActive: true }).success).toBe(true);
    expect(parse({ isActive: 'false' }).success).toBe(false);
    expect(parse({ isActive: true, reason: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(parse({ isActive: true, role: 'ADMIN' }).success).toBe(false);
  });
});

describe('DTOs de escrita da página do setor — ficha, autorização e motivo', () => {
  const FORMER = { status: 'AUTORIZADO', source: 'CADASTRO_ANTERIOR' };
  const GRANTED = { status: 'AUTORIZADO', source: 'TERMO_ASSINADO' };

  it.each(['create', 'update', 'fromContacts'] as const)(
    '%s: CADASTRO_ANTERIOR na entrada → 400 (D15)',
    (name) => {
      const { schema, body } = SCHEMAS[name];
      expect(
        schema.safeParse({ ...body, contactAuthorization: FORMER }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...body, contactAuthorization: GRANTED }).success,
      ).toBe(true);
    },
  );

  it('update: só reason → 400; matrícula null limpa e passa', () => {
    const { schema } = SCHEMAS.update;
    expect(schema.safeParse({ reason: 'Correção' }).success).toBe(false);
    const cleared = schema.safeParse({ registration: null });
    expect(cleared.success && cleared.data.registration).toBeNull();
  });

  it('create, update, move e remove aceitam os campos novos', () => {
    const create = { ...NEW_PERSON, registration: 'M-1' };
    expect(createSectorPersonBodySchema.safeParse(create).success).toBe(true);
    expect(
      updateSectorPersonBodySchema.safeParse({
        jobTitle: 'Aux',
        reason: 'Ajuste',
      }).success,
    ).toBe(true);
    expect(
      movePeopleBodySchema.safeParse({ userIds: ['u1'], reason: 'Mudou' })
        .success,
    ).toBe(true);
    expect(removeSectorPersonBodySchema.safeParse({}).success).toBe(true);
    expect(
      removeSectorPersonBodySchema.safeParse({ reason: 'Saiu', x: 1 }).success,
    ).toBe(false);
  });
});

describe('DTO do DELETE da página do setor — corpo opcional', () => {
  const pipe = new ZodValidationPipe();
  const parse = (body: unknown): unknown =>
    pipe.transform(body, { type: 'body', metatype: RemoveSectorPersonDto });

  it('sem corpo (Express 5: undefined) vira {}; com motivo, mantém', () => {
    expect(parse(undefined)).toEqual({});
    expect(parse({ reason: 'Saiu da equipe' })).toEqual({
      reason: 'Saiu da equipe',
    });
  });
});

describe('DTOs de escrita da página do setor', () => {
  it.each(Object.keys(SCHEMAS) as SchemaName[])(
    '%s: body mínimo válido passa',
    (name) => {
      const { schema, body } = SCHEMAS[name];
      expect(schema.safeParse(body).success).toBe(true);
    },
  );

  it.each(ROWS)(
    '$name: body com $key → 400 (.strict())',
    ({ name, key, value }) => {
      const { schema, body } = SCHEMAS[name];
      expect(schema.safeParse({ ...body, [key]: value }).success).toBe(false);
    },
  );

  it.each(['create', 'fromContacts'] as const)(
    '%s: sem shiftId → 400 (Q3)',
    (name) => {
      const { schema, body } = SCHEMAS[name];
      const withoutShift: Record<string, unknown> = { ...body };
      delete withoutShift.shiftId;
      expect(schema.safeParse(withoutShift).success).toBe(false);
    },
  );

  it.each([
    { name: 'fromContacts', body: { contactIds: [], shiftId: 'shift_1' } },
    { name: 'move', body: { userIds: [] } },
    { name: 'update', body: {} },
  ] as const)('$name: lista vazia ou patch vazio → 400', ({ name, body }) => {
    expect(SCHEMAS[name].schema.safeParse(body).success).toBe(false);
  });
});
