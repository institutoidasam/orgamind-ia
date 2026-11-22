import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationLastDispatch } from "../team-dispatch";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params: Record<string, string>;
  }) => (
    <a data-to={to} href={to.replace("$dispatchId", params.dispatchId)}>
      {children}
    </a>
  ),
}));

let lastDispatch: { data: ConversationLastDispatch | undefined };
const useLastDispatch = vi.fn((conversationId: string) => {
  void conversationId;
  return lastDispatch;
});
vi.mock("../team-dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../team-dispatch")>()),
  useConversationLastDispatch: (id: string) => useLastDispatch(id),
}));

import { LastDispatchBanner } from "./last-dispatch-banner";

// 02:05 UTC de 22/11 = 22:05 de 21/11 em Manaus.
const SENT_AT = "2026-11-22T02:05:00.000Z";
const full = {
  purpose: "urgency",
  sentAt: SENT_AT,
  isReminder: false,
  dispatchId: "d1",
  pendency: { situation: "OVERDUE" },
} as const;

describe("LastDispatchBanner — último envio à equipe no topo da conversa (K3-6)", () => {
  beforeEach(() => useLastDispatch.mockClear());

  it("aceite 29: faixa com situação e Ver resultado quando vêm; sem dispatchId, sem link; sem pendency, sem situação", () => {
    lastDispatch = { data: { last: full } };
    const view = render(<LastDispatchBanner conversationId="c1" />);
    expect(useLastDispatch).toHaveBeenCalledWith("c1");
    expect(screen.getByTestId("last-dispatch-banner")).toHaveTextContent(
      "Último envio à equipe nesta conversa: Urgência · 21/11 22:05 · Pendência: Em tratativa — atrasada",
    );
    expect(screen.getByRole("link", { name: "Ver resultado" })).toHaveAttribute(
      "href",
      "/whatsapp-equipe/d1",
    );

    // Quem olha não vê o envio: sem link, mas a situação (que o servidor mandou) continua.
    lastDispatch = { data: { last: { ...full, dispatchId: null } } };
    view.rerender(<LastDispatchBanner conversationId="c1" />);
    expect(screen.queryByRole("link", { name: "Ver resultado" })).toBeNull();
    expect(screen.getByTestId("last-dispatch-banner")).toHaveTextContent(
      "Pendência: Em tratativa — atrasada",
    );

    // Pendência fora do alcance (o servidor não manda `pendency`): sem situação, com link.
    lastDispatch = { data: { last: { ...full, pendency: null } } };
    view.rerender(<LastDispatchBanner conversationId="c1" />);
    expect(screen.getByTestId("last-dispatch-banner")).not.toHaveTextContent(
      "Pendência",
    );
    expect(
      screen.getByRole("link", { name: "Ver resultado" }),
    ).toBeInTheDocument();
  });

  it("sem envio (last null) ou carregando — sem faixa", () => {
    lastDispatch = { data: { last: null } };
    const view = render(<LastDispatchBanner conversationId="c1" />);
    expect(screen.queryByTestId("last-dispatch-banner")).toBeNull();

    lastDispatch = { data: undefined };
    view.rerender(<LastDispatchBanner conversationId="c1" />);
    expect(screen.queryByTestId("last-dispatch-banner")).toBeNull();
  });
});
