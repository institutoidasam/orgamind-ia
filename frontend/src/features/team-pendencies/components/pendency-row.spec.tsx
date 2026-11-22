import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => import("./pendency.test-router"));

import type { TeamPendencyItem } from "../schemas";
import { pendencyItem, pendencyMe } from "../pendency.test-fixtures";
import { PendencyRow } from "./pendency-row";

const base = pendencyItem();
const me = pendencyMe();
const handler = { id: "u2", name: "Gestor S1", state: "active" } as const;
const contactNote = {
  id: "n1",
  kind: "CONTACT",
  authorName: "Gestor S1",
  at: "2026-11-21T13:45:00.000Z",
  text: "Liguei para o ramal",
};
const closure = {
  byId: "u2",
  byName: "Gestor S1",
  at: "2026-11-21T14:00:00.000Z",
  reason: "Sem sinal na fábrica",
};
const reply = { text: null, media: "audio", at: "2026-11-21T13:10:00.000Z" };

function show(overrides: Partial<TeamPendencyItem>, who = me) {
  return render(<PendencyRow me={who} item={pendencyItem(overrides)} />);
}

const seeText = (value: string | RegExp) =>
  expect(screen.getByText(value)).toBeInTheDocument();

describe("PendencyRow: campos da linha", () => {
  it("aceite 14: pessoa, setor e turno do envio; telefone; alerta com autor e hora; prazo de ciência; grupo; responsável; situação; anotações", () => {
    show({
      situation: "OVERDUE",
      handler,
      dueAt: "2026-11-21T14:00:00.000Z",
      notes: [contactNote],
    });
    seeText("Pessoa A · Setor 1 · Manhã");
    seeText("+5592991110001");
    seeText("Alerta de Gestor S1 em 21/11 09:00: Parada de linha");
    seeText("Prazo de ciência: 21/11 09:30");
    seeText("Sem resposta");
    seeText("Responsável: Gestor S1");
    seeText("Em tratativa — atrasada");
    seeText("Prazo da tratativa: 21/11 10:00");
    seeText("21/11 09:45 · Gestor S1 · Contato: Liguei para o ramal");
  });
});

describe("PendencyRow: campos ausentes e encerramento", () => {
  it("setor e turno viram —, autor removido, sem responsável e sem prazo da tratativa", () => {
    show({
      person: { ...base.person, sectorName: null, shiftName: null },
      alert: { ...base.alert, authorName: null },
    });
    seeText("Pessoa A · — · —");
    seeText(/^Alerta de Usuário removido em /);
    seeText("Responsável: ninguém");
    seeText("Sem responsável");
    expect(screen.queryByText(/Prazo da tratativa/)).toBeNull();
  });

  it("closure — Tratativa encerrada por {nome}: {motivo}", () => {
    show({ situation: "CLOSED", closure });
    seeText("Tratativa encerrada por Gestor S1: Sem sinal na fábrica");
    seeText("Encerrada sem ciência");
  });
});

describe("PendencyRow: última resposta", () => {
  it("aceite 14: Respondeu, sem ciência — Última resposta: Áudio; outros grupos sem a linha", () => {
    const { unmount } = show({ group: "replied", lastReply: reply });
    seeText("Última resposta: Áudio");
    seeText("Respondeu, sem ciência");
    unmount();
    show({ group: "no_reply", lastReply: reply });
    expect(screen.queryByText(/Última resposta/)).toBeNull();
  });

  it("aceite 14: Última resposta com o texto", () => {
    show({
      group: "replied",
      lastReply: { ...reply, text: "Já estou indo", media: null },
    });
    seeText("Última resposta: Já estou indo");
  });
});

describe("PendencyRow: telefone", () => {
  const withPhone = (person: Partial<typeof base.person>) => ({
    person: { ...base.person, ...person },
  });

  it("aceite 14: telefone completo quando vem phoneE164; senão mascarado; sem telefone", () => {
    const { unmount } = show(withPhone({}));
    seeText("+5592991110001");
    unmount();
    const masked = show(withPhone({ phoneE164: null }));
    seeText("+55 92 ****-0001");
    expect(screen.queryByText("+5592991110001")).toBeNull();
    masked.unmount();
    show(withPhone({ phoneE164: null, hasPhone: false, phoneMasked: null }));
    seeText("Sem telefone");
  });
});

describe("PendencyRow: links e encaixe das ações", () => {
  it.each([
    ["ADMIN", "c1", true],
    ["OPERATOR", "c1", true],
    ["SUPERVISOR", "c1", false],
    ["ADMIN", null, false],
  ])(
    "aceite 22: Abrir conversa — papel %s, conversationId %s → %s",
    (role, conversationId, shown) => {
      show({ conversationId }, pendencyMe({ role }));
      const link = screen.queryByRole("link", { name: "Abrir conversa" });
      if (shown) expect(link).toHaveAttribute("href", "/inbox/c1");
      else expect(link).toBeNull();
    },
  );

  it("aceite 22: Ver resultado do alerta só com canViewDispatch", () => {
    const { unmount } = show({ canViewDispatch: true });
    expect(
      screen.getByRole("link", { name: "Ver resultado do alerta" }),
    ).toHaveAttribute("href", "/whatsapp-equipe/d1");
    unmount();
    show({ canViewDispatch: false });
    expect(
      screen.queryByRole("link", { name: "Ver resultado do alerta" }),
    ).toBeNull();
  });

  it("encaixe das ações: renderActions recebe o item e entra na linha", () => {
    render(
      <PendencyRow
        me={me}
        item={pendencyItem({ id: "r9" })}
        renderActions={(item) => (
          <button type="button">{`Ação de ${item.id}`}</button>
        )}
      />,
    );
    const row = screen.getByRole("article");
    expect(
      within(row).getByRole("button", { name: "Ação de r9" }),
    ).toBeInTheDocument();
  });
});
