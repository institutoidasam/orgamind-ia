import { render, screen, within, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// EventsExplorer pulls a page of messages via useCampaignMessages. The filter
// tab counts must come from the authoritative `statusCounts` aggregate, never
// from the current (paginated) page — otherwise a 50-row page understates the
// real totals. Stub the hook so we control exactly what one page looks like.
const useCampaignMessages = vi.fn();
vi.mock("@/features/campaigns/api", () => ({
  useCampaignMessages: (...args: unknown[]) => useCampaignMessages(...args),
}));
// EventDetail and EventsList have their own deps (mutations / formatting);
// render them inert so this suite is about the explorer's counting only.
vi.mock("./event-detail", () => ({ EventDetail: () => null }));
vi.mock("./events-list", () => ({ EventsList: () => null }));

import { EventsExplorer } from "./events-explorer";

const STATUS_COUNTS = [
  { status: "READ", _count: 120 },
  { status: "DELIVERED", _count: 30 },
  { status: "FAILED", _count: 7 },
];

/** Returns the numeric count rendered inside the named filter tab button. */
function countForTab(label: RegExp): string {
  const btn = screen.getByRole("button", { name: label });
  return within(btn).getByText(/^\d+$/).textContent ?? "";
}

beforeEach(() => {
  useCampaignMessages.mockReset();
});

describe("EventsExplorer filter counts", () => {
  it("derives every tab count from statusCounts, not the current page", () => {
    // The visible page is tiny (2 rows) and does NOT reflect the real totals.
    useCampaignMessages.mockReturnValue({
      data: {
        items: [
          { id: "m1", status: "READ" },
          { id: "m2", status: "READ" },
        ],
        total: 157,
      },
    });

    render(<EventsExplorer campaignId="c1" statusCounts={STATUS_COUNTS} />);

    // "Todos" must be the sum of statusCounts (157), not the 2 rows on screen.
    expect(countForTab(/todos/i)).toBe("157");
    expect(countForTab(/lidas/i)).toBe("120");
    expect(countForTab(/entregues/i)).toBe("30");
    expect(countForTab(/falhas/i)).toBe("7");
  });

  it("shows zero for a status missing from statusCounts", () => {
    useCampaignMessages.mockReturnValue({
      data: { items: [{ id: "m1", status: "READ" }], total: 120 },
    });
    render(
      <EventsExplorer
        campaignId="c1"
        statusCounts={[{ status: "READ", _count: 120 }]}
      />,
    );
    expect(countForTab(/falhas/i)).toBe("0");
  });

  it("never reports the current page length as the 'Todos' total", () => {
    // Regression for the latent fallback: when statusCounts was absent the
    // "Todos" tab printed messages.length (the visible page) instead of the
    // authoritative total — drastically understating a multi-page campaign.
    // statusCounts is now a required prop, so the count must always reflect
    // the aggregate total (157), never the 2 rows on this page.
    useCampaignMessages.mockReturnValue({
      data: {
        items: [
          { id: "m1", status: "READ" },
          { id: "m2", status: "READ" },
        ],
        total: 157,
      },
    });
    // Cast through unknown to exercise the runtime path a stale/cast API
    // response could produce despite the required type.
    render(
      <EventsExplorer
        campaignId="c1"
        statusCounts={undefined as unknown as typeof STATUS_COUNTS}
      />,
    );
    expect(countForTab(/todos/i)).not.toBe("2");
    expect(countForTab(/todos/i)).toBe("157");
  });
});

/** Background color of a filter tab button (active tabs are highlighted). */
function bgForTab(label: RegExp): string {
  return screen.getByRole("button", { name: label }).style.background;
}

describe("EventsExplorer active-filter selection", () => {
  it("starts on 'Todos' and queries with no status filter", () => {
    useCampaignMessages.mockReturnValue({
      data: { items: [{ id: "m1", status: "READ" }], total: 1 },
    });
    render(<EventsExplorer campaignId="c1" statusCounts={STATUS_COUNTS} />);

    // Only the active tab carries the highlighted background.
    expect(bgForTab(/todos/i)).toBe("var(--brand-blue-soft)");
    expect(bgForTab(/lidas/i)).toBe("transparent");

    // "Todos" → status undefined in the hook query.
    const lastCall =
      useCampaignMessages.mock.calls[useCampaignMessages.mock.calls.length - 1];
    expect(lastCall[1].status).toBeUndefined();
  });

  it("highlights a clicked tab and passes its status to the query", () => {
    useCampaignMessages.mockReturnValue({
      data: { items: [{ id: "m1", status: "FAILED" }], total: 7 },
    });
    render(<EventsExplorer campaignId="c1" statusCounts={STATUS_COUNTS} />);

    fireEvent.click(screen.getByRole("button", { name: /falhas/i }));

    expect(bgForTab(/falhas/i)).toBe("var(--brand-blue-soft)");
    expect(bgForTab(/todos/i)).toBe("transparent");

    const lastCall =
      useCampaignMessages.mock.calls[useCampaignMessages.mock.calls.length - 1];
    expect(lastCall[1].status).toBe("FAILED");
  });
});

describe("EventsExplorer pagination", () => {
  // PAGE_SIZE is 50; total 157 → 4 pages. Pager only renders for >1 page.
  it("does not render the pager when there is a single page", () => {
    useCampaignMessages.mockReturnValue({
      data: { items: [{ id: "m1", status: "READ" }], total: 10 },
    });
    render(<EventsExplorer campaignId="c1" statusCounts={STATUS_COUNTS} />);
    expect(screen.queryByText(/página/i)).not.toBeInTheDocument();
  });

  it("disables prev on the first page and enables next", () => {
    useCampaignMessages.mockReturnValue({
      data: { items: [{ id: "m1", status: "READ" }], total: 157 },
    });
    render(<EventsExplorer campaignId="c1" statusCounts={STATUS_COUNTS} />);

    expect(screen.getByText(/página 1 de 4/i)).toBeInTheDocument();
    const prev = screen.getByRole("button", { name: "‹" });
    const next = screen.getByRole("button", { name: "›" });
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();
  });

  it("advances the page and updates prev/next enablement", () => {
    useCampaignMessages.mockReturnValue({
      data: { items: [{ id: "m1", status: "READ" }], total: 157 },
    });
    render(<EventsExplorer campaignId="c1" statusCounts={STATUS_COUNTS} />);

    fireEvent.click(screen.getByRole("button", { name: "›" }));

    expect(screen.getByText(/página 2 de 4/i)).toBeInTheDocument();
    // After leaving page 1, prev becomes available; next still available.
    expect(screen.getByRole("button", { name: "‹" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "›" })).toBeEnabled();
    // The page index flows through to the query.
    const lastCall =
      useCampaignMessages.mock.calls[useCampaignMessages.mock.calls.length - 1];
    expect(lastCall[1].page).toBe(2);
  });

  it("disables next on the last page", () => {
    // total 100, PAGE_SIZE 50 → exactly 2 pages.
    useCampaignMessages.mockReturnValue({
      data: { items: [{ id: "m1", status: "READ" }], total: 100 },
    });
    render(<EventsExplorer campaignId="c1" statusCounts={STATUS_COUNTS} />);

    fireEvent.click(screen.getByRole("button", { name: "›" }));

    expect(screen.getByText(/página 2 de 2/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "›" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "‹" })).toBeEnabled();
  });
});

describe("EventsExplorer live poll gate", () => {
  it("passes live=true through to the messages hook when live", () => {
    useCampaignMessages.mockReturnValue({
      data: { items: [], total: 0 },
    });
    render(
      <EventsExplorer campaignId="c1" live statusCounts={STATUS_COUNTS} />,
    );
    const lastCall =
      useCampaignMessages.mock.calls[useCampaignMessages.mock.calls.length - 1];
    expect(lastCall[2]).toEqual({ live: true });
    // The "ao vivo" indicator is only shown while live.
    expect(screen.getByText(/ao vivo/i)).toBeInTheDocument();
  });

  it("passes live=undefined through to the hook when not live", () => {
    useCampaignMessages.mockReturnValue({
      data: { items: [], total: 0 },
    });
    render(<EventsExplorer campaignId="c1" statusCounts={STATUS_COUNTS} />);
    const lastCall =
      useCampaignMessages.mock.calls[useCampaignMessages.mock.calls.length - 1];
    expect(lastCall[2]).toEqual({ live: undefined });
    expect(screen.queryByText(/ao vivo/i)).not.toBeInTheDocument();
  });
});
