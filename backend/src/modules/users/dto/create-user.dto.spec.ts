import { describe, it, expect } from 'vitest';

import { createUserSchema } from './create-user.dto';
import { grantAccessSchema } from './grant-access.dto';
import { listUsersQuerySchema } from './list-users.dto';
import { updateUserSchema } from './update-user.dto';

const PHONE = '92991234567';

describe('createUserSchema.email normalization', () => {
  it('lowercases the email so duplicate accounts cannot be created by case', () => {
    // Regression: without `.trim().toLowerCase()`, `Foo@Bar.com` and
    // `foo@bar.com` would create two distinct rows in the case-sensitive
    // `email String @unique` column.
    const parsed = createUserSchema.parse({
      email: 'Foo@Bar.COM',
      phone: PHONE,
    });
    expect(parsed.email).toBe('foo@bar.com');
  });

  it('trims surrounding whitespace from the email', () => {
    const parsed = createUserSchema.parse({
      email: '  user@example.com  ',
      phone: PHONE,
    });
    expect(parsed.email).toBe('user@example.com');
  });

  it('trims and lowercases together', () => {
    const parsed = createUserSchema.parse({
      email: '  New.User@Example.COM ',
      phone: PHONE,
    });
    expect(parsed.email).toBe('new.user@example.com');
  });
});

describe('createUserSchema — phone', () => {
  it('exige phone', () => {
    expect(createUserSchema.safeParse({ email: 'a@b.com' }).success).toBe(
      false,
    );
  });

  it('aceita phone com DDD e apara espaços', () => {
    expect(
      createUserSchema.parse({ email: 'a@b.com', phone: ' (92) 99123-4567 ' })
        .phone,
    ).toBe('(92) 99123-4567');
  });
});

describe('updateUserSchema — phone', () => {
  it('aceita só phone como mudança', () => {
    expect(updateUserSchema.safeParse({ phone: '92991234567' }).success).toBe(
      true,
    );
  });

  it.each([null, ''])('recusa phone %j (não dá para apagar)', (phone) => {
    expect(updateUserSchema.safeParse({ phone }).success).toBe(false);
  });
});

describe('createUserSchema — sectorId', () => {
  const base = { email: 'a@b.com', phone: PHONE, role: 'ADMIN' };

  it('aceita sectorId null ("Sem setor") e normaliza para undefined', () => {
    // Regression: o front envia `sectorId: null` para ADMIN sem setor; antes
    // o schema recusava com "expected string, received null" (POST /users 400).
    const result = createUserSchema.safeParse({ ...base, sectorId: null });
    expect(result.success).toBe(true);
    expect(result.data?.sectorId).toBeUndefined();
  });

  it('preserva sectorId string', () => {
    expect(
      createUserSchema.parse({ ...base, sectorId: 'sector-1' }).sectorId,
    ).toBe('sector-1');
  });

  it('mantém sectorId ausente como undefined', () => {
    expect(createUserSchema.parse(base).sectorId).toBeUndefined();
  });
});

describe('createUserSchema — pessoa sem acesso (hasAccess false)', () => {
  const person = { hasAccess: false, name: '  Maria  ', phone: PHONE };

  it('aceita nome, telefone, setor null e nível; apara o nome', () => {
    const parsed = createUserSchema.parse({
      ...person,
      sectorId: null,
      levelId: 'level_employee',
    });
    expect(parsed).toMatchObject({
      hasAccess: false,
      name: 'Maria',
      sectorId: null,
      levelId: 'level_employee',
    });
  });

  it.each([
    ['email', { email: 'a@b.com' }],
    ['role', { role: 'OPERATOR' }],
    ['sem nome', { name: '   ' }],
    ['sem telefone', { phone: undefined }],
  ])('POST hasAccess false com %s → 400', (_case, extra) => {
    expect(createUserSchema.safeParse({ ...person, ...extra }).success).toBe(
      false,
    );
  });

  it('POST sem hasAccess segue exigindo email', () => {
    expect(createUserSchema.safeParse({ phone: PHONE }).success).toBe(false);
    expect(
      createUserSchema.parse({ email: 'a@b.com', phone: PHONE }).role,
    ).toBe('OPERATOR');
  });

  it('convite (com acesso) mantém levelId', () => {
    const invite = { email: 'a@b.com', phone: PHONE };
    expect(
      createUserSchema.parse({ ...invite, levelId: 'level_employee' }),
    ).toMatchObject({ levelId: 'level_employee' });
    expect(createUserSchema.parse({ ...invite, levelId: null })).toHaveProperty(
      'levelId',
      null,
    );
  });
});

describe('listUsersQuerySchema — hasAccess', () => {
  it.each([
    ['true', true],
    ['false', false],
  ])("hasAccess '%s' → %s", (raw, value) => {
    expect(listUsersQuerySchema.parse({ hasAccess: raw }).hasAccess).toBe(
      value,
    );
  });

  it("hasAccess 'sim' → 400; sem o filtro fica undefined", () => {
    expect(listUsersQuerySchema.safeParse({ hasAccess: 'sim' }).success).toBe(
      false,
    );
    expect(listUsersQuerySchema.parse({}).hasAccess).toBeUndefined();
  });
});

describe('grantAccessSchema e levelId no PATCH', () => {
  it('dar acesso normaliza o e-mail e exige papel', () => {
    expect(
      grantAccessSchema.parse({ email: ' Ana@X.COM ', role: 'OPERATOR' }),
    ).toEqual({ email: 'ana@x.com', role: 'OPERATOR' });
    expect(grantAccessSchema.safeParse({ email: 'a@x.com' }).success).toBe(
      false,
    );
  });

  it.each([
    [{ levelId: null }, true],
    [{ levelId: 'level_leader' }, true],
    [{ levelId: '' }, false],
  ])('updateUserSchema %o → válido=%s', (body, ok) => {
    expect(updateUserSchema.safeParse(body).success).toBe(ok);
  });
});
