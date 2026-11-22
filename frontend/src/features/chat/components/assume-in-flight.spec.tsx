import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const post = vi.fn();
const get = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    post: (...a: unknown[]) => post(...a),
    get: (...a: unknown[]) => get(...a),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useAuthStore } from "@/stores/auth.store";
import type { ConversationSummary } from "../schemas";
import { AssigneeLockBanner } from "./assignee-lock-banner";
import { ConversationActions } from "./conversation-actions";
import { useAssigneeLock } from "./use-assignee-lock";

const conv: ConversationSummary = {
  id: "c1",
  instanceId: "i1",
  instanceName: "A",
  remoteJid: "x@s.whatsapp.net",
  phoneE164: "+5592991110001",
  contactId: null,
  displayName: "Cliente",
  waName: null,
  profilePicUrl: null,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastMessageDirection: null,
  unreadCount: 0,
  assignedUserId: "u1",
  assignedUserName: "Atendente A",
  assignedUserActive: true,
  status: "IN_PROGRESS",
  lastInboundAt: "2026-11-21T14:00:00.000Z",
};

/** Cabeçalho e aviso do compositor da mesma conversa, como na tela. */
function Screen() {
  const lock = useAssigneeLock(conv.id);
  return (
    <>
      <div data-testid="cabecalho">
        <ConversationActions conv={conv} />
      </div>
      {lock.locked ? (
        <AssigneeLockBanner
          name={lock.name}
          onAssume={lock.assume}
          pending={lock.pending}
        />
      ) : null}
    </>
  );
}

async function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <Screen />
    </QueryClientProvider>,
  );
  const banner = await screen.findByTestId("assignee-lock-banner");
  return {
    header: () =>
      within(screen.getByTestId("cabecalho")).getByRole("button", {
        name: "Assumir conversa",
      }),
    banner: () =>
      within(banner).getByRole("button", { name: "Assumir conversa" }),
  };
}

beforeEach(() => {
  // Atribuição que não volta: fica em voo durante o teste.
  post.mockReset().mockReturnValue(new Promise(() => {}));
  get.mockReset().mockReturnValue({ json: () => Promise.resolve(conv) });
  useAuthStore.setState({
    user: { id: "me", email: "a@x.com", name: "Eu", role: "OPERATOR" },
  });
});

describe("Assumir conversa em voo trava os dois botões da mesma conversa", () => {
  it("Assumir do cabeçalho pendente: o do aviso do compositor fica desligado", async () => {
    const { header, banner } = await renderScreen();
    fireEvent.click(header());
    await waitFor(() => expect(banner()).toBeDisabled());
    fireEvent.click(banner());
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("Assumir do aviso pendente: o do cabeçalho fica desligado", async () => {
    const { header, banner } = await renderScreen();
    fireEvent.click(banner());
    await waitFor(() => expect(header()).toBeDisabled());
    fireEvent.click(header());
    expect(post).toHaveBeenCalledTimes(1);
  });
});
