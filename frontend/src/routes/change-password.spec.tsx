import { describe, it, expect, vi } from 'vitest';
import { changePasswordSchema } from '@/features/auth/schemas';

describe('changePasswordSchema', () => {
  it('rejects when newPassword shorter than 8 chars', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword: 'short',
      confirmPassword: 'short',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/8/);
  });

  it('rejects when passwords do not match', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword: 'LongEnough1!',
      confirmPassword: 'Different99!',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toContain('confirmPassword');
  });

  it('passes with matching passwords >= 8 chars', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword: 'NewPass1!',
      confirmPassword: 'NewPass1!',
    });
    expect(result.success).toBe(true);
  });
});
