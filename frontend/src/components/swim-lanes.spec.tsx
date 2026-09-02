import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SwimLanes } from "./swim-lanes";
import type { CampaignMessage } from "@/features/campaigns/schemas";

function baseMessage(over: Partial<CampaignMessage> = {}): CampaignMessage {
  return {
    id: "m1",
    campaignId: "c1",
    contactId: "ct1",
    providerMessageId: null,
    status: "QUEUED",
    errorCode: null,
    errorMessage: null,
    variables: {},
    queuedAt: "2026-06-05T00:00:00Z",
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    contact: {
      id: "ct1",
      name: "Maria",
      phoneE164: "+5592999",
      optedOut: false,
      city: null,
      tags: [],
      profilePictureUrl: null,
    },
    ...over,
  };
}

describe("SwimLanes — stage labels", () => {
  it("renders all four stage labels in order", () => {
    render(<SwimLanes message={baseMessage()} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("Enfileirada");
    expect(items[1]).toHaveTextContent("Enviada");
    expect(items[2]).toHaveTextContent("Entregue");
    expect(items[3]).toHaveTextContent("Lida");
  });
});

describe("SwimLanes — durations and bars", () => {
  it("shows '—' on a reached stage with no measurable duration and blank on unreached", () => {
    // Only queued: stage0 reached but has no end timestamp -> "—".
    // stages 1..3 unreached -> empty duration cell.
    render(<SwimLanes message={baseMessage()} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("—");
  });

  it("renders a duration string between queued and sent", () => {
    const msg = baseMessage({
      status: "SENT",
      queuedAt: "2026-06-05T00:00:00Z",
      sentAt: "2026-06-05T00:00:05Z", // +5s
    });
    render(<SwimLanes message={msg} />);
    // formatDelta: 5000ms -> "+5s"
    expect(screen.getByText("+5s")).toBeInTheDocument();
  });

  it("formats sub-second / minute / hour deltas", () => {
    // sub-second on stage0 (queued->sent 500ms)
    const a = baseMessage({
      status: "SENT",
      queuedAt: "2026-06-05T00:00:00.000Z",
      sentAt: "2026-06-05T00:00:00.500Z",
    });
    const { unmount } = render(<SwimLanes message={a} />);
    expect(screen.getByText("+500ms")).toBeInTheDocument();
    unmount();

    // minutes: queued->sent 2min
    const b = baseMessage({
      status: "SENT",
      queuedAt: "2026-06-05T00:00:00Z",
      sentAt: "2026-06-05T00:02:00Z",
    });
    const r2 = render(<SwimLanes message={b} />);
    expect(screen.getByText("+2min")).toBeInTheDocument();
    r2.unmount();

    // hours: queued->sent 2h
    const c = baseMessage({
      status: "SENT",
      queuedAt: "2026-06-05T00:00:00Z",
      sentAt: "2026-06-05T02:00:00Z",
    });
    render(<SwimLanes message={c} />);
    expect(screen.getByText("+2h")).toBeInTheDocument();
  });
});

describe("SwimLanes — failure / cancellation cards", () => {
  it("renders a failure card with errorCode and errorMessage on the next-pending stage", () => {
    const msg = baseMessage({
      status: "FAILED",
      sentAt: "2026-06-05T00:00:05Z",
      failedAt: "2026-06-05T00:00:10Z",
      errorCode: "131049",
      errorMessage: "Rate limit",
    });
    render(<SwimLanes message={msg} />);
    // sent present, delivered missing -> card lands on "Entregue" stage (index 2)
    expect(screen.getByText("[131049] Rate limit")).toBeInTheDocument();
  });

  it("renders 'Falha desconhecida' when failed without an errorMessage", () => {
    const msg = baseMessage({
      status: "FAILED",
      failedAt: "2026-06-05T00:00:10Z",
      errorCode: null,
      errorMessage: null,
    });
    render(<SwimLanes message={msg} />);
    expect(screen.getByText("Falha desconhecida")).toBeInTheDocument();
  });

  it("renders the opt-out cancellation card for errorCode opted_out", () => {
    const msg = baseMessage({
      status: "CANCELLED",
      errorCode: "opted_out",
    });
    render(<SwimLanes message={msg} />);
    expect(
      screen.getByText("Contato em opt-out — não enviada"),
    ).toBeInTheDocument();
  });

  it("renders the generic cancellation card for other cancellations", () => {
    const msg = baseMessage({ status: "CANCELLED", errorCode: null });
    render(<SwimLanes message={msg} />);
    expect(screen.getByText("Mensagem cancelada")).toBeInTheDocument();
  });
});

describe("SwimLanes — reached check marks", () => {
  it("paints a check on reached stages and the connector for the first link", () => {
    const msg = baseMessage({
      status: "READ",
      sentAt: "2026-06-05T00:00:05Z",
      deliveredAt: "2026-06-05T00:00:08Z",
      readAt: "2026-06-05T00:00:20Z",
    });
    const { container } = render(<SwimLanes message={msg} />);
    // All 4 stages reached -> 4 check icons (lucide renders <svg>).
    const checks = container.querySelectorAll("svg");
    expect(checks.length).toBe(4);
  });
});
