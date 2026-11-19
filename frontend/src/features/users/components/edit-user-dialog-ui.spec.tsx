import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditUserDialog } from "./edit-user-dialog";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture)
  Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => {};

const state = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("../api", () => ({
  useUpdateUser: () => state,
  useActiveLevels: () => ({ data: [] }),
}));
vi.mock("@/features/internal-admin/api", () => ({
  useSectors: () => ({ data: { items: [{ id: "s1", name: "Engenharia" }] } }),
}));
vi.mock("@/features/shifts/api", () => ({ useShifts: () => ({ data: [] }) }));
vi.mock("sonner", () => ({ toast }));

const user = {
  id: "u1",
  email: "ana@gbr.test",
  hasAccess: true,
  name: "Ana",
  role: "ADMIN" as const,
  sectorId: null,
  sector: null,
  isActive: true,
  lastLoginAt: null,
  createdAt: "2026-10-10",
  createdBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.mutateAsync.mockResolvedValue(undefined);
});

const withRecord = {
  ...user,
  registration: "123",
  contactAuthorization: {
    status: "AUTORIZADO" as const,
    source: "TERMO_ASSINADO" as const,
    note: null,
    date: "2026-01-10",
    recordedAt: null,
  },
};
const typeReason = (
  ui: ReturnType<typeof userEvent.setup>,
  text = "ajuste cadastral",
) => ui.type(screen.getByLabelText("Motivo da alteração"), text);
const saveButton = () => screen.getByRole("button", { name: "Salvar" });

describe("EditUserDialog ficha", () => {
  it("sem motivo mostra o erro e não chama a API", async () => {
    const ui = userEvent.setup();
    render(
      <EditUserDialog
        user={withRecord}
        open
        onOpenChange={() => {}}
        isSelf={false}
      />,
    );
    await ui.click(saveButton());
    expect(
      await screen.findByText("Informe o motivo, de 3 a 200 caracteres"),
    ).toBeInTheDocument();
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it("com motivo envia reason, matrícula e só a autorização alterada", async () => {
    const ui = userEvent.setup();
    render(
      <EditUserDialog
        user={withRecord}
        open
        onOpenChange={() => {}}
        isSelf={false}
      />,
    );
    expect(
      screen.getByText("Autorização atual: Termo assinado em 10/01/2026"),
    ).toBeInTheDocument();
    await ui.type(screen.getByLabelText("Matrícula"), "9");
    await ui.click(
      screen.getByRole("radio", { name: "Sem autorização registrada" }),
    );
    await typeReason(ui);
    await ui.click(saveButton());
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    const { data } = state.mutateAsync.mock.calls[0][0];
    expect(data).toMatchObject({
      reason: "ajuste cadastral",
      registration: "1239",
      contactAuthorization: { status: "NAO_AUTORIZADO" },
    });
    expect(data).not.toHaveProperty("isActive");
  });

});

describe("EditUserDialog ficha: matrícula e PATCH", () => {
  it("matrícula e autorização iguais às atuais não vão no PATCH", async () => {
    const ui = userEvent.setup();
    render(
      <EditUserDialog
        user={withRecord}
        open
        onOpenChange={() => {}}
        isSelf={false}
      />,
    );
    await typeReason(ui);
    await ui.click(saveButton());
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    const { data } = state.mutateAsync.mock.calls[0][0];
    expect(data).toMatchObject({ reason: "ajuste cadastral" });
    expect(data).not.toHaveProperty("registration");
    expect(data).not.toHaveProperty("contactAuthorization");
  });
});

describe("EditUserDialog ficha: validação e campos", () => {
  it("data de autorização futura bloqueia o envio", async () => {
    const ui = userEvent.setup();
    render(
      <EditUserDialog
        user={withRecord}
        open
        onOpenChange={() => {}}
        isSelf={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Data da autorização"), {
      target: { value: "2999-01-01" },
    });
    await typeReason(ui);
    await ui.click(saveButton());
    expect(
      await screen.findByText("A data da autorização não pode ser futura"),
    ).toBeInTheDocument();
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it("não mostra mais o campo Situação nem Acesso", () => {
    render(
      <EditUserDialog
        user={withRecord}
        open
        onOpenChange={() => {}}
        isSelf={false}
      />,
    );
    expect(screen.queryByText("Situação")).toBeNull();
    expect(screen.queryByText("Acesso")).toBeNull();
  });
});

describe("EditUserDialog", () => {
  it("sends only name for self edit and never reports success after a failure", async () => {
    const onOpenChange = vi.fn();
    const ui = userEvent.setup();
    render(
      <EditUserDialog user={user} open onOpenChange={onOpenChange} isSelf />,
    );
    const name = screen.getAllByRole("textbox")[1];
    await ui.clear(name);
    await ui.type(name, "Ana Souza");
    await typeReason(ui, "corrigir nome");
    await ui.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(state.mutateAsync).toHaveBeenCalledWith({
        id: "u1",
        data: { name: "Ana Souza", reason: "corrigir nome" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Usuário atualizado.");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    state.mutateAsync.mockRejectedValueOnce(new Error("falhou"));
    await ui.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("keeps administrative fields when editing another user", async () => {
    const ui = userEvent.setup();
    render(
      <EditUserDialog
        user={{ ...user, role: "OPERATOR", sectorId: "s1" }}
        open
        onOpenChange={() => {}}
        isSelf={false}
      />,
    );
    await typeReason(ui);
    await ui.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(state.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: "OPERATOR", sectorId: "s1" }),
        }),
      ),
    );
  });
});
