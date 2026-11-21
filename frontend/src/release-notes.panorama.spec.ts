import { describe, expect, it } from "vitest";
import { RELEASE_NOTES } from "./release-notes";

describe("novidade: panorama da fábrica e cuidados ao inativar setor e nível (Lote J)", () => {
  const note = RELEASE_NOTES.find((n) => n.version === "2026.11.21.1");
  const texts = (note?.items ?? []).map((item) => item.text);
  const mentions = (...words: string[]) =>
    texts.some((t) => words.every((word) => t.includes(word)));

  it("aceite 10: entrada 2026.11.21.1 no topo, com itens em /dashboard, /setores, /niveis, /trilha e /users e as palavras Operação da fábrica, confirmação e reativar", () => {
    expect(note).toBeDefined();
    // Acima da entrada do Lote I (a ordem decrescente geral é conferida em
    // release-notes.spec.ts); `[0]` quebraria na próxima entrada.
    expect(
      RELEASE_NOTES.findIndex((n) => n.version === "2026.11.21.1"),
    ).toBeLessThan(
      RELEASE_NOTES.findIndex((n) => n.version === "2026.11.20.3"),
    );
    expect(note?.date).toBe("2026-11-21");
    const places = new Set((note?.items ?? []).map((item) => item.where));
    for (const where of [
      "/dashboard",
      "/setores",
      "/niveis",
      "/trilha",
      "/users",
    ]) {
      expect(places.has(where)).toBe(true);
    }
    expect(mentions("Operação da fábrica")).toBe(true);
    expect(mentions("confirmação")).toBe(true);
    expect(mentions("reativar")).toBe(true);
  });

  it("cobre Ver pessoas, os atalhos, o que prende o setor, o antes e depois da trilha e a recusa de reativar, sem número de telefone", () => {
    expect(mentions("Ver pessoas")).toBe(true);
    expect(mentions("Ver escala", "Enviar mensagem")).toBe(true);
    expect(mentions("não é mais inativado")).toBe(true);
    expect(mentions("antes e depois", "ordem")).toBe(true);
    expect(mentions("setor ou nível inativo", "recusado")).toBe(true);
    expect(texts.some((t) => /\d{8,}/.test(t))).toBe(false);
  });
});
