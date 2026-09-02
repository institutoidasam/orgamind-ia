import { describe, it, expect } from 'vitest';

import { createUserSchema } from './create-user.dto';

describe('createUserSchema.email normalization', () => {
  it('lowercases the email so duplicate accounts cannot be created by case', () => {
    // Regression: without `.trim().toLowerCase()`, `Foo@Bar.com` and
    // `foo@bar.com` would create two distinct rows in the case-sensitive
    // `email String @unique` column.
    const parsed = createUserSchema.parse({ email: 'Foo@Bar.COM' });
    expect(parsed.email).toBe('foo@bar.com');
  });

  it('trims surrounding whitespace from the email', () => {
    const parsed = createUserSchema.parse({ email: '  user@example.com  ' });
    expect(parsed.email).toBe('user@example.com');
  });

  it('trims and lowercases together', () => {
    const parsed = createUserSchema.parse({ email: '  New.User@Example.COM ' });
    expect(parsed.email).toBe('new.user@example.com');
  });
});
