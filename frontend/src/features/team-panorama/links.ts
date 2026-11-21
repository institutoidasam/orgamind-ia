/** Parâmetros de `/escala` (T9): o setor e a data do cartão. */
export function scheduleSearch(
  sectorId: string,
  date: string,
): { sectorId: string; date: string } {
  return { sectorId, date };
}

/**
 * Parâmetros de `/whatsapp-equipe` (T10). Com `sectorId`, só aquele setor vai marcado; `null` = "vários
 * setores": a chave `sectorIds` nem existe, para a tela abrir sem nenhum setor pré-marcado.
 */
export function sendSearch(
  sectorId: string | null,
  date: string,
): { sectorIds?: string; date: string } {
  return sectorId === null ? { date } : { sectorIds: sectorId, date };
}
