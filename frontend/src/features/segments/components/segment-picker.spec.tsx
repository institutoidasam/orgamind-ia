import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getMock = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
}));

import { SegmentPicker } from "./segment-picker";

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

describe("SegmentPicker", () => {
  it("fetches segments and lists them as options", async () => {
    getMock.mockReturnValue({
      json: () =>
        Promise.resolve([
          {
            id: "s1",
            name: "VIP",
            description: null,
            lastCount: 10,
            lastCountedAt: null,
            createdAt: "2026-06-01T00:00:00Z",
          },
          {
            id: "s2",
            name: "Alunos",
            description: null,
            lastCount: null,
            lastCountedAt: null,
            createdAt: "2026-06-02T00:00:00Z",
          },
        ]),
    });

    wrap(<SegmentPicker value={undefined} onChange={() => {}} />);

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("segments"));
    // The native select renders both segment names as options.
    expect(await screen.findByRole("option", { name: "VIP" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Alunos" })).toBeInTheDocument();
  });
});
