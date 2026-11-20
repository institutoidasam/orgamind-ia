import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

const CHANNEL = {
  id: "ch1",
  name: "GoZap Principal",
  phoneE164: "+5592991234567",
  provider: "GOZAP",
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
      date: "2026-11-25",
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
    sel({ user: { role: "OPERATOR" } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

import { RULE_VIEW } from "../audience-preview.test-fixtures";
import { DRAFT_STALE_TEXT, useMessageDraft } from "../message-draft";
import type { SendTarget, TeamPurpose } from "../schemas";
import { NOW_MOMENT, type ActivityDraft } from "../use-send-filters";
import { SendWhatsappDialog } from "./send-whatsapp-dialog";

const TARGET: Extract<SendTarget, { type: "sector" }> = {
  type: "sector",
  sectorIds: ["s1"],
  levelIds: [],
  withoutLevel: false,
  label: "Compras · todos os turnos · 25/11",
  date: "2026-11-25",
  shiftIds: [],
  includeOff: true,
  userIds: null,
  recipients: [{ id: "a", name: "Ana" }],
  leftOut: [],
};
const ACTIVITY: ActivityDraft = {
  date: "2026-11-25",
  time: "09:30",
  place: "Sala 2",
};
const HEADER = "Reunião em 25/11/2026 às 09:30 — Sala 2.\n\n";
const NEW_HEADER = "Reunião em 25/11/2026 às 10:00 — Sala 2.\n\n";

const PREVIEW = (purpose: TeamPurpose) => ({
  audienceKey: "k".repeat(64),
  rule: { ...RULE_VIEW, purpose, base: "assigned" as const },
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
});

/** A página: a atividade e o rascunho moram fora do diálogo (DG12), e o diálogo modal só deixa mexer nela fechado. */
function Page({
  purpose = "meeting",
  activity = ACTIVITY,
}: {
  purpose?: TeamPurpose;
  activity?: ActivityDraft;
}) {
  const [time, setTime] = useState(activity.time);
  const [open, setOpen] = useState(false);
  const draft = useMessageDraft(purpose, { ...activity, time });
  return (
    <QueryClientProvider client={new QueryClient()}>
      <label>
        Hora da atividade
        <input value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <button onClick={() => setOpen(true)}>Abrir envio</button>
      <SendWhatsappDialog
        open={open}
        onOpenChange={setOpen}
        target={TARGET}
        audience={{ preview: PREVIEW(purpose), isFresh: true }}
        moment={{
          value: NOW_MOMENT,
          onChange: () => undefined,
          today: "2026-11-20",
        }}
        draft={draft}
      />
    </QueryClientProvider>
  );
}

const FILL = "Preencher com os dados da atividade";
const textbox = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const send = () => screen.getByRole("button", { name: "Enviar agora" });
const open = () =>
  userEvent.click(screen.getByRole("button", { name: "Abrir envio" }));
const close = () =>
  userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
const changeTime = (value: string) =>
  fireEvent.change(screen.getByLabelText("Hora da atividade"), {
    target: { value },
  });

/** Preenche, escreve mais uma linha, fecha o diálogo, muda a hora na página e abre de novo. */
async function fillThenChangeTime() {
  await open();
  await userEvent.click(screen.getByRole("button", { name: FILL }));
  await userEvent.type(textbox(), "Levem o material.");
  await close();
  changeTime("10:00");
  await open();
}

beforeEach(() => {
  mutateAsync.mockReset();
});

describe("SendWhatsappDialog: preencher com os dados da atividade", () => {
  it("aceite 29: preencher, mudar a hora — aviso e botão travado; Preencher de novo libera", async () => {
    render(<Page />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: FILL }));
    expect(textbox().value).toBe(HEADER);
    await userEvent.type(textbox(), "Levem o material.");
    expect(
      screen.queryByRole("button", { name: "Preencher de novo" }),
    ).not.toBeInTheDocument();
    expect(send()).toBeEnabled();
    await close();
    changeTime("10:00");
    await open();

    const blocks = within(
      screen.getByRole("list", { name: "Travas do envio" }),
    );
    expect(blocks.getByText(DRAFT_STALE_TEXT)).toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(textbox().value).toBe(`${HEADER}Levem o material.`);

    await userEvent.click(
      screen.getByRole("button", { name: "Preencher de novo" }),
    );
    expect(textbox().value).toBe(`${NEW_HEADER}Levem o material.`);
    expect(screen.queryByText(DRAFT_STALE_TEXT)).not.toBeInTheDocument();
    expect(send()).toBeEnabled();
  });

  it("aceite 29: Conferi o texto libera sem mudar o texto", async () => {
    render(<Page />);
    await fillThenChangeTime();
    expect(send()).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Conferi o texto" }),
    );
    expect(screen.queryByText(DRAFT_STALE_TEXT)).not.toBeInTheDocument();
    expect(send()).toBeEnabled();
    expect(textbox().value).toBe(`${HEADER}Levem o material.`);
  });
});

describe("SendWhatsappDialog: só a finalidade mudou", () => {
  it("aviso do texto velho aparece e só Conferi o texto libera o envio, sem mexer no texto", async () => {
    const { rerender } = render(<Page />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: FILL }));
    await close();
    rerender(<Page purpose="lecture" />);
    await open();

    const blocks = within(
      screen.getByRole("list", { name: "Travas do envio" }),
    );
    expect(blocks.getByText(DRAFT_STALE_TEXT)).toBeInTheDocument();
    expect(send()).toBeDisabled();

    await userEvent.click(
      screen.getByRole("button", { name: "Conferi o texto" }),
    );
    expect(screen.queryByText(DRAFT_STALE_TEXT)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Conferi o texto" }),
    ).not.toBeInTheDocument();
    expect(send()).toBeEnabled();
    expect(textbox().value).toBe(HEADER);
  });
});

describe("SendWhatsappDialog: onde o botão de preencher aparece", () => {
  it("Urgência e Aviso de turno não mostram o botão", () => {
    const { unmount } = render(<Page purpose="urgency" />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir envio" }));
    expect(
      screen.queryByRole("button", { name: FILL }),
    ).not.toBeInTheDocument();
    unmount();
    render(<Page purpose="shift_notice" />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir envio" }));
    expect(
      screen.queryByRole("button", { name: FILL }),
    ).not.toBeInTheDocument();
  });

  it("Reunião sem hora: o botão aparece e só libera com a hora", async () => {
    render(<Page activity={{ ...ACTIVITY, time: "" }} />);
    await open();
    expect(screen.getByRole("button", { name: FILL })).toBeDisabled();
  });
});

describe("SendWhatsappDialog: o texto vive na página", () => {
  it("fechar e abrir o diálogo mantém o texto; envio aceito limpa", async () => {
    mutateAsync.mockResolvedValue({
      dispatchId: "d1",
      queued: 1,
      scheduled: 0,
      scheduledFor: null,
      skipped: [],
    });
    render(<Page />);
    await open();
    await userEvent.type(textbox(), "Oi equipe");
    await close();
    await open();
    expect(textbox().value).toBe("Oi equipe");

    await userEvent.click(send());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ text: "Oi equipe" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await open();
    expect(textbox().value).toBe("");
  });

  it("o cabeçalho conta no limite: passou de 2000 caracteres, trava o envio", async () => {
    render(<Page />);
    await open();
    fireEvent.change(textbox(), { target: { value: "a".repeat(1990) } });
    await userEvent.click(screen.getByRole("button", { name: FILL }));
    expect(
      screen.getByText("A mensagem passa de 2000 caracteres."),
    ).toBeInTheDocument();
    expect(send()).toBeDisabled();
  });
});
