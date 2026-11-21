import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PendencyTextDialog } from "./pendency-text-dialog";

const onConfirm = vi.fn();
const onCancel = vi.fn();

function open(props: Partial<Parameters<typeof PendencyTextDialog>[0]> = {}) {
  onConfirm.mockReset();
  onCancel.mockReset();
  return render(
    <PendencyTextDialog
      open
      title="Registrar contato"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
}

const confirm = () => screen.getByRole("button", { name: "Confirmar" });

describe("PendencyTextDialog: campo obrigatório", () => {
  it("obrigatório — Confirmar desligado vazio; 200 no máximo; manda aparado", () => {
    open({ field: { label: "Motivo", required: true } });
    const field = screen.getByLabelText("Motivo");
    expect(confirm()).toBeDisabled();
    fireEvent.change(field, { target: { value: "   " } });
    expect(confirm()).toBeDisabled();
    fireEvent.change(field, { target: { value: "x".repeat(250) } });
    expect(field).toHaveValue("x".repeat(200));
    fireEvent.change(field, { target: { value: "  Liguei no ramal  " } });
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("Liguei no ramal");
  });
});

describe("PendencyTextDialog: campo opcional e só confirmação", () => {
  it("opcional — vazio não manda note", () => {
    open({ field: { label: "Observação (opcional)", required: false } });
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("opcional — com texto manda aparado", () => {
    open({ field: { label: "Observação (opcional)", required: false } });
    fireEvent.change(screen.getByLabelText("Observação (opcional)"), {
      target: { value: " Passei o caso " },
    });
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("Passei o caso");
  });

  it("sem campo — só confirma; durante o envio Confirmar fica desligado", () => {
    const view = open({ title: "Reabrir a tratativa?" });
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(undefined);
    view.unmount();
    open({ title: "Reabrir a tratativa?", busy: true });
    expect(confirm()).toBeDisabled();
  });
});

describe("PendencyTextDialog: cancelar", () => {
  it("Cancelar fecha sem chamar", () => {
    open({ field: { label: "Motivo", required: true } });
    fireEvent.change(screen.getByLabelText("Motivo"), {
      target: { value: "algo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
