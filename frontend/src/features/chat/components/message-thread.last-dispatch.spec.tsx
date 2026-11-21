import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../schemas";

const message: ChatMessage = {
  id: "m1",
  conversationId: "c1",
  direction: "INBOUND",
  kind: "TEXT",
  content: "Bom dia",
  status: "RECEIVED",
  providerMessageId: null,
  quotedWaMessageId: null,
  quotedPreview: null,
  createdAt: "2026-11-21T12:00:00.000Z",
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  receivedAt: "2026-11-21T12:00:00.000Z",
  media: null,
};

vi.mock("../api", () => ({
  useConversation: () => ({
    data: {
      id: "c1",
      displayName: "Cliente",
      unreadCount: 0,
      phoneE164: "+5592991110001",
    },
  }),
  useConversationMessages: () => ({
    data: { pages: [{ items: [message], nextCursor: null }], pageParams: [] },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    hasNextPage: false,
  }),
  useMarkRead: () => ({ mutate: vi.fn() }),
  useResumeBot: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("./message-composer", () => ({ MessageComposer: () => null }));
vi.mock("./bot-control", () => ({ BotControl: () => null }));
vi.mock("./conversation-history", () => ({ ConversationHistory: () => null }));
vi.mock("./conversation-actions", () => ({ ConversationActions: () => null }));
vi.mock("./last-dispatch-banner", () => ({
  LastDispatchBanner: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="last-dispatch-banner" data-conv={conversationId} />
  ),
}));

import { MessageThread } from "./message-thread";

describe("MessageThread — faixa do último envio à equipe (K3-6)", () => {
  it("aceite 29: monta a faixa da conversa aberta entre o topo e as mensagens", () => {
    render(<MessageThread conversationId="c1" />);
    const banner = screen.getByTestId("last-dispatch-banner");
    expect(banner).toHaveAttribute("data-conv", "c1");
    expect(screen.getByText("Cliente").compareDocumentPosition(banner)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(banner.compareDocumentPosition(screen.getByText("Bom dia"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
