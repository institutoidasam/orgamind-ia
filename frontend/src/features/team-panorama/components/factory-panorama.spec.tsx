import { focusManager } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api: { get } }));
vi.mock("@tanstack/react-router", () => import("../panorama.test-router"));

import { todayInManaus } from "@/features/people-record/authorization";
import { addDays, formatDayMonth } from "@/lib/civil-date";
import {
  asRole,
  failWith,
  httpError,
  jsonOf,
  PANORAMA_URL,
  renderWithClient,
} from "../panorama.test-helpers";
import { memberOf, panoramaOf, rosterOf } from "../panorama.test-fixtures";
import { FactoryPanorama } from "./factory-panorama";

const ROSTER_URL = "internal/team-whatsapp/roster";

beforeEach(() => {
  get.mockReset();
  get.mockReturnValue(jsonOf(panoramaOf()));
});

describe("FactoryPanorama: cartão aberto não atravessa a troca de data", () => {
  it("aceite 5: com Ver pessoas aberto, voltar a uma data em cache fecha a lista e não busca o roster dessa data sem clique", async () => {
    const today = todayInManaus();
    const other = addDays(today, -3);
    get.mockImplementation((url, { searchParams }) =>
      url === ROSTER_URL
        ? jsonOf(rosterOf([memberOf("u1", "Ana")]))
        : jsonOf(panoramaOf({ date: searchParams.date })),
    );
    asRole("ADMIN");
    renderWithClient(<FactoryPanorama />);
    await screen.findAllByText(`Em serviço em ${formatDayMonth(today)}`);
    fireEvent.change(screen.getByLabelText("Data"), {
      target: { value: other },
    });
    await screen.findAllByText(`Em serviço em ${formatDayMonth(other)}`);
    fireEvent.click(screen.getAllByRole("button", { name: "Ver pessoas" })[0]!);
    await screen.findByRole("button", { name: "Fechar" });
    fireEvent.change(screen.getByLabelText("Data"), {
      target: { value: today },
    });
    await screen.findAllByText(`Em serviço em ${formatDayMonth(today)}`);
    expect(screen.queryByRole("button", { name: "Fechar" })).toBeNull();
    const rosterDates = get.mock.calls
      .filter(([url]) => url === ROSTER_URL)
      .map(([, options]) => options.searchParams.date);
    expect(rosterDates).toEqual([other]);
  });
});

describe("FactoryPanorama: quem vê o bloco", () => {
  it("aceite 1: ADMIN vê Operação da fábrica, Panorama de todos os setores, o aviso fixo e um cartão por setor na ordem da resposta", async () => {
    asRole("ADMIN");
    renderWithClient(<FactoryPanorama />);
    expect(
      await screen.findByRole("heading", { name: "Operação da fábrica" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Panorama de todos os setores"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/As contagens vêm da escala do dia, não da hora\./),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("group")
        .map((card) => card.getAttribute("aria-label")),
    ).toEqual(["Compras", "Logística"]);
    expect(get).toHaveBeenCalledWith(PANORAMA_URL, {
      searchParams: { date: todayInManaus() },
    });
  });

  it("aceite 2: VIEWER — sem bloco e nenhuma chamada a internal/team-whatsapp/panorama", () => {
    asRole("VIEWER");
    const { container } = renderWithClient(<FactoryPanorama />);
    expect(container).toBeEmptyDOMElement();
    expect(get).not.toHaveBeenCalled();
  });

  it("aceite 2: SUPERVISOR — Panorama dos seus setores", async () => {
    asRole("SUPERVISOR");
    renderWithClient(<FactoryPanorama />);
    expect(
      await screen.findByText("Panorama dos seus setores"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Panorama de todos os setores")).toBeNull();
  });
});

describe("FactoryPanorama: recusa e falha", () => {
  it("aceite 2: 403 team_whatsapp.forbidden — o queryFn devolve null: nenhum bloco, nenhum texto de erro (nem por um instante) e sem botão Tentar de novo", async () => {
    let refuse: () => void = () => undefined;
    const pending = new Promise((_, reject) => {
      refuse = () => reject(httpError(403, "team_whatsapp.forbidden"));
    });
    get.mockReturnValue({ json: () => pending });
    asRole("SUPERVISOR");
    const { container, client } = renderWithClient(<FactoryPanorama />);
    expect(container).not.toHaveTextContent(/\S/);
    refuse();
    await waitFor(() =>
      expect(client.getQueryCache().getAll()[0]?.state.status).toBe("success"),
    );
    expect(client.getQueryCache().getAll()[0]?.state.data).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    [403, "auth.permission_denied"],
    [500, "internal"],
  ])(
    "%i com code %s — Não foi possível carregar o panorama e Tentar de novo",
    async (status, code) => {
      get.mockReturnValue(failWith(status, code));
      asRole("SUPERVISOR");
      renderWithClient(<FactoryPanorama />);
      expect(
        await screen.findByText("Não foi possível carregar o panorama"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Tentar de novo" }),
      ).toBeInTheDocument();
    },
  );
});

describe("FactoryPanorama: data escolhida", () => {
  it("aceite 5: trocar a data faz nova chamada com a data; foco da janela não faz", async () => {
    get.mockImplementation((_url, { searchParams }) =>
      jsonOf(panoramaOf({ date: searchParams.date })),
    );
    asRole("ADMIN");
    renderWithClient(<FactoryPanorama />);
    const other = addDays(todayInManaus(), -3);
    fireEvent.change(await screen.findByLabelText("Data"), {
      target: { value: other },
    });
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(PANORAMA_URL, {
        searchParams: { date: other },
      }),
    );
    expect(
      await screen.findAllByText(`Em serviço em ${formatDayMonth(other)}`),
    ).toHaveLength(2);
    const calls = get.mock.calls.length;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    expect(get).toHaveBeenCalledTimes(calls);
  });
});

describe("FactoryPanorama: turno da véspera em andamento", () => {
  const today = todayInManaus();
  const yesterday = addDays(today, -1);
  const night = {
    id: "sh-n",
    name: "Noite",
    startTime: "22:00",
    endTime: "06:00",
  };
  const running = panoramaOf({
    date: today,
    today,
    inProgress: { date: yesterday, shift: night },
  });

  it("aceite 8: com inProgress e a data de hoje, atalho Ver dd/MM troca a data para a de ontem", async () => {
    get.mockReturnValue(jsonOf(running));
    asRole("ADMIN");
    renderWithClient(<FactoryPanorama />);
    expect(
      await screen.findByText(
        "O turno Noite de ontem ainda está em andamento.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: `Ver ${formatDayMonth(yesterday)}` }),
    );
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(PANORAMA_URL, {
        searchParams: { date: yesterday },
      }),
    );
    expect(screen.getByLabelText("Data")).toHaveValue(yesterday);
  });

  it("aceite 8: com outra data, sem atalho", async () => {
    get.mockReturnValue(jsonOf(running));
    asRole("ADMIN");
    renderWithClient(<FactoryPanorama />);
    expect(
      await screen.findByText(/ainda está em andamento/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Data"), {
      target: { value: yesterday },
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await screen.findAllByText(/Em serviço em/);
    expect(screen.queryByText(/ainda está em andamento/)).toBeNull();
  });
});
