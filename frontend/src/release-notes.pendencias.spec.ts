import { describe, expect, it } from "vitest";
import { RELEASE_NOTES } from "./release-notes";

describe("novidade: pendências da equipe (Lote K2)", () => {
  const note = RELEASE_NOTES.find((n) => n.version === "2026.11.21.3");
  const items = note?.items ?? [];

  it("aceite 24: entrada K2 no topo, versão 2026.11.21.3, data 2026-11-21, título Pendências da equipe, item com where /pendencias-equipe", () => {
    expect(note).toBeDefined();
    // Acima da entrada do Lote K1 (a ordem decrescente geral é conferida em
    // release-notes.spec.ts); `[0]` quebraria na próxima entrada.
    expect(
      RELEASE_NOTES.findIndex((n) => n.version === "2026.11.21.3"),
    ).toBeLessThan(
      RELEASE_NOTES.findIndex((n) => n.version === "2026.11.21.2"),
    );
    expect(note?.date).toBe("2026-11-21");
    expect(note?.title).toBe("Pendências da equipe");
    expect(items.some((item) => item.where === "/pendencias-equipe")).toBe(
      true,
    );
  });
});
