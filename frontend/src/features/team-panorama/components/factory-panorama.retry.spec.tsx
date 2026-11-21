import { fireEvent, screen, waitFor } from "@testing-library/react";
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
import { panoramaOf } from "../panorama.test-fixtures";
import { FactoryPanorama } from "./factory-panorama";

/** Resposta que só chega quando o teste manda. */
function deferred() {
  let settle: (response: { json: () => Promise<unknown> }) => void = () => {};
  const response = new Promise<{ json: () => Promise<unknown> }>((resolve) => {
    settle = resolve;
  });
  return { response, settle };
}

async function failFirst() {
  get.mockReturnValueOnce(failWith(500, "internal"));
  asRole("ADMIN");
  const view = renderWithClient(<FactoryPanorama />);
  await screen.findByText("Não foi possível carregar o panorama");
  return view;
}

beforeEach(() => {
  get.mockReset();
});

describe("FactoryPanorama: depois do primeiro erro a seção não some", () => {
  it("Tentar de novo mantém o título e o seletor de data com Carregando panorama…, até a resposta chegar", async () => {
    const retry = deferred();
    await failFirst();
    get.mockReturnValueOnce({
      json: () => retry.response.then((r) => r.json()),
    });
    const dateInput = screen.getByLabelText("Data");
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Carregando panorama…")).toBeInTheDocument();
    expect(screen.getByLabelText("Data")).toBe(dateInput);
    expect(dateInput).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Operação da fábrica" }),
    ).toBeInTheDocument();
    retry.settle(jsonOf(panoramaOf()));
    expect(await screen.findAllByRole("group")).toHaveLength(2);
  });

  it("trocar a data depois do erro mantém o seletor montado e carrega o panorama da nova data", async () => {
    get.mockImplementation(() => jsonOf(panoramaOf({ date: "2026-11-15" })));
    await failFirst();
    const dateInput = screen.getByLabelText("Data");
    fireEvent.change(dateInput, { target: { value: "2026-11-15" } });
    expect(screen.getByLabelText("Data")).toBe(dateInput);
    expect(await screen.findAllByText("Em serviço em 15/11")).toHaveLength(2);
  });

  it("a recusa 403 team_whatsapp.forbidden depois do erro continua sumindo sem texto", async () => {
    const { container } = await failFirst();
    get.mockReturnValue(failWith(403, "team_whatsapp.forbidden"));
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
