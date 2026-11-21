import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../schemas";
import { MessageBubble } from "./message-bubble";

// 02:05 UTC de 22/11 = 22:05 de 21/11 em Manaus.
const LATE_UTC = "2026-11-22T02:05:00.000Z";

const base: ChatMessage = {
  id: "m1",
  conversationId: "c1",
  direction: "OUTBOUND",
  kind: "TEXT",
  content: "Atenção, equipe",
  status: "SENT",
  providerMessageId: null,
  quotedWaMessageId: null,
  quotedPreview: null,
  createdAt: LATE_UTC,
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  receivedAt: null,
  media: null,
  transcript: null,
};

describe("MessageBubble — etiqueta de envio à equipe (K3-6)", () => {
  it("aceite 29: bolha com teamTag mostra a etiqueta; sem teamTag, nada", () => {
    const view = render(
      <MessageBubble
        message={{
          ...base,
          teamTag: { kind: "dispatch", purpose: "urgency", sentAt: LATE_UTC },
        }}
      />,
    );
    expect(screen.getByTestId("message-team-tag")).toHaveTextContent(
      "Envio à equipe: Urgência · 21/11 22:05",
    );
    expect(screen.getByText("Atenção, equipe")).toBeInTheDocument();

    view.rerender(
      <MessageBubble message={{ ...base, teamTag: { kind: "reminder" } }} />,
    );
    expect(screen.getByTestId("message-team-tag")).toHaveTextContent(
      "Lembrete do alerta",
    );

    view.rerender(<MessageBubble message={{ ...base, teamTag: null }} />);
    expect(screen.queryByTestId("message-team-tag")).toBeNull();

    view.rerender(<MessageBubble message={base} />);
    expect(screen.queryByTestId("message-team-tag")).toBeNull();
    expect(screen.getByText("Atenção, equipe")).toBeInTheDocument();
  });
});
