import type { ShiftRef } from "@/features/shifts/schemas";
import { formatDayMonth } from "@/lib/civil-date";
import type { PanoramaCounts } from "./schemas";

export const PANORAMA_TITLE = "Operação da fábrica";
export const PANORAMA_NOTICE =
  "As contagens vêm da escala do dia, não da hora. Quem recebe uma mensagem só é definido na prévia do envio, que também confere bloqueios.";
export const PANORAMA_LOADING = "Carregando panorama…";
export const PANORAMA_LOAD_ERROR = "Não foi possível carregar o panorama";
export const PANORAMA_RETRY = "Tentar de novo";
export const OVER_LIMIT_TEXT = "Setor com mais de 2000 pessoas: veja na Escala";
export const EMPTY_SECTOR_TEXT = "Ninguém na escala deste dia";

/** ADMIN vê todos os setores; os demais, só os que gerem. */
export function panoramaSubtitle(role: string | undefined): string {
  return role === "ADMIN"
    ? "Panorama de todos os setores"
    : "Panorama dos seus setores";
}

export function inServiceTitle(date: string): string {
  return `Em serviço em ${formatDayMonth(date)}`;
}

/** '{turno} ({início}–{fim}): N', com travessão (en dash) entre as horas. */
export function shiftLine(
  shift: Pick<ShiftRef, "name" | "startTime" | "endTime">,
  count: number,
): string {
  return `${shift.name} (${shift.startTime}–${shift.endTime}): ${count}`;
}

export function inProgressText(shiftName: string): string {
  return `O turno ${shiftName} de ontem ainda está em andamento.`;
}

export type CardLines = {
  shifts: string[];
  other: string | null;
  rest: string[];
  gaps: string[];
  empty: boolean;
};

/** Linhas do cartão de um setor; `empty` = ninguém em nenhuma situação (só o texto de vazio). */
export function cardLines(
  counts: PanoramaCounts,
  shifts: readonly ShiftRef[],
): CardLines {
  const byShift = new Map(
    counts.byShift.map((entry) => [entry.shiftId, entry.count]),
  );
  const gaps: Array<[string, number]> = [
    ["Sem telefone", counts.noPhone],
    ["Sem autorização de contato", counts.notAuthorized],
  ];
  const total =
    counts.byShift.reduce((sum, entry) => sum + entry.count, 0) +
    counts.otherShifts +
    counts.dayOff +
    counts.vacation +
    counts.noSchedule;
  return {
    shifts: shifts.map((shift) => shiftLine(shift, byShift.get(shift.id) ?? 0)),
    other:
      counts.otherShifts > 0 ? `Outros turnos: ${counts.otherShifts}` : null,
    rest: [
      `Folga: ${counts.dayOff}`,
      `Férias: ${counts.vacation}`,
      `Sem escala: ${counts.noSchedule}`,
    ],
    gaps: gaps.filter(([, n]) => n > 0).map(([label, n]) => `${label}: ${n}`),
    empty: total === 0,
  };
}
