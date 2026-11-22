import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutateAsync, toastSuccess } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toastSuccess: vi.fn(),
}));

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
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
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
import { useMessageDraft } from "../message-draft";
import type {
  SendTarget,
  TeamAudiencePreview,
  TeamAudienceRuleView,
  TeamPurpose,
} from "../schemas";
import { NOW_MOMENT, type Moment } from "../use-send-filters";
import { SendWhatsappDialog } from "./send-whatsapp-dialog";

const TODAY = "2026-11-20";
const KEY = "k".repeat(64);
/** Impressão da prévia que já traz o momento escolhido (diferente da de "Agora", para provar qual o envio leva). */
const MOMENT_KEY = "m".repeat(64);
const AT: Moment = { when: "at", at: { date: "2026-11-25", time: "09:00" } };
type SectorTarget = Extract<SendTarget, { type: "sector" }>;
const TARGET: SectorTarget = {
  type: "sector",
  sectorIds: ["s1"],
  levelIds: [],
  withoutLevel: false,
  label: "Compras · todos os turnos · 20/11",
  date: TODAY,
  shiftIds: [],
  includeOff: true,
  userIds: null,
  recipients: [{ id: "a", name: "Ana" }],
  leftOut: [],
};
const block = (code: string, message: string) => ({
  code: `team_whatsapp.${code}`,
  message,
});

const STARTS_AT = "2099-10-22T02:00:00.000Z";
/** Aviso de turno com um turno e início futuro: o alvo que oferece "No início do turno". */
const NOITE: SectorTarget = {
  ...TARGET,
  label: "Compras · Noite · 20/11",
  shiftIds: ["noite"],
  shiftStart: { startsAt: STARTS_AT, startTime: "22:00" },
};

type Setup = {
  purpose?: TeamPurpose;
  initial?: Moment;
  blocks?: TeamAudiencePreview["blocks"];
  target?: SectorTarget;
};

const completeAt = ({ when, at }: Moment) =>
  when === "at" && at?.date && at.time ? at : null;

type MomentRule = Pick<
  TeamAudienceRuleView,
  "when" | "scheduledFor" | "schedulePolicy"
>;

/** O momento como o servidor o devolve na regra: Data e hora completa ou o início do turno do alvo. */
function momentRule(moment: Moment, target: SectorTarget): MomentRule {
  const at = completeAt(moment);
  if (at) {
    const scheduledFor = new Date(
      `${at.date}T${at.time}:00-04:00`,
    ).toISOString();
    return { when: "at", scheduledFor, schedulePolicy: "frozen_recheck" };
  }
  const startsAt = target.shiftStart?.startsAt;
  if (moment.when === "shift_start" && startsAt) {
    return {
      when: "shift_start",
      scheduledFor: startsAt,
      schedulePolicy: "frozen_recheck",
    };
  }
  return { when: "now", scheduledFor: null, schedulePolicy: null };
}

/** A prévia falsa responde como o servidor: com o momento escolhido, a regra traz o momento e a política. */
function previewFor(
  moment: Moment,
  { purpose = "meeting", blocks = [], target = TARGET }: Setup,
): TeamAudiencePreview {
  const timing = momentRule(moment, target);
  const scheduled = timing.when !== "now";
  return {
    audienceKey: scheduled ? MOMENT_KEY : KEY,
    rule: {
      ...RULE_VIEW,
      purpose,
      base: "assigned",
      sectors: [{ id: "s1", name: "Compras" }],
      shifts: null,
      ...timing,
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
    blocks: scheduled ? blocks : [],
  };
}

const onOpenChange = vi.fn();

/** O estado do momento mora fora do diálogo, como nos filtros da tela (DG11). */
function Harness(props: Setup) {
  const [moment, setMoment] = useState<Moment>(props.initial ?? NOW_MOMENT);
  const draft = useMessageDraft(props.purpose ?? "meeting", null);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <SendWhatsappDialog
        open
        onOpenChange={onOpenChange}
        target={props.target ?? TARGET}
        audience={{ preview: previewFor(moment, props), isFresh: true }}
        moment={{ value: moment, onChange: setMoment, today: TODAY }}
        draft={draft}
      />
    </QueryClientProvider>
  );
}

