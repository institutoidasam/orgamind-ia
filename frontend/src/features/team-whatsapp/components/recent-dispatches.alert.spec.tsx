import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/x">{children}</a>
  ),
}));

import type { DispatchList } from "../schemas";
import { RecentDispatches } from "./recent-dispatches";

type Item = DispatchList["items"][number];

const counts = {
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

const base: Item = {
  id: "d1",
  createdAt: "2026-11-20T13:00:00.000Z",
  author: { id: "a1", name: "Ada", email: "ada@x.test" },
  target: { type: "sector", id: "s1", label: "Logística", shift: null },
  sectors: [{ id: "s1", name: "Logística" }],
  channels: [],
  counts,
  rosterDate: "2026-11-20",
  state: "DISPATCHED",
  scheduledFor: null,
  firedAt: null,
  purpose: "urgency",
  base: "on_duty",
  activity: null,
  urgencyReason: "Falta de energia",
};

const paging = { page: 1, pageSize: 20, total: 1, onPageChange: vi.fn() };
const purposeCell = (extra: Partial<Item>) => {
  const { unmount } = render(
    <RecentDispatches items={[{ ...base, ...extra }]} paging={paging} />,
  );
  return {
    cell: within(within(screen.getAllByRole("row")[1]).getAllByRole("cell")[3]),
    unmount,
  };
};

describe("RecentDispatches: alerta urgente", () => {
  it("histórico: Lembrete do alerta de dd/mm HH:mm; alerta com Prazo de ciência: 15 min", () => {
    const { cell: reminder, unmount } = purposeCell({
      reminderOf: { dispatchId: "a1", createdAt: "2026-11-20T13:00:00.000Z" },
    });
    expect(
      reminder.getByText("Lembrete do alerta de 20/11 09:00"),
    ).toBeInTheDocument();
    expect(reminder.queryByText(/Prazo de ciência/)).not.toBeInTheDocument();
    unmount();
    const { cell: alert } = purposeCell({
      ackDeadlineMinutes: 15,
      ackDeadlineAt: "2026-11-20T13:15:00.000Z",
      reminderOf: null,
    });
    expect(alert.getByText("Prazo de ciência: 15 min")).toBeInTheDocument();
    expect(alert.queryByText(/Lembrete do alerta/)).not.toBeInTheDocument();
  });

  it("aceite 14: urgência antiga (campos nulos ou ausentes) fica como hoje", () => {
    const { cell: old } = purposeCell({
      ackDeadlineMinutes: null,
      ackDeadlineAt: null,
      reminderOf: null,
    });
    expect(old.getByText("Urgência")).toBeInTheDocument();
    expect(
      old.queryByText(/Prazo de ciência|Lembrete do alerta/),
    ).not.toBeInTheDocument();
  });
});
