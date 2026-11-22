import { describe, expect, it } from "vitest";
import {
  cardLines,
  inProgressText,
  inServiceTitle,
  panoramaSubtitle,
  shiftLine,
} from "./labels";
import { countsOf, SHIFTS } from "./panorama.test-fixtures";

describe("labels do panorama: textos fixos", () => {
  it("panoramaSubtitle: ADMIN todos; demais seus", () => {
    expect(panoramaSubtitle("ADMIN")).toBe("Panorama de todos os setores");
    expect(panoramaSubtitle("SUPERVISOR")).toBe("Panorama dos seus setores");
    expect(panoramaSubtitle(undefined)).toBe("Panorama dos seus setores");
  });

  it("shiftLine: Manhã (06:00–14:00): 3 com travessão", () => {
    expect(shiftLine(SHIFTS[0], 3)).toBe("Manhã (06:00–14:00): 3");
  });

  it("inServiceTitle usa dd/MM", () => {
    expect(inServiceTitle("2026-11-21")).toBe("Em serviço em 21/11");
  });

  it("inProgressText cita o turno de ontem", () => {
    expect(inProgressText("Noite")).toBe(
      "O turno Noite de ontem ainda está em andamento.",
    );
  });
});

describe("labels do panorama: linhas do cartão", () => {
  it("cardLines: Outros turnos e lacunas só com N > 0; empty quando tudo é zero", () => {
    const full = cardLines(
      countsOf({ otherShifts: 2, noPhone: 1, notAuthorized: 4 }),
      SHIFTS,
    );
    expect(full.shifts).toEqual([
      "Manhã (06:00–14:00): 3",
      "Noite (22:00–06:00): 0",
    ]);
    expect(full.other).toBe("Outros turnos: 2");
    expect(full.rest).toEqual(["Folga: 1", "Férias: 0", "Sem escala: 5"]);
    expect(full.gaps).toEqual([
      "Sem telefone: 1",
      "Sem autorização de contato: 4",
    ]);
    expect(full.empty).toBe(false);
    const none = cardLines(
      countsOf({ byShift: [], dayOff: 0, noSchedule: 0 }),
      SHIFTS,
    );
    expect(none).toMatchObject({ other: null, gaps: [], empty: true });
  });
});
