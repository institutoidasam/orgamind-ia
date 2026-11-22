import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

const CHANNEL = {
  id: "ch1",
  name: "Canal Principal",
  phoneE164: "+5592991234567",
  provider: "EVOLUTION",
  live: { state: "open", checkedAt: "2026-11-20T14:05:00.000Z" },
};

vi.mock("../api", () => ({
  AUDIENCE_PREVIEW_KEY: ["team-whatsapp", "preview"],
  useTeamRoster: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    data: {
      date: "2026-11-20",
      shiftStarts: [],
      sectors: [
        { sectorId: "s1", name: "Compras", channel: CHANNEL, members: [] },
      ],
    },
  }),
  useTeamPersonRoute: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    data: undefined,
  }),
  useCreateTeamDispatch: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/stores/auth.store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { role: "ADMIN" } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

import { RULE_VIEW } from "../audience-preview.test-fixtures";
import { useMessageDraft } from "../message-draft";
import type { SendTarget, TeamAudiencePreview, TeamPurpose } from "../schemas";
import { NOW_MOMENT } from "../use-send-filters";
import { SendWhatsappDialog } from "./send-whatsapp-dialog";

const TARGET: Extract<SendTarget, { type: "sector" }> = {
  type: "sector",
  sectorIds: ["s1"],
  levelIds: [],
  withoutLevel: false,
  label: "Compras · todos os turnos · 20/11",
  date: "2026-11-20",
  shiftIds: [],
  includeOff: false,
  userIds: null,
  recipients: [{ id: "a", name: "Ana" }],
  leftOut: [],
};
const LINE = "Responda OK para confirmar que recebeu.";

function previewOf(purpose: TeamPurpose): TeamAudiencePreview {
  return {
    audienceKey: "k".repeat(64),
    rule: {
      ...RULE_VIEW,
      purpose,
      base: purpose === "urgency" ? "on_duty" : "assigned",
      sectors: [{ id: "s1", name: "Compras" }],
      shifts: null,
      urgencyReason: purpose === "urgency" ? "Falta de energia" : null,
    },
    included: [
      {
        sectorId: "s1",
        sectorName: "Compras",
        shiftName: null,
        levelName: null,
        userId: "a",
        name: "Ana",
        phone: null,
      },
    ],
    excluded: [],
    blocks: [],
  };
}

function Harness({ purpose }: { purpose: TeamPurpose }) {
  const draft = useMessageDraft(purpose, null);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <SendWhatsappDialog
        open
        onOpenChange={vi.fn()}
        target={TARGET}
        audience={{ preview: previewOf(purpose), isFresh: true }}
        moment={{ value: NOW_MOMENT, onChange: vi.fn(), today: "2026-11-20" }}
        draft={draft}
      />
    </QueryClientProvider>
  );
}

const box = () => screen.getByLabelText("Mensagem");
const write = (length: number) =>
  fireEvent.change(box(), { target: { value: "a".repeat(length) } });
const sendButton = () => screen.getByRole("button", { name: "Enviar agora" });

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({
    dispatchId: "d1",
    queued: 1,
    scheduled: 0,
    scheduledFor: null,
    skipped: [],
  });
});

describe("SendWhatsappDialog: alerta urgente, linha fixa e limite", () => {
  it("aceite 13: Urgência mostra a linha fixa sob a caixa, sem edição, e o contador soma 41", async () => {
    render(<Harness purpose="urgency" />);
    await userEvent.type(box(), "Oi");

    const line = screen.getByText(LINE);
    expect(box().compareDocumentPosition(line)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getAllByRole("textbox")).toEqual([box()]);
    expect(box()).toHaveAttribute("maxlength", "2000");
    expect(screen.getByText("43/2000")).toBeInTheDocument();
  });

  it("aceite 13: 1960 caracteres na Urgência — botão travado; 1959 — liberado, e o corpo vai cru", async () => {
    render(<Harness purpose="urgency" />);
    write(1960);
    expect(screen.getByText("2001/2000")).toBeInTheDocument();
    expect(
      screen.getByText("A mensagem passa de 2000 caracteres."),
    ).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();

    write(1959);
    expect(screen.getByText("2000/2000")).toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
    await userEvent.click(sendButton());
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ text: "a".repeat(1959), purpose: "urgency" }),
    );
  });
});

describe("SendWhatsappDialog: alerta urgente, revisão e outras finalidades", () => {
  it("aceite 6: a revisão da Urgência mostra os nomes e o prazo de 15 min", () => {
    render(<Harness purpose="urgency" />);
    expect(
      screen.getByRole("list", { name: "Vão receber (1)" }),
    ).toHaveTextContent("Ana");
    expect(
      screen.getByText(
        "Prazo de ciência: 15 min, contado da confirmação do envio",
      ),
    ).toBeInTheDocument();
  });

  it("reunião: sem linha fixa nem prazo, contador como hoje e limite de 2000 do texto cru", async () => {
    render(<Harness purpose="meeting" />);
    await userEvent.type(box(), "Oi");

    expect(screen.queryByText(LINE)).not.toBeInTheDocument();
    expect(screen.queryByText(/Prazo de ciência/)).not.toBeInTheDocument();
    expect(screen.getByText("2/2000")).toBeInTheDocument();
    write(2000);
    expect(sendButton()).toBeEnabled();
  });
});
