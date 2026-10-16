import { describe, it, expect } from 'vitest';

import { createUserSchema } from './create-user.dto';
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
