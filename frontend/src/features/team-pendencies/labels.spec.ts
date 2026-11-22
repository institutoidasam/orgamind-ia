import { describe, expect, it } from "vitest";
import {
  closureLine,
  handlerLabel,
  manausTime,
  noteLine,
  replyLabel,
  SITUATION_LABEL,
} from "./labels";
import { pendencyItem } from "./pendency.test-fixtures";

const AT = "2026-11-21T13:05:00.000Z"; // 09:05 em Manaus (UTC-4)
const handler = (
  state: "active" | "inactive" | "out_of_scope",
  name: string | null = "Ana",
) => ({
  id: "u1",
  name,
  state,
});

describe("rótulos de situação (DK19)", () => {
  it.each([
    ["UNASSIGNED", "Sem responsável"],
    ["IN_PROGRESS", "Em tratativa"],
    ["OVERDUE", "Em tratativa — atrasada"],
    ["ACKED", "Ciente"],
    ["CLOSED", "Encerrada sem ciência"],
  ] as const)("%s — %s", (situation, text) => {
    expect(SITUATION_LABEL[situation]).toBe(text);
  });
});

describe("rótulos da linha (DK19)", () => {
  it("handlerLabel — (inativo), (fora do alcance), ninguém, Usuário removido", () => {
    expect(handlerLabel(handler("active"))).toBe("Responsável: Ana");
    expect(handlerLabel(handler("inactive"))).toBe(
      "Responsável: Ana (inativo)",
    );
    expect(handlerLabel(handler("out_of_scope"))).toBe(
      "Responsável: Ana (fora do alcance)",
    );
    expect(handlerLabel(null)).toBe("Responsável: ninguém");
    expect(handlerLabel(handler("active", null))).toBe(
      "Responsável: Usuário removido",
    );
  });

  it("replyLabel — texto, Áudio, Imagem, Arquivo, (Mensagem sem texto)", () => {
    const reply = (text: string | null, media: string | null) => ({
      text,
      media,
      at: AT,
    });
    expect(replyLabel(reply("Estou a caminho", null))).toBe("Estou a caminho");
    expect(replyLabel(reply(null, "audio"))).toBe("Áudio");
    expect(replyLabel(reply(null, "image"))).toBe("Imagem");
    expect(replyLabel(reply(null, "file"))).toBe("Arquivo");
    expect(replyLabel(reply("  ", null))).toBe("(Mensagem sem texto)");
    expect(replyLabel(reply(null, "video"))).toBe("(Mensagem sem texto)");
  });

  it("manausTime — dd/MM HH:mm em America/Manaus", () => {
    expect(manausTime(AT)).toBe("21/11 09:05");
    expect(manausTime("2026-11-22T02:30:00.000Z")).toBe("21/11 22:30");
  });
});

describe("anotações e encerramento (DK19)", () => {
  it("noteLine — prefixos Contato:, Ao assumir:, Encerramento:, Passagem de turno:", () => {
    const note = (kind: string, authorName: string | null = "Ana") => ({
      ...pendencyItem({
        notes: [{ id: "n", kind, authorName, at: AT, text: "texto" }],
      }).notes[0],
    });
    expect(noteLine(note("CONTACT"))).toBe(
      "21/11 09:05 · Ana · Contato: texto",
    );
    expect(noteLine(note("ASSUME"))).toBe(
      "21/11 09:05 · Ana · Ao assumir: texto",
    );
    expect(noteLine(note("CLOSE"))).toBe(
      "21/11 09:05 · Ana · Encerramento: texto",
    );
    expect(noteLine(note("HANDOVER"))).toBe(
      "21/11 09:05 · Ana · Passagem de turno: texto",
    );
    expect(noteLine(note("OUTRO", null))).toBe(
      "21/11 09:05 · Usuário removido · texto",
    );
  });

  it("closureLine — Tratativa encerrada por {nome}: {motivo}", () => {
    const closure = {
      byId: "u2",
      byName: "Gestor S1",
      at: AT,
      reason: "Sem retorno",
    };
    expect(closureLine(closure)).toBe(
      "Tratativa encerrada por Gestor S1: Sem retorno",
    );
    expect(closureLine({ ...closure, byId: null, byName: null })).toBe(
      "Tratativa encerrada por Usuário removido: Sem retorno",
    );
  });
});