const blockLines = () =>
  within(screen.getByRole("list", { name: "Travas do envio" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);
const result = (over: object) => ({
  dispatchId: "d1",
  queued: 0,
  scheduled: 0,
  scheduledFor: null,
  skipped: [],
  ...over,
});
const fillAt = (date: string, time: string) => {
  fireEvent.change(screen.getByLabelText("Data do envio"), {
    target: { value: date },
  });
  fireEvent.change(screen.getByLabelText("Hora do envio"), {
    target: { value: time },
  });
};
const typeText = () =>
  userEvent.type(screen.getByLabelText("Mensagem"), "Oi equipe");

beforeEach(() => {
  mutateAsync.mockReset();
  toastSuccess.mockReset();
  onOpenChange.mockReset();
});

describe("SendWhatsappDialog: Data e hora oferecida pela finalidade", () => {
  it("Urgência não oferece Data e hora; Reunião oferece", () => {
    const { unmount } = render(<Harness purpose="urgency" />);
    expect(
      screen.queryByRole("radio", { name: "Data e hora" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Enviar agora" }),
    ).toBeInTheDocument();
    unmount();
    render(<Harness purpose="meeting" />);
    expect(
      screen.getByRole("radio", { name: "Data e hora" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "No início do turno" }),
    ).not.toBeInTheDocument();
  });
});

describe("SendWhatsappDialog: travas de Data e hora", () => {
  it("data e hora incompleta trava com Informe a data e a hora do envio.", async () => {
    render(
      <Harness
        initial={{ when: "at", at: { date: "2026-11-25", time: "" } }}
      />,
    );
    await typeText();
    expect(blockLines()).toEqual(["Informe a data e a hora do envio."]);
    expect(screen.getByRole("button", { name: "Agendar" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Hora do envio"), {
      target: { value: "09:00" },
    });
    expect(
      screen.queryByRole("list", { name: "Travas do envio" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agendar" })).toBeEnabled();
  });

  it("aceite 30: trava after_activity_start do servidor aparece por extenso", async () => {
    const text = "A mensagem precisa sair antes do início da atividade.";
    render(
      <Harness initial={AT} blocks={[block("after_activity_start", text)]} />,
    );
    await typeText();
    expect(blockLines()).toEqual([text]);
    expect(screen.getByRole("button", { name: "Agendar" })).toBeDisabled();
  });

  it("aceite 37: data além de 30 dias não é oferecida no campo; trava do servidor aparece", async () => {
    const text = "O envio pode ser agendado para até 30 dias à frente.";
    render(<Harness initial={AT} blocks={[block("schedule_too_far", text)]} />);
    await typeText();
    expect(screen.getByLabelText("Data do envio")).toHaveAttribute(
      "max",
      "2026-12-20",
    );
    expect(blockLines()).toEqual([text]);
    expect(screen.getByRole("button", { name: "Agendar" })).toBeDisabled();
  });
});

describe("SendWhatsappDialog: enviar em Data e hora", () => {
  it("envio manda when at, at e a audienceKey da prévia atual; painel e aviso trazem a data e hora", async () => {
    mutateAsync.mockResolvedValue(result({ scheduled: 1 }));
    render(<Harness />);
    await userEvent.click(screen.getByRole("radio", { name: "Data e hora" }));
    fillAt("2026-11-25", "09:00");
    expect(screen.getByText("Em 25/11/2026 às 09:00")).toBeInTheDocument();
    await typeText();
    expect(
      screen.queryByRole("button", { name: "Enviar agora" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Agendar" }));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({
      text: "Oi equipe",
      when: "at",
      at: { date: "2026-11-25", time: "09:00" },
      audienceKey: MOMENT_KEY,
      purpose: "meeting",
    });
    expect(toastSuccess.mock.calls[0][0]).toBe(
      "Agendado para 25/11/2026 às 09:00.",
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Agora segue sem when nem at", async () => {
    mutateAsync.mockResolvedValue(result({ queued: 1 }));
    render(<Harness />);
    await typeText();
    await userEvent.click(screen.getByRole("button", { name: "Enviar agora" }));
    expect(mutateAsync.mock.calls[0][0]).not.toHaveProperty("when");
    expect(mutateAsync.mock.calls[0][0]).not.toHaveProperty("at");
  });
});

/** Chama o `onClick` que o React guardou no botão, como se a trava do `disabled` não existisse. */
async function clickIgnoringDisabled(button: HTMLElement) {
  const key = Object.keys(button).find((k) => k.startsWith("__reactProps$"));
  const props = (button as unknown as Record<string, { onClick: () => void }>)[
    key ?? ""
  ];
  await act(async () => {
    props.onClick();
  });
}

describe("SendWhatsappDialog: Data e hora incompleta nunca vira envio imediato", () => {
  it.each([
    ["sem data nem hora", null],
    ["sem a hora", { date: "2026-11-25", time: "" }],
  ])("forçado o envio %s, nenhum POST sai", async (_name, at) => {
    render(<Harness initial={{ when: "at", at }} />);
    await typeText();
    const button = screen.getByRole("button", { name: "Agendar" });
    expect(button).toBeDisabled();
    await clickIgnoringDisabled(button);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("SendWhatsappDialog: agendar só pelo momento escolhido", () => {
  it("em Agora não há botão de agendar: só Enviar agora", async () => {
    render(<Harness purpose="shift_notice" target={NOITE} />);
    await typeText();
    expect(
      screen.getByRole("radio", { name: "No início do turno" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "No início do turno" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Agendar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar agora" })).toBeEnabled();
  });

  it("rádio No início do turno: painel e aviso com o scheduledFor da prévia; envio com when shift_start e a audienceKey dela", async () => {
    mutateAsync.mockResolvedValue(
      result({ scheduled: 1, scheduledFor: STARTS_AT }),
    );
    render(<Harness purpose="shift_notice" target={NOITE} />);
    await userEvent.click(
      screen.getByRole("radio", { name: "No início do turno" }),
    );
    const panel = within(
      screen.getByRole("region", { name: "Regra do público" }),
    );
    expect(
      panel.getByText(
        `No início do turno (${new Date(STARTS_AT).toLocaleString("pt-BR")})`,
      ),
    ).toBeInTheDocument();
    expect(panel.getByText(/^Lista conferida agora;/)).toBeInTheDocument();
    await typeText();
    await userEvent.click(
      screen.getByRole("button", { name: "No início do turno" }),
    );
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({
      when: "shift_start",
      audienceKey: MOMENT_KEY,
      purpose: "shift_notice",
      target: { shiftIds: ["noite"] },
    });
    expect(mutateAsync.mock.calls[0][0]).not.toHaveProperty("at");
    expect(toastSuccess.mock.calls[0][0]).toBe(
      "Agendado para 21/10/2099 às 22:00.",
    );
  });
});
