import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getMock = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
}));

import { SegmentPreviewPanel } from "./segment-preview-panel";

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

describe("SegmentPreviewPanel", () => {
  it("calls the preview API for the given segment and renders count + sample", async () => {
    getMock.mockReturnValue({
      json: () =>
        Promise.resolve({
          count: 3,
          sample: [
            { id: "c1", name: "Maria", phoneE164: "+5592999" },
            { id: "c2", name: "João", phoneE164: "+5592888" },
          ],
        }),
    });

    wrap(<SegmentPreviewPanel segmentId="s1" />);

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("segments/s1/preview"));
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(await screen.findByText("Maria")).toBeInTheDocument();
    expect(screen.getByText("+5592999")).toBeInTheDocument();
  });
});
