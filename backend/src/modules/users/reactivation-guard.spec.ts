import { describe, expect, it, vi } from 'vitest';
import { assertReactivationAllowed } from './reactivation-guard';

const INACTIVE = { isActive: false, sectorId: 's-off', levelId: 'l-off' };

function repo(sectorActive: boolean, levelActive: boolean) {
  return {
    findActiveSector: vi
      .fn()
      .mockResolvedValue(sectorActive ? { id: 's' } : null),
    findLevelForAssignment: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve({ id, isActive: levelActive }),
      ),
  } as never as Parameters<typeof assertReactivationAllowed>[0] & {
    findActiveSector: ReturnType<typeof vi.fn>;
    findLevelForAssignment: ReturnType<typeof vi.fn>;
  };
}

describe('assertReactivationAllowed — setor e nível ao reativar (E10)', () => {
  it('aceite 18: inativa → ativa com setor inativo mantido — user.sector_inactive', async () => {
    await expect(
      assertReactivationAllowed(repo(false, true), INACTIVE, {
        isActive: true,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'user.sector_inactive' });
  });

  it('aceite 18: com nível desativado mantido (ou reenviado igual) — user.level_inactive', async () => {
    const kept = assertReactivationAllowed(repo(true, false), INACTIVE, {
      isActive: true,
    });
    const resent = assertReactivationAllowed(repo(true, false), INACTIVE, {
      isActive: true,
      levelId: 'l-off',
    });
    await expect(kept).rejects.toMatchObject({
      status: 409,
      code: 'user.level_inactive',
    });
    await expect(resent).rejects.toMatchObject({ code: 'user.level_inactive' });
  });

  it('setor antes do nível', async () => {
    const fake = repo(false, false);
    await expect(
      assertReactivationAllowed(fake, INACTIVE, { isActive: true }),
    ).rejects.toMatchObject({ code: 'user.sector_inactive' });
    expect(fake.findLevelForAssignment).not.toHaveBeenCalled();
  });
});

describe('assertReactivationAllowed — o que passa (E10)', () => {
  it('aceite 18: trocar para setor e nível ativos e reativar — passa', async () => {
    const fake = repo(true, true);
    await expect(
      assertReactivationAllowed(fake, INACTIVE, {
        isActive: true,
        sectorId: 's-on',
        levelId: 'l-on',
      }),
    ).resolves.toBeUndefined();
    expect(fake.findActiveSector).toHaveBeenCalledWith('s-on');
    expect(fake.findLevelForAssignment).toHaveBeenCalledWith('l-on');
  });

  it('aceite 18: pessoa já ativa com nível desativado, editada — passa sem consultar', async () => {
    const fake = repo(false, false);
    const active = { ...INACTIVE, isActive: true };
    await assertReactivationAllowed(fake, active, { isActive: true });
    await assertReactivationAllowed(fake, active, { levelId: 'l-off' });
    await assertReactivationAllowed(fake, INACTIVE, { isActive: false });
    await assertReactivationAllowed(fake, INACTIVE, {});
    expect(fake.findActiveSector).not.toHaveBeenCalled();
    expect(fake.findLevelForAssignment).not.toHaveBeenCalled();
  });

  it('sem setor e sem nível — passa', async () => {
    const fake = repo(false, false);
    const bare = { isActive: false, sectorId: null, levelId: null };
    await expect(
      assertReactivationAllowed(fake, bare, { isActive: true }),
    ).resolves.toBeUndefined();
    await expect(
      assertReactivationAllowed(fake, INACTIVE, {
        isActive: true,
        sectorId: null,
        levelId: null,
      }),
    ).resolves.toBeUndefined();
    expect(fake.findActiveSector).not.toHaveBeenCalled();
  });
});
