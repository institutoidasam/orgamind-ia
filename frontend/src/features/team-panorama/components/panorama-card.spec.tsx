import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => import("../panorama.test-router"));

import { countsOf, SHIFTS, sectorOf } from "../panorama.test-fixtures";
import { PanoramaCard } from "./panorama-card";

const card = (sector = sectorOf()) => {
  render(<PanoramaCard sector={sector} shifts={SHIFTS} date="2026-11-21" />);
  return within(screen.getByRole("group", { name: "Compras" }));
};

describe("PanoramaCard: contagens do setor", () => {
  it("aceite 4: cartão com linhas de turno, Outros turnos, Folga, Férias, Sem escala, Sem telefone e Sem autorização de contato", () => {
    const view = card(
      sectorOf({
        counts: countsOf({
          otherShifts: 2,
          vacation: 4,
          noPhone: 1,
          notAuthorized: 2,
        }),
      }),
    );
    for (const text of [
      "Em serviço em 21/11",
      "Manhã (06:00–14:00): 3",
      "Noite (22:00–06:00): 0",
      "Outros turnos: 2",
      "Folga: 1",
      "Férias: 4",
      "Sem escala: 5",
      "Sem telefone: 1",
      "Sem autorização de contato: 2",
    ]) {
      expect(view.getByText(text)).toBeInTheDocument();
    }
  });

  it("aceite 4: setor zerado — Ninguém na escala deste dia", () => {
    const empty = countsOf({ byShift: [], dayOff: 0, noSchedule: 0 });
    const view = card(sectorOf({ counts: empty }));
    expect(view.getByText("Ninguém na escala deste dia")).toBeInTheDocument();
    expect(view.queryByText(/Em serviço/)).toBeNull();
  });
});

describe("PanoramaCard: setor grande", () => {
  it("aceite 3: overLimit — Setor com mais de 2000 pessoas: veja na Escala, sem contagens", () => {
    const view = card(sectorOf({ overLimit: true, counts: null }));
    expect(
      view.getByText("Setor com mais de 2000 pessoas: veja na Escala"),
    ).toBeInTheDocument();
    expect(view.queryByText(/Folga/)).toBeNull();
  });
});
