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

const person = (over: Partial<DispatchRecipient>): DispatchRecipient => ({
  id: "r0",
  userName: "Pessoa A",
  sectorName: null,
  levelName: null,
  shiftName: null,
  status: "READ",
  reason: null,
  attempts: 1,
  channel: { name: null, phoneE164: "+5592999990000" },
  acceptedAt: null,
  deliveredAt: null,
  readAt: "2026-11-20T13:05:00.000Z",
  repliedAt: null,
  repeatable: false,
  manualRetries: 0,
  ...over,
});

const items = [
  person({ id: "r1" }),
  person({ id: "r2", userName: "Pessoa B" }),
];
const headers = () =>
  screen.getAllByRole("columnheader").map((h) => h.textContent);
const cellsOf = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

function show(ackLabels?: ReadonlyMap<string, string>) {
  mocks.recipients.mockReturnValue({
    data: { items, total: items.length, page: 1, pageSize: 50 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  render(
    <RecipientTable dispatchId="d1" failedCount={0} ackLabels={ackLabels} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: { id: "u1", email: "o@x.test", name: "Olga", role: "OPERATOR" },
  });
});

describe("RecipientTable: coluna Ciência", () => {
  it("coluna Ciência só no alerta, depois de Quando; reunião sem coluna", () => {
    show(new Map([["r1", "Ciente às 09:05"]]));
    expect(headers().slice(3, 6)).toEqual(["Quando", "Ciência", "Número"]);
    const [first, second] = screen.getAllByRole("row").slice(1);
    expect(cellsOf(first)[4]).toBe("Ciente às 09:05");
    expect(cellsOf(second)[4]).toBe("—");
  });

  it("sem o mapa (outras finalidades) a tabela não muda", () => {
    show();
    expect(headers()).not.toContain("Ciência");
    expect(cellsOf(screen.getAllByRole("row")[1])).toHaveLength(8);
  });
});
