import type { ShiftRef } from "@/features/shifts/schemas";
import type { TeamRoster } from "@/features/team-whatsapp/schemas";
import type { PanoramaCounts, PanoramaSector, TeamPanorama } from "./schemas";

export const SHIFTS: ShiftRef[] = [
  { id: "sh-m", name: "Manhã", startTime: "06:00", endTime: "14:00" },
  { id: "sh-n", name: "Noite", startTime: "22:00", endTime: "06:00" },
];

/** Contagens de um setor com gente em serviço; `over` troca só o que o teste quer mudar. */
export function countsOf(over: Partial<PanoramaCounts> = {}): PanoramaCounts {
  return {
    byShift: [
      { shiftId: "sh-m", count: 3 },
      { shiftId: "sh-n", count: 0 },
    ],
    otherShifts: 0,
    dayOff: 1,
    vacation: 0,
    noSchedule: 5,
    noPhone: 0,
    notAuthorized: 0,
    ...over,
  };
}

export function sectorOf(over: Partial<PanoramaSector> = {}): PanoramaSector {
  return {
    sectorId: "s1",
    name: "Compras",
    overLimit: false,
    counts: countsOf(),
    ...over,
  };
}

export function panoramaOf(over: Partial<TeamPanorama> = {}): TeamPanorama {
  return {
    date: "2026-11-21",
    today: "2026-11-21",
    shifts: SHIFTS,
    inProgress: null,
    sectors: [sectorOf(), sectorOf({ sectorId: "s2", name: "Logística" })],
    ...over,
  };
}

type RosterMember = TeamRoster["sectors"][number]["members"][number];

/** Pessoa do roster; por padrão em serviço no turno da manhã e só com o telefone mascarado. */
export function memberOf(
  id: string,
  name: string,
  over: Partial<RosterMember> = {},
): RosterMember {
  return {
    id,
    name,
    email: null,
    phoneE164: null,
    hasPhone: true,
    phoneMasked: "•••• 0001",
    isActive: true,
    jobTitle: null,
    fromOtherSector: false,
    situation: {
      kind: "WORK",
      sectorId: "s1",
      shiftId: "sh-m",
      source: "CYCLE",
    },
    level: null,
    ...over,
  };
}

/** Resposta do roster de um setor. */
export function rosterOf(members: RosterMember[], sectorId = "s1"): TeamRoster {
  return {
    date: "2026-11-21",
    shiftStarts: [],
    sectors: [{ sectorId, name: "Compras", channel: null, members }],
  };
}
