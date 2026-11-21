import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SectorInactivateDialog } from "./sector-inactivate-dialog";

const QUESTION =
  "Inativar Produção? Ele sai das listas de envio, escala e cadastro. O histórico é mantido.";
const AREA_NOTE = /O número da área continua ligado a este setor/;

function setup(props: { hasAreaNumber?: boolean; pending?: boolean } = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <SectorInactivateDialog
      open
      name="Produção"
      hasAreaNumber={props.hasAreaNumber ?? false}
      pending={props.pending ?? false}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe("SectorInactivateDialog", () => {
  it("pergunta com o nome do setor, sem aviso de número quando o setor não tem", async () => {
    const { onConfirm, onCancel } = setup();
    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(screen.queryByText(AREA_NOTE)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Inativar setor" }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("com número da área acrescenta o aviso; Cancelar não confirma", async () => {
    const { onConfirm, onCancel } = setup({ hasAreaNumber: true });
    expect(screen.getByText(AREA_NOTE)).toBeTruthy();
    expect(screen.getByText(/desvincule-o antes\.$/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("gravando, os dois botões ficam desligados", () => {
    setup({ pending: true });
    expect(
      (
        screen.getByRole("button", {
          name: "Inativar setor",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cancelar" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
