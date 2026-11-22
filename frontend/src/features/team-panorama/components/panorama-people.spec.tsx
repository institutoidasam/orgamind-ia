import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api: { get } }));
vi.mock("@tanstack/react-router", () => import("../panorama.test-router"));

import {
  asRole,
  failWith,
  jsonOf,
  renderWithClient,
} from "../panorama.test-helpers";
import {
  memberOf,
  rosterOf,
  SHIFTS,
  sectorOf,
} from "../panorama.test-fixtures";
import { PanoramaCard } from "./panorama-card";

const ROSTER_URL = "internal/team-whatsapp/roster";
const off = (reason: "DAY_OFF" | "VACATION") =>
  ({ kind: "OFF", reason, source: "CYCLE" }) as const;

const people = [
  memberOf("u1", "Ana", { phoneE164: "+5592991110001" }),
  memberOf("u2", "Bruno", {
    situation: {
      kind: "WORK",
      sectorId: "s1",
      shiftId: "sh-x",
      source: "CYCLE",
    },
  }),
  memberOf("u3", "Carla", { situation: off("DAY_OFF") }),
  memberOf("u4", "Davi", { situation: off("VACATION") }),
  memberOf("u5", "Eva", {
    situation: { kind: "NONE" },
    phoneMasked: null,
  }),
];

function openCard(sector = sectorOf()) {
  asRole("ADMIN");
  renderWithClient(
    <PanoramaCard sector={sector} shifts={SHIFTS} date="2026-11-21" />,
  );
}

beforeEach(() => {
  get.mockReset();
  get.mockReturnValue(jsonOf(rosterOf(people)));
});

describe("PanoramaCard: Ver pessoas busca só no clique", () => {
  it("aceite 5: nenhuma chamada ao roster antes do clique; Ver pessoas busca roster?sectorIds=<id>&date=<data>", async () => {
    openCard();
    expect(get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ver pessoas" }));
    expect(await screen.findByText(/^Ana · /)).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(ROSTER_URL, {
      searchParams: { sectorIds: "s1", date: "2026-11-21" },
    });
  });

  it("aceite 5: Fechar e Ver pessoas de novo — uma chamada só", async () => {
    openCard();
    fireEvent.click(screen.getByRole("button", { name: "Ver pessoas" }));
    const ana = await screen.findByText(/^Ana · /);
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(ana).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ver pessoas" }));
    expect(ana).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("aceite 3: cartão overLimit sem Ver pessoas", () => {
    openCard(sectorOf({ overLimit: true, counts: null }));
    expect(screen.queryByRole("button", { name: "Ver pessoas" })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("PanoramaCard: lista de pessoas", () => {
  it("aceite 5: nomes por turno, Outros turnos, Folga, Férias e Sem escala; telefone mascarado quando a resposta só traz phoneMasked", async () => {
    openCard();
    fireEvent.click(screen.getByRole("button", { name: "Ver pessoas" }));
    await screen.findByText(/^Ana · /);
    const group = (name: string) =>
      within(screen.getByRole("region", { name }));
    expect(
      group("Manhã (06:00–14:00)").getByText("Ana · (92) 99111-0001"),
    ).toBeInTheDocument();
    expect(
      group("Outros turnos").getByText("Bruno · •••• 0001"),
    ).toBeInTheDocument();
    expect(group("Folga").getByText("Carla · •••• 0001")).toBeInTheDocument();
    expect(group("Férias").getByText("Davi · •••• 0001")).toBeInTheDocument();
    expect(group("Sem escala").getByText("Eva · —")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Noite/ })).toBeNull();
  });

  it("erro do roster — Não foi possível carregar as pessoas e Tentar de novo", async () => {
    get.mockReturnValueOnce(failWith(500, "internal"));
    openCard();
    fireEvent.click(screen.getByRole("button", { name: "Ver pessoas" }));
    expect(
      await screen.findByText("Não foi possível carregar as pessoas"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/^Ana · /)).toBeInTheDocument();
  });
});
