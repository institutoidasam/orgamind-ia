import { describe, expect, it } from "vitest";
import { RELEASE_NOTES } from "./release-notes";

const note = RELEASE_NOTES.find((n) => n.version === "2026.11.21.4");
const items = note?.items ?? [];
const texts = items.map((item) => item.text);

describe("novidade: passagem de turno (Lote K3) — entrada", () => {
  it("aceite 31: entrada K3, versão 2026.11.21.4, data 2026-11-21, título Passagem de turno, itens com /inbox e /pendencias-equipe", () => {
    expect(note).toBeDefined();
    // A entrada K3 vem antes da entrada K2 (2026.11.21.3); outras entradas mais novas podem ficar acima dela.
    expect(
      RELEASE_NOTES.findIndex((n) => n.version === "2026.11.21.4"),
    ).toBeLessThan(
      RELEASE_NOTES.findIndex((n) => n.version === "2026.11.21.3"),
    );
    expect(note?.date).toBe("2026-11-21");
    expect(note?.title).toBe("Passagem de turno");
    expect(items).toHaveLength(3);
    expect(items.some((item) => item.where === "/inbox")).toBe(true);
    expect(items.some((item) => item.where === "/pendencias-equipe")).toBe(
      true,
    );
  });

  it("não cita nomes nem telefones", () => {
    expect(texts.every((t) => !/\d{8,}/.test(t))).toBe(true);
  });
});

describe("novidade: passagem de turno (Lote K3) — conteúdo", () => {
  it("cobre passar o turno com observação e o filtro de recebidas na passagem", () => {
    expect(
      texts.some(
        (t) =>
          t.includes("Passar meu turno") &&
          t.includes("observação") &&
          t.includes('"Recebidas na passagem de turno"'),
      ),
    ).toBe(true);
  });

  it("cobre passar as pendências da equipe", () => {
    expect(texts.some((t) => t.includes("Passar minhas pendências"))).toBe(
      true,
    );
  });

  it("cobre as etiquetas de envio à equipe e o último envio no topo da conversa", () => {
    expect(
      texts.some(
        (t) =>
          t.includes("etiqueta") &&
          t.includes("último envio") &&
          t.includes("topo"),
      ),
    ).toBe(true);
  });
});
