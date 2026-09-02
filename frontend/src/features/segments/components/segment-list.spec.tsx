import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SegmentList } from "./segment-list";
import type { SegmentSummary } from "../schemas";

const segments: SegmentSummary[] = [
  {
    id: "s1",
    name: "VIP de Manaus",
    description: "Clientes premium",
    lastCount: 42,
    lastCountedAt: "2026-06-10T00:00:00Z",
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
];

describe("SegmentList", () => {
  it("renders each segment name", () => {
    render(
      <SegmentList segments={segments} onSelect={() => {}} onDelete={() => {}} />,
    );
    expect(screen.getByText("VIP de Manaus")).toBeInTheDocument();
    expect(screen.getByText("Alunos")).toBeInTheDocument();
  });

  it("shows the cached lastCount when present", () => {
    render(
      <SegmentList segments={segments} onSelect={() => {}} onDelete={() => {}} />,
    );
    expect(screen.getByText(/42/)).toBeInTheDocument();
  });

  it("renders an empty state when there are no segments", () => {
    render(<SegmentList segments={[]} onSelect={() => {}} onDelete={() => {}} />);
    expect(screen.getByText(/nenhum segmento/i)).toBeInTheDocument();
  });

  it("renders info block when there are segments", () => {
    render(
      <SegmentList segments={segments} onSelect={() => {}} onDelete={() => {}} />,
    );
    expect(screen.getByText(/O que é um segmento/)).toBeInTheDocument();
  });

  it("renders info block in empty state", () => {
    render(<SegmentList segments={[]} onSelect={() => {}} onDelete={() => {}} />);
    expect(screen.getByText(/O que é um segmento/)).toBeInTheDocument();
  });
});
