import { describe, expect, it } from 'vitest';
import { deactivateLevelText, levelHowTo, levelInUse, levelUsageLines } from './in-use';
import { levelAdminSchema } from './schemas';

describe('in-use: nível com pessoas ativas (E3, E4, DJ14)', () => {
  it('levelInUse com activePeople > 0; ausente não bloqueia', () => {
    expect(levelInUse({ isActive: true, activePeople: 2 })).toBe(true);
    expect(levelInUse({ isActive: true, activePeople: 0 })).toBe(false);
    expect(levelInUse({ isActive: true })).toBe(false);
    expect(levelInUse({ isActive: true, activePeople: null })).toBe(false);
    // Nível já desativado: "Reativar" nunca é travado pelo uso.
    expect(levelInUse({ isActive: false, activePeople: 3 })).toBe(false);
  });

  it('linhas e o que fazer', () => {
    expect(levelUsageLines({ activePeople: 3 })).toEqual(['3 pessoa(s) ativa(s) com este nível']);
    expect(levelUsageLines({ activePeople: 0 })).toEqual([]);
    expect(levelUsageLines({})).toEqual([]);
    expect(levelHowTo({ activePeople: 3 })).toEqual(['Troque o nível no cadastro das pessoas.']);
    expect(levelHowTo({ activePeople: 0 })).toEqual([]);
    expect(deactivateLevelText('Líder')).toBe('Desativar o nível Líder? Ele sai do cadastro novo e do filtro de envio.');
  });

  it('o espelho do schema aceita lista sem os campos novos (back antigo) e com eles', () => {
    const base = { id: 'lvl_1', name: 'Líder', isActive: true, sortOrder: 1, userCount: 3 };
    expect(levelAdminSchema.parse(base).activePeople).toBeUndefined();
    expect(levelAdminSchema.parse({ ...base, activePeople: 2, inactivePeople: 1 })).toMatchObject({
      activePeople: 2,
      inactivePeople: 1,
    });
  });
});
