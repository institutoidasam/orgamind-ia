import { describe, expect, it } from 'vitest';
import {
  addFromContactsBodySchema,
  createSectorPersonBodySchema,
  movePeopleBodySchema,
  updateSectorPersonBodySchema,
} from '../../../schemas/contracts/sector-people.schema';

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
