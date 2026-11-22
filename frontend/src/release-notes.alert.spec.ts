import { describe, expect, it } from "vitest";
import { RELEASE_NOTES } from "./release-notes";

describe("novidade: alerta urgente do WhatsApp da equipe (Lote I)", () => {
  const note = RELEASE_NOTES.find((n) => n.version === "2026.11.20.3");
  const texts = (note?.items ?? []).map((item) => item.text);

  it("aceite 18: entrada no topo com where /whatsapp-equipe cita a linha fixa e avisa que, até o administrador ligar Criar alerta urgente, só ele cria alerta", () => {
    expect(note).toBeDefined();
    // Acima da entrada do Lote H (a ordem decrescente geral é conferida em release-notes.spec.ts); `[0]` quebraria
    // na próxima entrada.
    const rastreio = RELEASE_NOTES.findIndex(
      (n) => n.version === "2026.11.20.2",
    );
    expect(
      RELEASE_NOTES.findIndex((n) => n.version === "2026.11.20.3"),
    ).toBeLessThan(rastreio);
    expect(note?.items.every((item) => item.where === "/whatsapp-equipe")).toBe(
      true,
    );
    expect(
      texts.some((t) => t.includes("Responda OK para confirmar que recebeu.")),
    ).toBe(true);
    expect(
      texts.some(
        (t) =>
          t.includes('Até o administrador ligar "Criar alerta urgente"') &&
          t.includes("só ele cria alerta"),
      ),
    ).toBe(true);
  });

  it("cobre o painel de pendências, o lembrete, a ciência manual e a perda da Urgência de Supervisor e Operador", () => {
    expect(texts.some((t) => t.includes("painel de pendências"))).toBe(true);
    expect(
      texts.some((t) => t.includes("lembrete") && t.includes("ciência manual")),
    ).toBe(true);
    expect(
      texts.some((t) =>
        t.includes("Supervisor e Operador deixam de ver a finalidade Urgência"),
      ),
    ).toBe(true);
  });
});
