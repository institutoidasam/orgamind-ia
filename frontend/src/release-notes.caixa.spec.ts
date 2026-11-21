import { describe, expect, it } from "vitest";
import { RELEASE_NOTES } from "./release-notes";

describe("novidade: caixa com situação da conversa e um atendente por vez (Lote K1)", () => {
  const note = RELEASE_NOTES.find((n) => n.version === "2026.11.21.2");
  const texts = (note?.items ?? []).map((item) => item.text);
  const mentions = (...words: string[]) =>
    texts.some((t) => words.every((word) => t.includes(word)));

  it("aceite 11: entrada K1 no topo, versão maior que 2026.11.21.1, data não futura, itens em /inbox com Assumir conversa, Resolvidas e Histórico da conversa", () => {
    expect(note).toBeDefined();
    // Acima da entrada do Lote I (a ordem decrescente geral é conferida em
    // release-notes.spec.ts); `[0]` quebraria na próxima entrada.
    expect(
      RELEASE_NOTES.findIndex((n) => n.version === "2026.11.21.2"),
    ).toBeLessThan(
      RELEASE_NOTES.findIndex((n) => n.version === "2026.11.21.1"),
    );
    expect(note?.version > "2026.11.21.1").toBe(true);
    expect(note?.date).toBe("2026-11-21");
    expect(note?.items.every((item) => item.where === "/inbox")).toBe(true);
    expect(mentions("Assumir conversa")).toBe(true);
    expect(mentions("Resolvidas")).toBe(true);
    expect(mentions("Histórico da conversa")).toBe(true);
  });

  it("avisa que conversas já atribuídas passam a exigir Assumir conversa de quem não é o atendente", () => {
    expect(
      mentions("já atribuídas", "Assumir conversa", "quem não é o atendente"),
    ).toBe(true);
  });
});
