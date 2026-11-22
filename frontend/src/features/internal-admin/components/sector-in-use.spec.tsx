import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SectorUsage } from "../schemas";
import { SectorInUse } from "./sector-in-use";

const USAGE: SectorUsage = {
  people: 0,
  exceptions: 0,
  scheduled: 0,
  inactivePeople: 0,
};

describe("SectorInUse", () => {
  it("em uso: título, contagens e o que fazer para liberar", () => {
    render(
      <SectorInUse
        usage={{ ...USAGE, people: 2, scheduled: 1, inactivePeople: 3 }}
      />,
    );
    expect(screen.getByText("Em uso: não pode ser inativado")).toBeTruthy();
    expect(screen.getByText("2 pessoa(s) ativa(s) neste setor")).toBeTruthy();
    expect(screen.getByText("1 envio(s) agendado(s)")).toBeTruthy();
    expect(screen.getByText("Para liberar:")).toBeTruthy();
    expect(screen.getByText(/Traga as pessoas para outro setor/)).toBeTruthy();
    expect(
      screen.getByText("Cancele ou aguarde os envios agendados."),
    ).toBeTruthy();
    expect(screen.queryByText(/Remova as exceções/)).toBeNull();
    expect(
      screen.getByText("3 pessoa(s) inativa(s) mantêm o vínculo"),
    ).toBeTruthy();
  });

  it("sem uso mostra só a informação das inativas; sem nada, não mostra nada", () => {
    const { container, rerender } = render(
      <SectorInUse usage={{ ...USAGE, inactivePeople: 1 }} />,
    );
    expect(
      screen.getByText("1 pessoa(s) inativa(s) mantêm o vínculo"),
    ).toBeTruthy();
    expect(screen.queryByText("Em uso: não pode ser inativado")).toBeNull();
    rerender(<SectorInUse usage={USAGE} />);
    expect(container.innerHTML).toBe("");
    rerender(<SectorInUse usage={null} />);
    expect(container.innerHTML).toBe("");
  });
});
