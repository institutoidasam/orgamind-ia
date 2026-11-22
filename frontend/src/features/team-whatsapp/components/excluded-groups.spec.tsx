import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TeamExcludedPerson } from "../schemas";
import { ExcludedGroups } from "./excluded-groups";

const person = (
  name: string,
  reason: TeamExcludedPerson["reason"],
  extra: Partial<TeamExcludedPerson> = {},
): TeamExcludedPerson => ({
  userId: `u-${name}`,
  name,
  sectorId: "s1",
  sectorName: "Logística",
  shiftName: "Manhã",
  levelName: null,
  reason,
  ...extra,
});
const lines = (title: string) =>
  within(screen.getByRole("list", { name: title }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("ExcludedGroups: grupos", () => {
  it("agrupa por motivo na ordem da lista, com Férias e Folga separados e a contagem de cada grupo", () => {
    render(
      <ExcludedGroups
        excluded={[
          person("Duda", "vacation"),
          person("Caio", "day_off", { levelName: "Líder" }),
          person("Ana", "not_selected"),
          person("Eli", "day_off", { shiftName: null }),
          person("Fê", "other_shift", { sectorName: "Operação" }),
        ]}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Ficaram de fora (5)" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual([
      "Não selecionado (1)",
      "Folga (2)",
      "Férias (1)",
      "Fora do turno nesta data (1)",
    ]);
    expect(lines("Folga (2)")).toEqual([
      "Caio · Logística · Manhã · Líder",
      "Eli · Logística",
    ]);
    expect(lines("Férias (1)")).toEqual(["Duda · Logística · Manhã"]);
    expect(lines("Fora do turno nesta data (1)")).toEqual([
      "Fê · Operação · Manhã",
    ]);
  });
});

describe("ExcludedGroups: vazio e homônimos", () => {
  it("sem excluídos não mostra nada; homônimos viram duas linhas sem chave repetida; título é opcional", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { container, rerender } = render(<ExcludedGroups excluded={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <ExcludedGroups
        title="Ficam de fora"
        excluded={[person("Ana", "day_off"), person("Ana", "day_off")]}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Ficam de fora (2)" }),
    ).toBeInTheDocument();
    expect(lines("Folga (2)")).toEqual([
      "Ana · Logística · Manhã",
      "Ana · Logística · Manhã",
    ]);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
