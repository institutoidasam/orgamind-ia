import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
  }: {
    children: React.ReactNode;
    params?: { communicationId?: string };
  }) => <a data-communication-id={params?.communicationId}>{children}</a>,
}));
let authUser: { role: string; sectorId: string | null } = {
  role: "OPERATOR",
  sectorId: "s1",
};
let activeSectors = [
  { id: "s1", name: "Produção" },
  { id: "s2", name: "Qualidade" },
  { id: "s3", name: "Comercial" },
];
vi.mock("@/stores/auth.store", () => ({
  useAuthStore: (selector: (value: { user: typeof authUser }) => unknown) =>
    selector({ user: authUser }),
}));
const create = {
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  isSuccess: false,
  data: undefined,
};
vi.mock("../api", () => ({
  useActiveSectors: () => ({
    data: activeSectors,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useEligibleMembers: () => ({
    data: [{ id: "u2", name: "Bia", email: "bia@gbr.test" }],
  }),
  useCreateCommunication: () => create,
}));

import { CommunicationWizard } from "./communication-wizard";

describe("CommunicationWizard", () => {
  beforeEach(() => {
    authUser = { role: "OPERATOR", sectorId: "s1" };
    activeSectors = [
      { id: "s1", name: "Produção" },
      { id: "s2", name: "Qualidade" },
      { id: "s3", name: "Comercial" },
    ];
    create.mutate.mockReset();
    create.isPending = false;
    create.isError = false;
    create.isSuccess = false;
    create.data = undefined;
  });

  it("envia uma demanda completa somente após as três etapas e preserva o UUID no retry", async () => {
    const user = userEvent.setup();
    render(<CommunicationWizard />);
    await user.type(screen.getByLabelText("Assunto"), "Validar lote");
    await user.type(
      screen.getByLabelText(/Mensagem/),
      "Validar a chegada do lote.",
    );
    await user.selectOptions(screen.getByLabelText("Setor destinatário"), "s2");
    await user.selectOptions(screen.getByLabelText("Prioridade"), "HIGH");
    fireEvent.change(screen.getByLabelText("Prazo desejado"), {
      target: { value: "2026-10-13" },
    });
    await user.click(
      screen.getByRole("button", { name: "Continuar para destinatários" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Responsável inicial"),
      "u2",
    );
    await user.click(screen.getByLabelText("Comercial"));
    await user.click(
      screen.getByRole("button", { name: "Revisar comunicação" }),
    );
    expect(screen.getByText("Alta · 13/10/2026")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Confirmar e registrar" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirmar e registrar" }),
    );
    expect(create.mutate).toHaveBeenCalledTimes(2);
    const firstPayload = create.mutate.mock.calls[0]?.[0];
    const retryPayload = create.mutate.mock.calls[1]?.[0];
    expect(firstPayload).toMatchObject({
      kind: "DEMAND",
      originSectorId: "s1",
      destinationSectorId: "s2",
      ccSectorIds: ["s3"],
      assigneeId: "u2",
      priority: "HIGH",
      dueDate: "2026-10-13",
      notifyTeam: true,
      notifyAssignee: true,
      clientRequestId: expect.any(String),
    });
    expect(retryPayload.clientRequestId).toBe(firstPayload.clientRequestId);
  });

  it("envia comunicado sem campos próprios de demanda", async () => {
    const user = userEvent.setup();
    render(<CommunicationWizard initialKind="ANNOUNCEMENT" />);
    await user.type(screen.getByLabelText("Assunto"), "Reunião geral");
    await user.type(
      screen.getByLabelText(/Mensagem/),
      "A reunião começa às nove.",
    );
    await user.selectOptions(screen.getByLabelText("Setor destinatário"), "s2");
    await user.click(
      screen.getByRole("button", { name: "Continuar para destinatários" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Revisar comunicação" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirmar e registrar" }),
    );
    const payload = create.mutate.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      kind: "ANNOUNCEMENT",
      originSectorId: "s1",
      destinationSectorId: "s2",
    });
    expect(payload).not.toHaveProperty("assigneeId");
    expect(payload).not.toHaveProperty("priority");
    expect(payload).not.toHaveProperty("dueDate");
  });

  it("limpa destino e CC incompatíveis quando ADMIN troca a origem", async () => {
    const user = userEvent.setup();
    authUser = { role: "ADMIN", sectorId: null };
    render(<CommunicationWizard />);
    await user.type(screen.getByLabelText("Assunto"), "Ação");
    await user.type(screen.getByLabelText(/Mensagem/), "Mensagem suficiente.");
    await user.selectOptions(screen.getByLabelText("Setor de origem"), "s1");
    await user.selectOptions(screen.getByLabelText("Setor destinatário"), "s2");
    await user.click(
      screen.getByRole("button", { name: "Continuar para destinatários" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Responsável inicial"),
      "u2",
    );
    await user.click(screen.getByLabelText("Comercial"));
    await user.click(screen.getByRole("button", { name: "Voltar" }));
    await user.selectOptions(screen.getByLabelText("Setor de origem"), "s3");
    expect(screen.getByLabelText("Setor destinatário")).toHaveValue("s2");
    await user.click(
      screen.getByRole("button", { name: "Continuar para destinatários" }),
    );
    expect(screen.queryByLabelText("Comercial")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Responsável inicial")).toHaveValue("u2");
    await user.click(screen.getByRole("button", { name: "Voltar" }));
    await user.selectOptions(screen.getByLabelText("Setor destinatário"), "s1");
    await user.click(
      screen.getByRole("button", { name: "Continuar para destinatários" }),
    );
    expect(screen.getByLabelText("Responsável inicial")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Voltar" }));
    await user.selectOptions(screen.getByLabelText("Setor de origem"), "s1");
    expect(screen.getByLabelText("Setor destinatário")).toHaveValue("");
  });

  it("exige setor de origem explícito para ADMIN", async () => {
    const user = userEvent.setup();
    authUser = { role: "ADMIN", sectorId: null };
    render(<CommunicationWizard />);
    await user.type(screen.getByLabelText("Assunto"), "Ação");
    await user.type(screen.getByLabelText(/Mensagem/), "Mensagem suficiente.");
    await user.selectOptions(screen.getByLabelText("Setor destinatário"), "s2");
    await user.click(
      screen.getByRole("button", { name: "Continuar para destinatários" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/setores de origem/i);
  });

  it("orienta operador cujo setor de origem está inativo", () => {
    activeSectors = [{ id: "s2", name: "Qualidade" }];
    render(<CommunicationWizard />);
    expect(
      screen.getByText(/seu setor de origem não está ativo/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /confirmar/i }),
    ).not.toBeInTheDocument();
  });

  it("não permite publicação para VIEWER", () => {
    authUser = { role: "VIEWER", sectorId: "s1" };
    render(<CommunicationWizard />);
    expect(screen.getByText(/somente consulta/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /confirmar/i }),
    ).not.toBeInTheDocument();
  });

  it("mostra o link do mesmo ID devolvido pela API após sucesso", () => {
    create.isSuccess = true;
    create.data = { id: "real-communication-id" };
    render(<CommunicationWizard />);
    expect(screen.getByText("Ver demanda")).toHaveAttribute(
      "data-communication-id",
      "real-communication-id",
    );
  });

  it("mostra erro real da mutation sem exibir sucesso", () => {
    create.isError = true;
    render(<CommunicationWizard />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /não foi possível registrar/i,
    );
    expect(screen.queryByText(/demanda criada/i)).not.toBeInTheDocument();
  });
});
