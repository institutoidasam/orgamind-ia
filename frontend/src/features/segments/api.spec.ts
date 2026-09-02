import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";

// Mirrors invalidateSegmentTree: a mutation on a single segment should
// invalidate the list AND that segment's detail/preview queries, but not
// another segment's queries.
describe("segments cache invalidation", () => {
  function invalidate(qc: QueryClient, id?: string) {
    qc.invalidateQueries({
      predicate: (q) => {
        if (q.queryKey[0] !== "segments") return false;
        if (id == null) return true;
        return q.queryKey[1] == null || q.queryKey[1] === id;
      },
    });
  }

  it("invalidates the list and the target segment, leaving others untouched", () => {
    const qc = new QueryClient();
    qc.setQueryData(["segments"], []);
    qc.setQueryData(["segments", "s1"], { id: "s1" });
    qc.setQueryData(["segments", "s1", "preview"], { count: 0, sample: [] });
    qc.setQueryData(["segments", "s2"], { id: "s2" });

    invalidate(qc, "s1");

    const cache = qc.getQueryCache();
    const invalidated = (key: unknown[]) =>
      cache.find({ queryKey: key })?.state.isInvalidated;

    expect(invalidated(["segments"])).toBe(true);
    expect(invalidated(["segments", "s1"])).toBe(true);
    expect(invalidated(["segments", "s1", "preview"])).toBe(true);
    expect(invalidated(["segments", "s2"])).toBe(false);
  });

  it("invalidates everything under segments when no id given", () => {
    const qc = new QueryClient();
    qc.setQueryData(["segments"], []);
    qc.setQueryData(["segments", "s2"], { id: "s2" });

    invalidate(qc);

    const cache = qc.getQueryCache();
    expect(cache.find({ queryKey: ["segments"] })?.state.isInvalidated).toBe(
      true,
    );
    expect(
      cache.find({ queryKey: ["segments", "s2"] })?.state.isInvalidated,
    ).toBe(true);
  });
});
