import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Moment } from "../use-send-filters";
import { SendMoment, type MomentOption } from "./send-moment";

const TODAY = "2026-11-20";
const ALL: MomentOption[] = [{ when: "now" }, { when: "at" }];

function setup(value: Moment, options: readonly MomentOption[] = ALL) {
  const onChange = vi.fn();
  render(
    <SendMoment
      value={value}
      onChange={onChange}
      options={options}
      today={TODAY}
    />,
  );
  return { onChange };
}

describe("SendMoment: escolha do momento", () => {
  it("lista só os momentos oferecidos e esconde a data e a hora fora de Data e hora", () => {
    setup({ when: "now", at: null });
    expect(
      screen.getAllByRole("radio").map((r) => r.closest("label")?.textContent),
    ).toEqual(["Agora", "Data e hora"]);
    expect(screen.getByRole("radio", { name: "Agora" })).toBeChecked();
    expect(screen.queryByLabelText("Data do envio")).not.toBeInTheDocument();
  });

  it("escolher Data e hora abre o momento vazio; voltar para Agora o limpa; opção desabilitada não se escolhe", async () => {
    const { onChange } = setup({ when: "now", at: null }, [
      ...ALL,
      { when: "shift_start", disabled: true },
    ]);
    expect(
      screen.getByRole("radio", { name: "No início do turno" }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: "Data e hora" }));
    expect(onChange).toHaveBeenCalledWith({
      when: "at",
      at: { date: "", time: "" },
    });
  });
});

describe("SendMoment: data e hora do envio", () => {
  it("aceite 37: o campo só oferece de hoje a hoje + 30 dias", () => {
    setup({ when: "at", at: { date: "", time: "" } });
    const date = screen.getByLabelText("Data do envio");
    expect(date).toHaveAttribute("min", "2026-11-20");
    expect(date).toHaveAttribute("max", "2026-12-20");
    expect(screen.getByLabelText("Hora do envio")).toHaveAttribute(
      "type",
      "time",
    );
  });

  it("digitar a data e a hora devolve o momento com os dois campos", () => {
    const { onChange } = setup({
      when: "at",
      at: { date: "2026-11-25", time: "" },
    });
    fireEvent.change(screen.getByLabelText("Hora do envio"), {
      target: { value: "09:30" },
    });
    expect(onChange).toHaveBeenCalledWith({
      when: "at",
      at: { date: "2026-11-25", time: "09:30" },
    });
    fireEvent.change(screen.getByLabelText("Data do envio"), {
      target: { value: "2026-11-26" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      when: "at",
      at: { date: "2026-11-26", time: "" },
    });
  });
});
