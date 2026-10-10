import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthRepository } from './auth.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';

describe('AuthRepository', () => {
  let repo: AuthRepository;
  const findUnique = vi.fn<(args: unknown) => Promise<null>>();

  beforeEach(() => {
    findUnique.mockReset();
    repo = new AuthRepository({
      user: { findUnique },
    } as unknown as PrismaService);
  });

  it('findByEmail calls prisma.user.findUnique with where.email', async () => {
    findUnique.mockResolvedValue(null);

    await repo.findByEmail('a@b.c');

    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'a@b.c' },
      include: { sector: true },
    });
  });

  it('findById calls prisma.user.findUnique with where.id', async () => {
    findUnique.mockResolvedValue(null);

    await repo.findById('u1');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      include: { sector: true },
    });
  });
});
