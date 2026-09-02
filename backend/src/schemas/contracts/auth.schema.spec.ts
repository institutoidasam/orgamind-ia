import { describe, it, expect } from 'vitest';

import { loginInputSchema } from './auth.schema';

describe('loginInputSchema.email normalization', () => {
  it('lowercases the email so login is case-insensitive', () => {
    // Regression: `z.string().email()` without normalization made login
    // case-sensitive and allowed duplicate accounts differing only by case,
    // because the `email String @unique` column is case-sensitive in Postgres.
    const parsed = loginInputSchema.parse({
      email: 'Foo@Bar.COM',
      password: 'password123',
    });
    expect(parsed.email).toBe('foo@bar.com');
  });

  it('trims surrounding whitespace from the email', () => {
    const parsed = loginInputSchema.parse({
      email: '  user@example.com  ',
      password: 'password123',
    });
    expect(parsed.email).toBe('user@example.com');
  });

  it('trims and lowercases together', () => {
    const parsed = loginInputSchema.parse({
      email: '  Admin@Example.Com ',
      password: 'password123',
    });
    expect(parsed.email).toBe('admin@example.com');
  });
});
