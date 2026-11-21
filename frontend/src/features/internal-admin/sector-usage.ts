import type { SectorUsage } from "./schemas";

/** 409 `sector.in_use` depois de a tela abrir (E5, DJ14): o uso surgiu depois da leitura. */
export const SECTOR_IN_USE_409 =
  "Este setor está em uso e não pode ser inativado.";
export const SECTOR_IN_USE_TITLE = "Em uso: não pode ser inativado";
export const SECTOR_HOW_TO_TITLE = "Para liberar:";

const AREA_NUMBER_TEXT =
  "O número da área continua ligado a este setor e nenhum envio sai por ele enquanto o setor estiver inativo. Para usar o número em outra área, desvincule-o antes.";

/** Linhas de uso, só com contagem maior que zero (E4). */
export function sectorUsageLines(u: SectorUsage): string[] {
  const lines: string[] = [];
  if (u.people > 0) lines.push(`${u.people} pessoa(s) ativa(s) neste setor`);
  if (u.exceptions > 0)
    lines.push(`${u.exceptions} exceção(ões) de escala de hoje em diante`);
  if (u.scheduled > 0) lines.push(`${u.scheduled} envio(s) agendado(s)`);
  return lines;
}

/** Pessoas ativas, exceções de hoje em diante ou envio agendado bloqueiam a inativação. */
export function sectorInUse(u: SectorUsage | null | undefined): boolean {
  return u ? u.people + u.exceptions + u.scheduled > 0 : false;
}

/** "Para liberar:" tem um passo por tipo de dependência com contagem maior que zero. */
export function sectorHowTo(u: SectorUsage): string[] {
  const steps: string[] = [];
  if (u.people > 0)
    steps.push(
      "Traga as pessoas para outro setor pela tela de pessoas do setor de destino.",
    );
  if (u.exceptions > 0) steps.push("Remova as exceções na Escala.");
  if (u.scheduled > 0) steps.push("Cancele ou aguarde os envios agendados.");
  return steps;
}

/** Informação que não bloqueia: só com pelo menos uma pessoa inativa. */
export function inactivePeopleLine(n: number): string | null {
  return n > 0 ? `${n} pessoa(s) inativa(s) mantêm o vínculo` : null;
}

/** Parágrafos da confirmação de inativar (E6); o do número da área só com número próprio. */
export function inactivateSectorText(
  name: string,
  hasAreaNumber: boolean,
): string[] {
  const main = `Inativar ${name}? Ele sai das listas de envio, escala e cadastro. O histórico é mantido.`;
  return hasAreaNumber ? [main, AREA_NUMBER_TEXT] : [main];
}
