import { describe, expect, it } from "vitest";
import { parseCivilDateParam } from "./civil-date-param";

describe("parseCivilDateParam: data civil de parâmetro de URL", () => {
  it("2026-11-21 sim; 2026-02-30, 21/11/2026, número e vazio não", () => {
    expect(parseCivilDateParam("2026-11-21")).toBe("2026-11-21");
    expect(parseCivilDateParam("2028-02-29")).toBe("2028-02-29");
    expect(parseCivilDateParam("2026-02-30")).toBeUndefined();
    expect(parseCivilDateParam("21/11/2026")).toBeUndefined();
    expect(parseCivilDateParam(20261121)).toBeUndefined();
    expect(parseCivilDateParam("")).toBeUndefined();
    expect(parseCivilDateParam(undefined)).toBeUndefined();
  });
});
