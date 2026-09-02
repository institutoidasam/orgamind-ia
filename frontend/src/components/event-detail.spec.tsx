import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Stable mocks shared across renders so handler behaviour can be asserted.
const retryMutate = vi.fn();
const redispatchMutate = vi.fn();

// The retry/redispatch mutations hit the API on mount-time hooks; stub them so
// the component renders in isolation without a real client.
vi.mock("@/features/campaigns/api", () => ({
  useRetryMessage: () => ({ isPending: false, mutateAsync: retryMutate }),
  useRedispatchMessage: () => ({ isPending: false, mutateAsync: redispatchMutate }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { EventDetail } from "./event-detail";
import type { CampaignMessage } from "@/features/campaigns/schemas";

function baseMessage(over: Partial<CampaignMessage> = {}): CampaignMessage {
  return {
    id: "m1",
    campaignId: "c1",
    contactId: "ct1",
    providerMessageId: null,
    status: "SENT",
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

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

describe("EventDetail rendered variables", () => {
  it("renders each variable entry when 'Ver mensagem' is opened", () => {
    wrap(
      <EventDetail
        campaignId="c1"
        message={baseMessage({ variables: { nome: "Maria", cidade: "Manaus" } })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ver mensagem/i }));
    expect(screen.getByText(/\{\{nome\}\} → Maria/)).toBeInTheDocument();
    expect(screen.getByText(/\{\{cidade\}\} → Manaus/)).toBeInTheDocument();
  });

  it("shows the empty-state and does not crash when variables is missing at runtime", () => {
    // The schema types `variables` as a required Record, but responses are cast
    // (not validated) so it can be undefined in production. The component must
    // null-guard consistently — once — so the renderer never dereferences it.
    const msg = baseMessage();
    // simulate the un-validated API response
    (msg as { variables?: unknown }).variables = undefined;

    wrap(<EventDetail campaignId="c1" message={msg} />);
    fireEvent.click(screen.getByRole("button", { name: /ver mensagem/i }));
    expect(
      screen.getByText(/sem variáveis renderizadas/i),
    ).toBeInTheDocument();
  });

  it("renders the contact name, phone and city in the header", () => {
    wrap(
      <EventDetail
        campaignId="c1"
        message={baseMessage({
          contact: {
            id: "ct1",
            name: "Maria",
            phoneE164: "+5592999",
            optedOut: false,
            city: "Manaus",
            tags: ["vip", "norte"],
            profilePictureUrl: null,
          },
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Maria" })).toBeInTheDocument();
    expect(screen.getByText("+5592999")).toBeInTheDocument();
    expect(screen.getByText("Manaus")).toBeInTheDocument();
    expect(screen.getByText("vip")).toBeInTheDocument();
    expect(screen.getByText("norte")).toBeInTheDocument();
  });

  it("falls back to '(sem nome)' when the contact has no name", () => {
    wrap(
      <EventDetail
        campaignId="c1"
        message={baseMessage({
          contact: {
            id: "ct1",
            name: null,
            phoneE164: "+5592999",
            optedOut: false,
            city: null,
            tags: [],
            profilePictureUrl: null,
          },
        })}
      />,
    );
    expect(screen.getByText("(sem nome)")).toBeInTheDocument();
  });

  it("renders the avatar image when profilePictureUrl is present", () => {
    const { container } = wrap(
      <EventDetail
        campaignId="c1"
        message={baseMessage({
          contact: {
            id: "ct1",
            name: "Maria",
            phoneE164: "+5592999",
            optedOut: false,
            city: null,
            tags: [],
            profilePictureUrl: "https://x/pic.jpg",
          },
        })}
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://x/pic.jpg");
    expect(img).toHaveAttribute("referrerPolicy", "no-referrer");
  });

  it("renders initials fallback when no avatar and a name is present", () => {
    const { container } = wrap(
      <EventDetail
        campaignId="c1"
        message={baseMessage({
          contact: {
            id: "ct1",
            name: "Maria Silva",
            phoneE164: "+5592999",
            optedOut: false,
            city: null,
            tags: [],
            profilePictureUrl: null,
          },
        })}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    // initials("Maria Silva") -> "MS"
    expect(screen.getByText("MS")).toBeInTheDocument();
  });

  it("uses the last 2 phone digits when initials resolve to '?'", () => {
    wrap(
      <EventDetail
        campaignId="c1"
        message={baseMessage({
          contact: {
            id: "ct1",
            name: null,
            phoneE164: "+559299912",
            optedOut: false,
            city: null,
            tags: [],
            profilePictureUrl: null,
          },
        })}
      />,
    );
    expect(screen.getByText("12")).toBeInTheDocument();
  });
});

describe("EventDetail action handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the Reenviar button only when the message FAILED", () => {
    const { unmount } = wrap(
      <EventDetail campaignId="c1" message={baseMessage({ status: "SENT" })} />,
    );
    expect(
      screen.queryByRole("button", { name: /reenviar/i }),
    ).not.toBeInTheDocument();
    unmount();

    wrap(
      <EventDetail campaignId="c1" message={baseMessage({ status: "FAILED" })} />,
    );
    expect(
      screen.getByRole("button", { name: /reenviar/i }),
    ).toBeInTheDocument();
  });

  it("retry success: calls mutateAsync with the message id and toasts success", async () => {
    retryMutate.mockResolvedValueOnce(undefined);
    wrap(
      <EventDetail
        campaignId="c1"
        message={baseMessage({ id: "m9", status: "FAILED" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reenviar/i }));
    await waitFor(() => {
      expect(retryMutate).toHaveBeenCalledWith("m9");
      expect(toast.success).toHaveBeenCalledWith("Mensagem reenfileirada");
    });
  });

  it("retry failure: toasts the failure message", async () => {
    retryMutate.mockRejectedValueOnce(new Error("nope"));
    wrap(
      <EventDetail campaignId="c1" message={baseMessage({ status: "FAILED" })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reenviar/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Falha ao reenviar"),
    );
  });

  it("redispatch success: calls mutateAsync and toasts success", async () => {
    redispatchMutate.mockResolvedValueOnce(undefined);
    wrap(
      <EventDetail
        campaignId="c1"
        message={baseMessage({ id: "m7", status: "SENT" })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /disparar novamente/i }),
    );
    await waitFor(() => {
      expect(redispatchMutate).toHaveBeenCalledWith("m7");
      expect(toast.success).toHaveBeenCalledWith("Disparada nova mensagem");
    });
  });

  it("redispatch failure: toasts the failure message", async () => {
    redispatchMutate.mockRejectedValueOnce(new Error("nope"));
    wrap(
      <EventDetail campaignId="c1" message={baseMessage({ status: "SENT" })} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /disparar novamente/i }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Falha ao disparar"),
    );
  });
});

describe("EventDetail empty state", () => {
  it("prompts to select a recipient when message is null", () => {
    wrap(<EventDetail campaignId="c1" message={null} />);
    expect(
      screen.getByText(/selecione um destinatário à esquerda/i),
    ).toBeInTheDocument();
  });
});

describe("EventDetail variable re-read", () => {
  it("reads message.variables once in the render that paints the body", () => {
    // Guards against the duplicated null-guard: the original code evaluated
    // `Object.entries(message.variables ?? {})` for the empty check AND
    // `Object.entries(message.variables)` for the map in the SAME render — two
    // reads. Computing `entries` once means a single access in the body-render.
    const msg = baseMessage({ variables: { nome: "Maria" } });
    let reads = 0;
    const stored = msg.variables;
    Object.defineProperty(msg, "variables", {
      configurable: true,
      get() {
        reads += 1;
        return stored;
      },
    });

    wrap(<EventDetail campaignId="c1" message={msg} />);
    // Isolate the single re-render that opens (paints) the body.
    const before = reads;
    fireEvent.click(screen.getByRole("button", { name: /ver mensagem/i }));
    expect(screen.getByText(/\{\{nome\}\} → Maria/)).toBeInTheDocument();
    // That one render must read the property exactly once, not twice.
    expect(reads - before).toBe(1);
  });
});
