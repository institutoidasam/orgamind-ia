import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { DomainError } from '../../shared/errors/domain.error';
import { PermissionsRepository } from './permissions.repository';

const ATTEMPTS = 3;

function knownError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('conflito', {
    code,
    clientVersion: 'test',
  });
}

function build(transaction: ReturnType<typeof vi.fn>) {
  const prisma = { $transaction: transaction } as unknown as PrismaService;
  return new PermissionsRepository(prisma);
}

describe('PermissionsRepository.serializable — conflito de gravação', () => {
  it('esgota as tentativas em P2034 e responde 409 permissions.conflict', async () => {
    const transaction = vi.fn().mockRejectedValue(knownError('P2034'));

    const result = build(transaction).serializable(() => Promise.resolve('ok'));

    await expect(result).rejects.toMatchObject({
      code: 'permissions.conflict',
      status: 409,
      message: 'Permissões não alteradas',
      detail:
        'As permissões foram alteradas por outra pessoa ao mesmo tempo. Recarregue a tela e tente de novo.',
    });
    await expect(result).rejects.toBeInstanceOf(DomainError);
    expect(transaction).toHaveBeenCalledTimes(ATTEMPTS);
  });

  it('refaz a transação que perde uma vez e devolve o resultado da seguinte', async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(knownError('P2002'))
      .mockResolvedValueOnce('gravado');

    const result = await build(transaction).serializable(() =>
      Promise.resolve('ok'),
    );

    expect(result).toBe('gravado');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('sobe sem conversão e sem nova tentativa o erro que não é de concorrência', async () => {
    const other = knownError('P2003');
    const transaction = vi.fn().mockRejectedValue(other);

    await expect(
      build(transaction).serializable(() => Promise.resolve('ok')),
    ).rejects.toBe(other);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
