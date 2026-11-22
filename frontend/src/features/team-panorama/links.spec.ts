import { describe, expect, it } from "vitest";
import { scheduleSearch, sendSearch } from "./links";

describe("links do panorama", () => {
  it("aceite 6: scheduleSearch e sendSearch com o setor e a data; vários setores sem sectorIds", () => {
    expect(scheduleSearch("s1", "2026-11-21")).toEqual({
      sectorId: "s1",
      date: "2026-11-21",
    });
    expect(sendSearch("s1", "2026-11-21")).toEqual({
      sectorIds: "s1",
      date: "2026-11-21",
    });
    const several = sendSearch(null, "2026-11-21");
    expect(several).toEqual({ date: "2026-11-21" });
    expect("sectorIds" in several).toBe(false);
  });
});
