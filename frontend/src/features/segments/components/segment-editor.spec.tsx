import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SegmentEditor } from "./segment-editor";

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

describe("SegmentEditor", () => {
  it("renders name + description inputs and the filter-builder", () => {
    wrap(<SegmentEditor onSubmit={() => {}} submitting={false} />);
    expect(screen.getByLabelText(/nome/i)).toBeInTheDocument();
    // The reused FilterBuilder exposes an "Adicionar Regra" button
    expect(
      screen.getByRole("button", { name: /Regra/i }),
    ).toBeInTheDocument();
  });

  it("calls onSubmit with the typed name and current filters", () => {
    const onSubmit = vi.fn();
    wrap(<SegmentEditor onSubmit={onSubmit} submitting={false} />);

    fireEvent.change(screen.getByLabelText(/nome/i), {
      target: { value: "Novo segmento" },
    });
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.name).toBe("Novo segmento");
    expect(arg.filters).toEqual({ combinator: "and", rules: [] });
  });

  it("disables submit while submitting", () => {
    wrap(<SegmentEditor onSubmit={() => {}} submitting={true} />);
    expect(screen.getByRole("button", { name: /salvando/i })).toBeDisabled();
  });

  it("pre-fills from an initial segment (edit mode)", () => {
    wrap(
      <SegmentEditor
        onSubmit={() => {}}
        submitting={false}
        initial={{
          name: "Existente",
          description: "desc",
          filters: { combinator: "and", rules: [] },
        }}
      />,
    );
    expect(screen.getByLabelText(/nome/i)).toHaveValue("Existente");
  });

  it("sends description: null when an existing description is cleared", () => {
    const onSubmit = vi.fn();
    wrap(
      <SegmentEditor
        onSubmit={onSubmit}
        submitting={false}
        initial={{
          name: "Existente",
          description: "desc antiga",
          filters: { combinator: "and", rules: [] },
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText(/descrição/i), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // `undefined` is a no-op on a PATCH; `null` is what actually clears it.
    expect(onSubmit.mock.calls[0][0].description).toBeNull();
  });

  it("sends the typed description string when set", () => {
    const onSubmit = vi.fn();
    wrap(<SegmentEditor onSubmit={onSubmit} submitting={false} />);

    fireEvent.change(screen.getByLabelText(/nome/i), {
      target: { value: "Seg" },
    });
    fireEvent.change(screen.getByLabelText(/descrição/i), {
      target: { value: "minha desc" },
    });
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));

    expect(onSubmit.mock.calls[0][0].description).toBe("minha desc");
  });

  it("omits description (undefined) when creating with an empty description", () => {
    const onSubmit = vi.fn();
    wrap(<SegmentEditor onSubmit={onSubmit} submitting={false} />);

    fireEvent.change(screen.getByLabelText(/nome/i), {
      target: { value: "Seg" },
    });
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));

    // No prior description existed, so there's nothing to clear → undefined.
    expect(onSubmit.mock.calls[0][0].description).toBeUndefined();
  });
});
