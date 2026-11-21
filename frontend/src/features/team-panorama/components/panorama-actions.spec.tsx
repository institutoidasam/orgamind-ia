import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => import("../panorama.test-router"));

import { asRole } from "../panorama.test-helpers";
import { PanoramaActions, PanoramaMultiSend } from "./panorama-actions";

const DATE = "2026-11-21";
const link = (name: string) => screen.getByRole("link", { name });
const noLink = (name: string) => screen.queryByRole("link", { name });

beforeEach(() => asRole("ADMIN"));

describe("PanoramaActions: ações do cartão", () => {
  it("aceite 6: Ver escala e Enviar mensagem apontam para /escala e /whatsapp-equipe com setor e data", () => {
    render(<PanoramaActions sectorId="s1" date={DATE} />);
    expect(link("Ver escala")).toHaveAttribute(
      "href",
      "/escala?sectorId=s1&date=2026-11-21",
    );
    expect(link("Enviar mensagem")).toHaveAttribute(
      "href",
      "/whatsapp-equipe?sectorIds=s1&date=2026-11-21",
    );
  });

  it("aceite 7: sem equipe.enviar — nem Enviar mensagem nem vários setores; Ver escala continua", () => {
    asRole("SUPERVISOR", ["escala.alterar"]);
    render(
      <>
        <PanoramaActions sectorId="s1" date={DATE} />
        <PanoramaMultiSend sectorCount={3} date={DATE} />
      </>,
    );
    expect(link("Ver escala")).toBeInTheDocument();
    expect(noLink("Enviar mensagem")).toBeNull();
    expect(noLink("Mensagem para vários setores")).toBeNull();
  });
});

describe("PanoramaMultiSend: mensagem para vários setores", () => {
  it("aceite 7: Mensagem para vários setores só com 2 ou mais setores e equipe.enviar; aponta para /whatsapp-equipe só com a data", () => {
    const { rerender } = render(
      <PanoramaMultiSend sectorCount={1} date={DATE} />,
    );
    expect(noLink("Mensagem para vários setores")).toBeNull();
    rerender(<PanoramaMultiSend sectorCount={2} date={DATE} />);
    expect(link("Mensagem para vários setores")).toHaveAttribute(
      "href",
      "/whatsapp-equipe?date=2026-11-21",
    );
  });
});
