import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./recipient-table", () => ({
  RecipientTable: ({ query }: { query?: string }) => (
    <div>Busca da tabela: {query ?? ""}</div>
  ),
}));

import { RULE_VIEW } from "../audience-preview.test-fixtures";
import type {
  DispatchDetail,
  LeftOutRosterPerson,
  TeamAudiencePerson,
  TeamExcludedPerson,
} from "../schemas";
import { DispatchResult } from "./dispatch-result";

const zero = {
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  failed: 0,
  uncertain: 0,
  skipped: 0,
  scheduled: 0,
  cancelled: 0,
};
const NOW = new Date("2026-11-21T15:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) =>
  new Date(NOW.getTime() + offsetMs).toISOString();

const detail = (over: Partial<DispatchDetail> = {}): DispatchDetail => ({
  id: "d1",
  targetLabel: "Logística · Manhã · 21/11",
  text: "Aviso de turno",
  state: "DISPATCHED",
  createdAt: "2026-11-20T12:00:00.000Z",
  scheduledFor: iso(-4 * HOUR),
  firedAt: iso(-4 * HOUR),
  author: { id: "a1", name: "Ada" },
  sectors: [{ id: "s1", name: "Logística" }],
  channels: [],
  counts: { ...zero, sent: 2 },
  leftOut: { unselected: [], off: [] },
  purpose: "shift_notice",
  base: "on_duty",
  rule: { ...RULE_VIEW, when: "shift_start", schedulePolicy: "frozen_recheck" },
  excluded: [],
  recheck: null,
  ...over,
});
const lateJoined = (
  name: string,
  shiftName: string | null = "Manhã",
): TeamAudiencePerson => ({
  userId: `u-${name}`,
  name,
  sectorId: "s1",
  sectorName: "Logística",
  shiftName,
  levelName: null,
});
const excludedPerson = (
  name: string,
  reason: TeamExcludedPerson["reason"],
): TeamExcludedPerson => ({
  ...lateJoined(name),
  reason,
});
const lines = (title: string) =>
  within(screen.getByRole("list", { name: title }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);
const RECHECK_AT = "2026-11-21T13:00:30.000Z";
const lapsedAt = (hours: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  return iso(-hours * HOUR);
};

afterEach(() => vi.useRealTimers());

const view = (over: Partial<DispatchDetail> = {}) => (
  <DispatchResult dispatch={detail(over)} />
);
const NOTICE =
  "Não enviado: passou da hora. O sistema não disparou este envio até 2 horas depois da hora marcada. " +
  "Se a mensagem ainda fizer sentido, crie um envio novo.";
const SCHEDULED = { state: "SCHEDULED", firedAt: null } as const;

describe("DispatchResult: reconferência do agendado", () => {
  it("DG10: No público conta a foto da criação; pulados da reconferência não entram em Ficaram de fora", () => {
    render(
      view({
        counts: { ...zero, sent: 1, skipped: 3 },
        excluded: [excludedPerson("Caio", "no_phone")],
        recheck: { at: RECHECK_AT, skipped: 2, lateJoined: [] },
      }),
    );
    const panel = within(
      screen.getByRole("region", { name: "Regra do público" }),
    );
    expect(panel.getByText("No público (3) · De fora (1)")).toBeInTheDocument();
    expect(lines("Sem telefone (1)")).toEqual(["Caio · Logística · Manhã"]);
    expect(screen.queryByText(/Saiu do setor/)).not.toBeInTheDocument();
  });

  it("bloco da reconferência com hora e pulados", () => {
    render(view({ recheck: { at: RECHECK_AT, skipped: 2, lateJoined: [] } }));
    expect(
      screen.getByText("Reconferido em 21/11/2026 às 09:00: 2 pulado(s)."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Entraram depois/)).not.toBeInTheDocument();
  });

  it("sem reconferência (imediato, antigo ou ainda agendado) não mostra o bloco", () => {
    render(view({ recheck: undefined }));
    expect(screen.queryByText(/Reconferido em/)).not.toBeInTheDocument();
  });
});

describe("DispatchResult: entraram depois", () => {
  it("aceite 22: Entraram depois do agendamento, não receberam, com setor e turno", () => {
    const lateJoinedList = [lateJoined("Nina"), lateJoined("Nina", null)];
    render(
      view({
        recheck: { at: RECHECK_AT, skipped: 0, lateJoined: lateJoinedList },
      }),
    );
    const title = "Entraram depois do agendamento, não receberam (2)";
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(lines(title)).toEqual([
      "Nina · Logística · Manhã",
      "Nina · Logística",
    ]);
  });
});

describe("DispatchResult: situação do envio", () => {
  it('aceite 24: todos pulados mostra "Ninguém recebeu" e nunca o aviso de vencido', () => {
    render(view({ counts: { ...zero, skipped: 3 } }));
    expect(screen.getByText(/· Ninguém recebeu/)).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it("aceite 26: vencido mostra o aviso para reenviar", () => {
    render(view({ state: "EXPIRED", counts: { ...zero, skipped: 3 } }));
    expect(
      screen.getByText(/· Não enviado: passou da hora/),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(NOTICE);
  });
});

describe("DispatchResult: agendado vencido com o worker parado", () => {
  it("DG16: agendado vencido há mais de 2 h mostra o mesmo aviso; antes disso, não", () => {
    const sched = { ...SCHEDULED, counts: { ...zero, scheduled: 3 } };
    const { rerender } = render(
      view({ ...sched, scheduledFor: lapsedAt(2.5) }),
    );
    expect(
      screen.getByText(/· Não enviado: passou da hora/),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(NOTICE);
    rerender(view({ ...sched, scheduledFor: iso(-1 * HOUR) }));
    expect(screen.getByText(/· Agendado/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("DispatchResult: busca por nome", () => {
  it("aceite 31: busca manda q à tabela e filtra excluídos e entraram depois, sem acento e sem caixa", async () => {
    render(
      view({
        excluded: [
          excludedPerson("José Lima", "day_off"),
          excludedPerson("Bia Souza", "vacation"),
        ],
        recheck: {
          at: RECHECK_AT,
          skipped: 0,
          lateJoined: [lateJoined("JOSE Rocha"), lateJoined("Nina Alves")],
        },
      }),
    );
    expect(screen.getByText("Busca da tabela:")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", {
      name: "Buscar pessoa pelo nome",
    });
    await userEvent.type(search, "jose");
    await waitFor(() =>
      expect(screen.getByText("Busca da tabela: jose")).toBeInTheDocument(),
    );
    expect(lines("Folga (1)")).toEqual(["José Lima · Logística · Manhã"]);
    expect(screen.queryByText(/Bia Souza/)).not.toBeInTheDocument();
    const late = "Entraram depois do agendamento, não receberam (1 de 2)";
    expect(lines(late)).toEqual(["JOSE Rocha · Logística · Manhã"]);
    expect(
      screen.getByText("No público (2) · De fora (2)"),
    ).toBeInTheDocument();
  });
});

const NO_MATCH = "Ninguém com esse nome nesta lista.";
const legacyPerson = (name: string): LeftOutRosterPerson => ({
  userId: null,
  name,
  jobTitle: null,
  shiftName: null,
  reason: null,
  sectorName: null,
  levelName: null,
});
async function search(term: string) {
  const box = screen.getByRole("searchbox", {
    name: "Buscar pessoa pelo nome",
  });
  await userEvent.type(box, term);
  await screen.findByText(`Busca da tabela: ${term}`);
}
const withLists = () =>
  view({
    excluded: [
      excludedPerson("José Lima", "day_off"),
      excludedPerson("Bia Souza", "vacation"),
    ],
    recheck: {
      at: RECHECK_AT,
      skipped: 0,
      lateJoined: [lateJoined("JOSE Rocha"), lateJoined("Nina Alves")],
    },
  });

describe("DispatchResult: títulos com busca (n de m)", () => {
  it("com termo os títulos dos excluídos e de entraram depois mostram n de m; sem termo, o total", async () => {
    render(withLists());
    expect(
      screen.getByRole("heading", { name: "Ficaram de fora (2)" }),
    ).toBeInTheDocument();
    await search("jose");
    expect(
      screen.getByRole("heading", { name: "Ficaram de fora (1 de 2)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Entraram depois.*\(1 de 2\)/ }),
    ).toBeInTheDocument();
    await userEvent.clear(
      screen.getByRole("searchbox", { name: "Buscar pessoa pelo nome" }),
    );
    await screen.findByRole("heading", { name: "Ficaram de fora (2)" });
    expect(
      screen.getByRole("heading", { name: /Entraram depois.*\(2\)/ }),
    ).toBeInTheDocument();
  });

  it("a busca que zera a lista mostra o aviso na própria lista, com 0 de m, em vez de sumir com ela", async () => {
    render(withLists());
    await search("zzz");
    expect(
      screen.getByRole("heading", { name: "Ficaram de fora (0 de 2)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Entraram depois.*\(0 de 2\)/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(NO_MATCH)).toHaveLength(2);
    expect(
      screen.queryByRole("list", { name: /Folga|Férias|Entraram depois/ }),
    ).not.toBeInTheDocument();
  });
});

describe("DispatchResult: legado (LeftOut) com busca", () => {
  const unselected = ["Ana", "Bia"].map((name) => ({
    ...legacyPerson(name),
    reason: null,
  }));
  const legacy = () =>
    view({
      rule: null,
      purpose: null,
      base: null,
      leftOut: {
        unselected,
        off: [{ ...legacyPerson("Caio Ana"), reason: "VACATION" }],
      },
    });

  it("com termo o título é n de m e só as linhas que casam ficam; zerando, o aviso; sem lista, nada", async () => {
    const { rerender } = render(legacy());
    await search("ana");
    expect(lines("Ficaram de fora (2 de 3)")).toEqual([
      "Ana · não selecionado",
      "Caio Ana · Férias",
    ]);
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Buscar pessoa pelo nome" }),
      "x",
    );
    await screen.findByRole("heading", { name: "Ficaram de fora (0 de 3)" });
    expect(screen.getByText(NO_MATCH)).toBeInTheDocument();
    rerender(view({ rule: null, leftOut: { unselected: [], off: [] } }));
    expect(screen.queryByText(/Ficaram de fora/)).not.toBeInTheDocument();
  });
});
