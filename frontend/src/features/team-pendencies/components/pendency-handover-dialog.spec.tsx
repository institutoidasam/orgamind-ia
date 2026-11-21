import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import type { TeamPendencyItem } from "../schemas";
import { pendencyItem } from "../pendency.test-fixtures";
import { PendencyHandoverDialog } from "./pendency-handover-dialog";
import { httpError, renderWithClient } from "./pendency.test-support";

const json = (value: unknown) => ({ json: () => Promise.resolve(value) });
const TARGETS = {
  items: [
    { id: "u2", name: "Ana" },
    { id: "u3", name: "Beto" },
  ],
};
const NOTE_HINT = "Vai para cada pendência como 'Passagem de turno: …'.";

/** Pendência "Em tratativa" da pessoa `name`, com alerta às 13:00Z (09:00 em Manaus). */
function mine(id: string, name: string): TeamPendencyItem {
  const base = pendencyItem();
  return pendencyItem({
    id,
    situation: "IN_PROGRESS",
    person: { ...base.person, name },
  });
}
const label = (name: string) =>
  `${name} · Alerta de 21/11 09:00 · Em tratativa`;

function mockApi(items: TeamPendencyItem[], total = items.length) {
  get.mockImplementation((url: string) =>
    json(
      url.endsWith("/targets")
        ? TARGETS
        : { items, total, page: 1, pageSize: 50, sectors: [] },
    ),
  );
}

function open(from = { id: "u-me", name: null as string | null, own: true }) {
  const onClose = vi.fn();
  renderWithClient(<PendencyHandoverDialog from={from} onClose={onClose} />);
  return onClose;
}

const pick = (id: string) =>
  fireEvent.change(screen.getByLabelText("Passar para"), {
    target: { value: id },
  });
const write = (text: string) =>
  fireEvent.change(screen.getByLabelText("Observação"), {
    target: { value: text },
  });
const confirm = () => screen.getByRole("button", { name: "Confirmar" });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe("PendencyHandoverDialog: puladas de mesmo texto", () => {
  it("duas puladas com o mesmo texto — as duas linhas, sem chave repetida", async () => {
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockApi([mine("r1", "Pessoa A"), mine("r2", "Pessoa A")]);
      post.mockReturnValue(
        json({
          transferred: [],
          skipped: [
            { id: "r1", reason: "acked" },
            { id: "r2", reason: "acked" },
          ],
        }),
      );
      open();
      await screen.findAllByRole("checkbox", { name: label("Pessoa A") });
      await screen.findByRole("option", { name: "Ana" });
      pick("u2");
      write("Fim do turno");
      fireEvent.click(confirm());
      await screen.findByText("Não foram passadas:");
      const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
      expect(lines).toEqual([
        `${label("Pessoa A")}: já ciente`,
        `${label("Pessoa A")}: já ciente`,
      ]);
      expect(erros.mock.calls.flat().join(" ")).not.toContain("same key");
    } finally {
      erros.mockRestore();
    }
  });
});

describe("PendencyHandoverDialog: destino que sumiu", () => {
  it("user.not_found — destinos recarregam e o select volta ao vazio, mesmo se o destino reaparecer", async () => {
    let targets = TARGETS;
    get.mockImplementation((url: string) =>
      json(
        url.endsWith("/targets")
          ? targets
          : {
              items: [mine("r1", "Pessoa A")],
              total: 1,
              page: 1,
              pageSize: 50,
            },
      ),
    );
    post.mockImplementation(() => {
      throw httpError({ code: "user.not_found" }, 404);
    });
    const { qc } = renderWithClient(
      <PendencyHandoverDialog
        from={{ id: "u-me", name: null, own: true }}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("checkbox", { name: label("Pessoa A") });
    await screen.findByRole("option", { name: "Ana" });
    pick("u2");
    write("Fim do turno");
    targets = { items: [{ id: "u3", name: "Beto" }] };
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: "Ana" }),
      ).not.toBeInTheDocument(),
    );
    const select = screen.getByLabelText("Passar para");
    expect(select).toHaveDisplayValue("Escolha um colega");
    expect(confirm()).toBeDisabled();
    targets = TARGETS;
    await qc.invalidateQueries({ queryKey: ["team-pendencies"] });
    await screen.findByRole("option", { name: "Ana" });
    expect(select).toHaveDisplayValue("Escolha um colega");
    expect(confirm()).toBeDisabled();
  });
});

