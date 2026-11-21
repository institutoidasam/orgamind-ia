import { describe, expect, it } from "vitest";
import { initialSchedule, validateScheduleSearch } from "./schedule-search";

const options = { today: "2026-10-21", sectors: [{ id: "s1" }, { id: "s2" }] };

describe("validateScheduleSearch: parâmetros de /escala", () => {
  it("descarta o que não é texto (setor) nem data civil real (data)", () => {
    expect(
      validateScheduleSearch({ sectorId: "s1", date: "2026-11-18" }),
    ).toEqual({ sectorId: "s1", date: "2026-11-18" });
    expect(validateScheduleSearch({ sectorId: 7, date: 20261118 })).toEqual({});
    expect(
      validateScheduleSearch({ sectorId: "", date: "2026-02-30" }),
    ).toEqual({});
    expect(validateScheduleSearch({})).toEqual({});
  });

  it("devolve as chaves descartadas como undefined (o router mescla a busca crua da URL por baixo)", () => {
    expect(
      validateScheduleSearch({ sectorId: "", date: "2026-02-30" }),
    ).toStrictEqual({ sectorId: undefined, date: undefined });
  });
});

describe("initialSchedule: estado inicial da escala", () => {
  it("setor no alcance e data válida viram estado inicial", () => {
    expect(
      initialSchedule({ sectorId: "s2", date: "2026-11-18" }, options),
    ).toEqual({ sectorId: "s2", anchor: "2026-11-18" });
  });

  it("setor fora das opções → null; data ausente → today", () => {
    expect(initialSchedule({ sectorId: "inativo" }, options)).toEqual({
      sectorId: null,
      anchor: "2026-10-21",
    });
    expect(initialSchedule({}, options)).toEqual({
      sectorId: null,
      anchor: "2026-10-21",
    });
  });
});
