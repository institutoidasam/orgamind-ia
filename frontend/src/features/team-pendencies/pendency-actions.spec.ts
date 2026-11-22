import { describe, expect, it } from "vitest";
import { pendencyActions, type PendencyMe } from "./pendency-actions";
import { pendencyItem, pendencyMe } from "./pendency.test-fixtures";
import type { TeamPendencyItem } from "./schemas";

const mine = { id: "u-me", name: "Eu", state: "active" } as const;
const other = { id: "u-outro", name: "Outra Pessoa", state: "active" } as const;
const admin = pendencyMe({ role: "ADMIN" });

/** Nomes das ações oferecidas, na ordem do tipo. */
function offered(
  item: Partial<TeamPendencyItem>,
  me: PendencyMe = pendencyMe(),
): string[] {
  const flags = pendencyActions(pendencyItem(item), me);
  return Object.entries(flags)
    .filter(([, on]) => on)
    .map(([name]) => name);
}

describe("matriz de ações da tratativa (DK20)", () => {
  it("Sem responsável — Assumir; ADMIN também Transferir e Encerrar sem ciência", () => {
    expect(offered({ situation: "UNASSIGNED" })).toEqual(["assume"]);
    expect(offered({ situation: "UNASSIGNED" }, admin)).toEqual([
      "assume",
      "transfer",
      "close",
    ]);
  });

  it("minha — Transferir, Registrar contato, Encerrar sem ciência", () => {
    const expected = ["transfer", "note", "close"];
    expect(offered({ situation: "IN_PROGRESS", handler: mine })).toEqual(
      expected,
    );
    expect(offered({ situation: "OVERDUE", handler: mine })).toEqual(expected);
  });

  it("de outro ativo — Assumir de outro; ADMIN também as três", () => {
    expect(offered({ situation: "IN_PROGRESS", handler: other })).toEqual([
      "takeOver",
    ]);
    expect(offered({ situation: "OVERDUE", handler: other }, admin)).toEqual([
      "takeOver",
      "transfer",
      "note",
      "close",
    ]);
  });

  it("responsável inativo ou fora do alcance — Assumir", () => {
    for (const state of ["inactive", "out_of_scope"] as const) {
      const handler = { ...other, state };
      expect(offered({ situation: "UNASSIGNED", handler })).toEqual(["assume"]);
    }
  });
});

describe("matriz de ações: encerrada, ciente e sem permissão (DK20)", () => {
  it("Encerrada — Reabrir a tratativa só para responsável ou ADMIN", () => {
    expect(offered({ situation: "CLOSED", handler: mine })).toEqual(["reopen"]);
    expect(offered({ situation: "CLOSED", handler: other }, admin)).toEqual([
      "reopen",
    ]);
    expect(offered({ situation: "CLOSED", handler: other })).toEqual([]);
    expect(offered({ situation: "CLOSED", handler: null })).toEqual([]);
  });

  it("Ciente — nenhuma de tratativa", () => {
    const ack = { kind: "KEYWORD", at: "2026-11-21T13:05:00.000Z" };
    expect(offered({ situation: "ACKED", handler: mine, ack }, admin)).toEqual(
      [],
    );
  });

  it("sem equipe.enviar — nenhuma ação", () => {
    const me = pendencyMe({ role: "ADMIN", canWrite: false, canUrgency: true });
    expect(offered({ situation: "UNASSIGNED" }, me)).toEqual([]);
    expect(offered({ situation: "IN_PROGRESS", handler: mine }, me)).toEqual(
      [],
    );
  });
});

describe("ciência manual pela tela (DK20)", () => {
  const urgent = pendencyMe({ canUrgency: true });
  const manual = { kind: "MANUAL", at: "2026-11-21T13:05:00.000Z" };
  const keyword = { kind: "KEYWORD", at: "2026-11-21T13:05:00.000Z" };

  it("ciência manual só com equipe.enviar e equipe.urgencia; Desfazer só em MANUAL", () => {
    expect(offered({ situation: "UNASSIGNED" }, urgent)).toEqual([
      "assume",
      "manualAck",
    ]);
    expect(offered({ situation: "UNASSIGNED" })).toEqual(["assume"]);
    expect(offered({ situation: "ACKED", ack: manual }, urgent)).toEqual([
      "undoManualAck",
    ]);
    expect(offered({ situation: "ACKED", ack: keyword }, urgent)).toEqual([]);
  });

  it("encerrada sem ciência ainda aceita ciência manual (a ciência vale depois do encerramento)", () => {
    expect(offered({ situation: "CLOSED", handler: mine }, urgent)).toEqual([
      "reopen",
      "manualAck",
    ]);
  });
});