describe("PendencyHandoverDialog: preenchimento", () => {
  it("aceite 28: todas marcadas, destino e observação obrigatórios, dica da Passagem de turno", async () => {
    mockApi([mine("r1", "Pessoa A"), mine("r2", "Pessoa B")]);
    post.mockReturnValue(json({ transferred: [{ id: "r1" }], skipped: [] }));
    const onClose = open();
    expect(
      screen.getByRole("heading", { name: "Passar minhas pendências" }),
    ).toBeInTheDocument();
    const first = await screen.findByRole("checkbox", {
      name: label("Pessoa A"),
    });
    expect(first).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: label("Pessoa B") }),
    ).toBeChecked();
    expect(screen.getByText("Pendências em tratativa")).toBeInTheDocument();
    expect(screen.getByText(NOTE_HINT)).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    await screen.findByRole("option", { name: "Ana" });
    pick("u2");
    expect(confirm()).toBeDisabled();
    write("Fim do turno");
    expect(confirm()).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: label("Pessoa B") }));
    fireEvent.click(confirm());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(
      "internal/team-whatsapp/pendency-handover",
      {
        json: { toUserId: "u2", note: "Fim do turno", pendencyIds: ["r1"] },
      },
    );
  });
});

describe("PendencyHandoverDialog: lista", () => {
  it("acima de 50 — aviso; sem nenhuma marcada, Confirmar desligado", async () => {
    mockApi([mine("r1", "Pessoa A"), mine("r2", "Pessoa B")], 120);
    open();
    await screen.findByRole("checkbox", { name: label("Pessoa A") });
    expect(
      screen.getByText(
        "Mostrando 2 de 120. Passe estas e abra de novo para passar as demais.",
      ),
    ).toBeInTheDocument();
    await screen.findByRole("option", { name: "Ana" });
    pick("u2");
    write("Fim do turno");
    expect(confirm()).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: label("Pessoa A") }));
    fireEvent.click(screen.getByRole("checkbox", { name: label("Pessoa B") }));
    expect(confirm()).toBeDisabled();
  });

  it("vazio — Nenhuma pendência em tratativa.; nome nulo de outro responsável vira Usuário removido", async () => {
    mockApi([]);
    open({ id: "u-old", name: null, own: false });
    expect(
      await screen.findByText("Nenhuma pendência em tratativa."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Passar as pendências de Usuário removido",
      }),
    ).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
  });
});

describe("PendencyHandoverDialog: resultado", () => {
  it("aceite 28: puladas com fora do alcance do destino, já estava com {nome}, já ciente, já encerrada, já com outro responsável", async () => {
    const names = ["A", "B", "C", "D", "E", "F"].map((n) => `Pessoa ${n}`);
    mockApi(names.map((name, index) => mine(`r${index}`, name)));
    post.mockReturnValue(
      json({
        transferred: [{ id: "r0" }],
        skipped: [
          { id: "r1", reason: "out_of_scope_target" },
          { id: "r2", reason: "already_with_target" },
          { id: "r3", reason: "acked" },
          { id: "r4", reason: "closed" },
          { id: "r5", reason: "other_handler" },
        ],
      }),
    );
    const onClose = open({ id: "u-old", name: "Carlos", own: false });
    await screen.findByRole("checkbox", { name: label("Pessoa A") });
    await screen.findByRole("option", { name: "Ana" });
    pick("u2");
    write("Fim do turno");
    fireEvent.click(confirm());
    expect(await screen.findByText("Não foram passadas:")).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(
      "internal/team-whatsapp/pendency-handover",
      {
        json: expect.objectContaining({ fromUserId: "u-old", toUserId: "u2" }),
      },
    );
    const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual([
      `${label("Pessoa B")}: fora do alcance do destino`,
      `${label("Pessoa C")}: já estava com Ana`,
      `${label("Pessoa D")}: já ciente`,
      `${label("Pessoa E")}: já encerrada`,
      `${label("Pessoa F")}: já com outro responsável`,
    ]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).toHaveBeenCalled();
  });
});
