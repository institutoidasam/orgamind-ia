import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));

// Sem banco: só o `user.upsert` do admin importa aqui (o seed completo é o
// `seed.spec.ts`, que exige banco de teste).
vi.mock('@prisma/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  return {
    ...actual,
    PrismaClient: class {
      user = { upsert };
    },
  };
});

import { seedAdmin } from './seed';

describe('seedAdmin', () => {
  beforeEach(() => {
    upsert.mockReset();
    process.env.SEED_ADMIN_EMAIL = 'admin@test.local';
  });

  it('cria o admin AUTORIZADO / OUTRO com a nota do seed e não altera um admin existente', async () => {
    const email = await seedAdmin();

    const [args] = upsert.mock.calls[0] as [
      { where: unknown; update: unknown; create: Record<string, unknown> },
    ];
    expect(email).toBe('admin@test.local');
    expect(args.where).toEqual({ email: 'admin@test.local' });
    expect(args.update).toEqual({});
    expect(args.create).toMatchObject({
      role: 'ADMIN',
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'OUTRO',
      authorizationNote: 'Seed de desenvolvimento',
    });
    expect(args.create.authorizationRecordedAt).toBeInstanceOf(Date);
  });
});
