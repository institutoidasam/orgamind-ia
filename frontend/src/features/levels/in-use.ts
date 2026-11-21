/** Contagens do nível que a tela lê (CJ4); ausentes quando o back ainda não as manda. */
type LevelUsage = { activePeople?: number | null };

/** 409 `levels.in_use` depois de a tela abrir (E5, DJ14): o uso surgiu depois da leitura. */
export const LEVEL_IN_USE_409 = 'Este nível está em uso e não pode ser desativado.';
export const LEVEL_IN_USE_CODE = 'levels.in_use';
export const LEVEL_IN_USE_TITLE = 'Em uso: não pode ser inativado';
export const LEVEL_HOW_TO_TITLE = 'Para liberar:';

/** Chave da lista de níveis (a mesma de `useLevels`, em `api.ts`). */
export const LEVELS_QUERY_KEY = ['levels'] as const;

/** Pessoas ativas bloqueiam a desativação; nível já desativado nunca trava o "Reativar". */
export function levelInUse(l: { isActive: boolean } & LevelUsage): boolean {
  return l.isActive && (l.activePeople ?? 0) > 0;
}

/** Linha de uso, só com contagem maior que zero (E4). */
export function levelUsageLines(l: LevelUsage): string[] {
  const people = l.activePeople ?? 0;
  return people > 0 ? [`${people} pessoa(s) ativa(s) com este nível`] : [];
}

/** "Para liberar:" do nível: trocar o nível no cadastro das pessoas. */
export function levelHowTo(l: LevelUsage): string[] {
  return (l.activePeople ?? 0) > 0 ? ['Troque o nível no cadastro das pessoas.'] : [];
}

/** Pergunta da confirmação de desativar o nível sem uso (E6). */
export function deactivateLevelText(name: string): string {
  return `Desativar o nível ${name}? Ele sai do cadastro novo e do filtro de envio.`;
}
