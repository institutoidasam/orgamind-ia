import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SegmentInfoBlock } from "./segment-info-block";

describe("SegmentInfoBlock", () => {
  it("renders the title about segments", () => {
    render(<SegmentInfoBlock />);
    expect(screen.getByText(/O que é um segmento/)).toBeInTheDocument();
  });

  it("renders an explanation about segments", () => {
    render(<SegmentInfoBlock />);
    expect(
      screen.getByText(/Um segmento é um público que você salva com filtros/),
    ).toBeInTheDocument();
  });

  it("includes a concrete example", () => {
    render(<SegmentInfoBlock />);
    expect(
      screen.getByText(/Mulheres de Manaus do grupo Apoiadores/),
    ).toBeInTheDocument();
  });

  it("renders usage instructions", () => {
    render(<SegmentInfoBlock />);
    expect(screen.getByText(/Como usar/)).toBeInTheDocument();
    expect(screen.getByText(/Configure os filtros de contatos/)).toBeInTheDocument();
    expect(
      screen.getByText(/Salve com um nome que identifique o público/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Ao criar campanha, escolha em "Carregar de um segmento"/),
    ).toBeInTheDocument();
  });

  it("has an info icon for visual context", () => {
    const { container } = render(<SegmentInfoBlock />);
    const icon = container.querySelector("svg");
    expect(icon).toBeInTheDocument();
  });
});
