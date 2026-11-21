import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PENDENCY_FILTERS, type PendencyFilters } from "../api";
import { PendencyFiltersBar } from "./pendency-filters";

const SECTORS = [
  { id: "s1", name: "Setor 1" },
  { id: "s2", name: "Setor 2" },
];

function renderBar(overrides: Partial<PendencyFilters> = {}) {
  const onChange = vi.fn();
  render(
    <PendencyFiltersBar
      filters={{ ...DEFAULT_PENDENCY_FILTERS, ...overrides }}
      sectors={SECTORS}
      onChange={onChange}
    />,
  );
  return onChange;
}

const box = (name: string) => screen.getByRole("checkbox", { name });

describe("PendencyFiltersBar: situação", () => {
  it("padrão — Sem responsável, Em tratativa e Em tratativa — atrasada marcadas", () => {
    renderBar();
    for (const name of [
      "Sem responsável",
      "Em tratativa",
      "Em tratativa — atrasada",
    ])
      expect(box(name)).toBeChecked();
    for (const name of ["Ciente", "Encerrada sem ciência"])
      expect(box(name)).not.toBeChecked();
  });

  it("marcar e desmarcar uma situação troca a lista", () => {
    const onChange = renderBar();
    fireEvent.click(box("Ciente"));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_PENDENCY_FILTERS,
      situations: ["UNASSIGNED", "IN_PROGRESS", "OVERDUE", "ACKED"],
    });
    fireEvent.click(box("Em tratativa"));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_PENDENCY_FILTERS,
      situations: ["UNASSIGNED", "OVERDUE"],
    });
  });

  it("com uma só situação marcada, a caixa dela fica desligada", () => {
    renderBar({ situations: ["CLOSED"] });
    expect(box("Encerrada sem ciência")).toBeDisabled();
    expect(box("Ciente")).toBeEnabled();
  });
});

describe("PendencyFiltersBar: período", () => {
  it("aceite 15: Período só aparece com Ciente ou Encerrada sem ciência e troca 7/30", () => {
    const { unmount } = render(
      <PendencyFiltersBar
        filters={DEFAULT_PENDENCY_FILTERS}
        sectors={SECTORS}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Período")).toBeNull();
    unmount();
    const onChange = renderBar({ situations: ["CLOSED"] });
    const period = screen.getByLabelText("Período");
    expect(period).toHaveValue("7");
    expect(
      screen.getByRole("option", { name: "Últimos 7 dias" }),
    ).toBeInTheDocument();
    fireEvent.change(period, { target: { value: "30" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ days: 30, page: 1 }),
    );
  });

  it("Período também aparece só com Ciente marcada", () => {
    renderBar({ situations: ["ACKED", "UNASSIGNED"] });
    expect(screen.getByLabelText("Período")).toBeInTheDocument();
  });
});

describe("PendencyFiltersBar: setor, minhas e página", () => {
  it("Setor lista Todos os setores e os setores da resposta; Minhas alterna", () => {
    const onChange = renderBar();
    const sector = screen.getByLabelText("Setor");
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Todos os setores", "Setor 1", "Setor 2"]);
    fireEvent.change(sector, { target: { value: "s2" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sectorId: "s2" }),
    );
    fireEvent.click(box("Minhas"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mine: true }),
    );
  });

  it("Todos os setores volta o filtro de setor a nulo", () => {
    const onChange = renderBar({ sectorId: "s1" });
    expect(screen.getByLabelText("Setor")).toHaveValue("s1");
    fireEvent.change(screen.getByLabelText("Setor"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sectorId: null }),
    );
  });

  it("trocar filtro volta à página 1", () => {
    const onChange = renderBar({ page: 3, situations: ["ACKED"] });
    fireEvent.click(box("Minhas"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mine: true, page: 1 }),
    );
    fireEvent.change(screen.getByLabelText("Setor"), {
      target: { value: "s1" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sectorId: "s1", page: 1 }),
    );
  });
});
