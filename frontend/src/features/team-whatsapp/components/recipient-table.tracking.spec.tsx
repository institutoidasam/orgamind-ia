import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recipients: vi.fn() }));

vi.mock("@/features/team-whatsapp/api", () => ({
  useDispatchRecipients: () => mocks.recipients(),
  useRetryRecipients: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { useAuthStore } from "@/stores/auth.store";
import type { DispatchRecipient } from "../schemas";
import { RecipientTable } from "./recipient-table";

const ACEITO_EM = "2026-11-20T13:05:00.000Z";

const person = (over: Partial<DispatchRecipient>): DispatchRecipient => ({
  id: "r0",
  userName: "Pessoa A",
  sectorName: null,
  levelName: null,
  shiftName: null,
  status: "SENT",
  reason: null,
  attempts: 1,
  channel: { name: null, phoneE164: "+5592999990000" },
  acceptedAt: ACEITO_EM,
  deliveredAt: null,
  readAt: null,
  repliedAt: null,
  repeatable: false,
  manualRetries: 0,
  ...over,
});

function show(items: DispatchRecipient[]) {
  mocks.recipients.mockReturnValue({
    data: { items, total: items.length, page: 1, pageSize: 50 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  render(<RecipientTable dispatchId="d1" failedCount={0} />);
}

const cellsOf = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
const bodyRows = () => screen.getAllByRole("row").slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: { id: "u1", email: "o@x.test", name: "Olga", role: "OPERATOR" },
  });
});

describe("RecipientTable: coluna Quando", () => {
  it("aceite 5: coluna Quando com dd/mm HH:mm da hora do estado em Manaus", () => {
    show([
      person({ acceptedAt: ACEITO_EM }),
      person({ id: "r1", status: "READ", readAt: "2026-11-20T23:30:00.000Z" }),
    ]);
    expect(bodyRows().map((row) => cellsOf(row)[3])).toEqual([
      "20/11 09:05",
      "20/11 19:30",
    ]);
  });

  it("Quando — nos estados sem hora", () => {
    const semHora = [
      "QUEUED",
      "FAILED",
      "UNCERTAIN",
      "SKIPPED",
      "SCHEDULED",
      "CANCELLED",
    ] as const;
    show(semHora.map((status, i) => person({ id: `r${i}`, status })));
    expect(bodyRows().map((row) => cellsOf(row)[3])).toEqual(
      semHora.map(() => "—"),
    );
  });
});

describe("RecipientTable: Número e Tentativas", () => {
  it("aceite 2: Número com conexão conferida às HH:mm:ss; sem hora só o número", () => {
    show([
      person({ channelCheckedAt: "2026-11-20T13:04:09.000Z" }),
      person({ id: "r1", channelCheckedAt: null }),
    ]);
    expect(bodyRows().map((row) => cellsOf(row)[4])).toEqual([
      "+5592999990000conexão conferida às 09:04:09",
      "+5592999990000",
    ]);
  });

  it("aceite 5: Tentativas 2 · repetido 1× depois de um Repetir", () => {
    show([
      person({ attempts: 2, manualRetries: 1 }),
      person({ id: "r1", attempts: 3 }),
    ]);
    expect(bodyRows().map((row) => cellsOf(row)[5])).toEqual([
      "2 · repetido 1×",
      "3",
    ]);
  });
});

describe("RecipientTable: fila perdida e ordem das colunas", () => {
  it("Falhou: Saiu da fila sem envio com Repetir", () => {
    show([
      person({
        status: "FAILED",
        reason: "team_whatsapp.queue_lost",
        acceptedAt: null,
        repeatable: true,
      }),
    ]);
    const [row] = bodyRows();
    expect(cellsOf(row)[2]).toBe("Falhou: Saiu da fila sem envio");
    expect(
      within(row).getByRole("button", { name: "Repetir" }),
    ).toBeInTheDocument();
  });

  it("ordem das colunas: Nome, Telefone usado, Situação, Quando, Número, Tentativas, Motivo", () => {
    show([person({})]);
    expect(
      screen.getAllByRole("columnheader").map((head) => head.textContent),
    ).toEqual([
      "Nome",
      "Telefone usado",
      "Situação",
      "Quando",
      "Número",
      "Tentativas",
      "Motivo",
      "Ações",
    ]);
  });
});
