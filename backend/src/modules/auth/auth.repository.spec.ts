import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, MockProxy } from 'vitest-mock-extended';
import { AuthRepository } from './auth.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';

describe('AuthRepository', () => {
  let repo: AuthRepository;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    repo = new AuthRepository(prisma);
  });

  it('findByEmail calls prisma.user.findUnique with where.email', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await repo.findByEmail('a@b.c');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'a@b.c' } });
  });

  it('findById calls prisma.user.findUnique with where.id', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await repo.findById('u1');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });
});
