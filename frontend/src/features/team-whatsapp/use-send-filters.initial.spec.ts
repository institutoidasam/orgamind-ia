import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { referenceDate, useSendFilters } from "./use-send-filters";

const TODAY = "2026-10-21";
const sectors = [
  { id: "s1", name: "Produção", code: "PROD" },
  { id: "s2", name: "Expedição", code: "EXP" },
  { id: "s3", name: "Logística", code: "LOG" },
];

describe("useSendFilters: estado inicial vindo da URL", () => {
  it("aceite 6: initial com um setor e uma data — sectorIds e date iniciais", () => {
    const { result } = renderHook(() =>
      useSendFilters(TODAY, sectors, { sectorIds: ["s2"], date: "2026-11-18" }),
    );
    expect(result.current.sectorIds).toEqual(["s2"]);
    expect(result.current.date).toBe("2026-11-18");
    expect(result.current.shiftsPicked).toBe(false);
  });

  it("sem initial — igual a hoje", () => {
    const { result } = renderHook(() => useSendFilters(TODAY, sectors));
    expect(result.current.sectorIds).toEqual([]);
    expect(result.current.date).toBe(TODAY);
    const single = renderHook(() =>
      useSendFilters(TODAY, sectors.slice(0, 1), {
        sectorIds: null,
        date: null,
      }),
    );
    expect(single.result.current.sectorIds).toEqual(["s1"]);
    expect(single.result.current.date).toBe(TODAY);
  });

  it("Reunião com initial.date — referenceDate continua a da atividade", () => {
    const { result } = renderHook(() =>
      useSendFilters(TODAY, sectors, { sectorIds: null, date: "2026-11-18" }),
    );
    act(() => result.current.pickPurpose("meeting"));
    const { purpose, date, activity } = result.current;
    expect(date).toBe("2026-11-18");
    expect(referenceDate({ purpose, date, activity })).toBe("");
    act(() => result.current.pickActivity({ date: "2026-11-20" }));
    expect(referenceDate(result.current)).toBe("2026-11-20");
    expect(result.current.date).toBe("2026-11-18");
  });
});
