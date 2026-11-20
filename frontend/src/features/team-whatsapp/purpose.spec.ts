import { describe, expect, it } from "vitest";
import { PURPOSE_RULES, type PurposeRule } from "./purpose";

describe("PURPOSE_RULES", () => {
  it("PURPOSE_RULES igual ao CF5", () => {
    // Matriz do C1 da spec, linha a linha: base(s), folga, atividade, motivo, seleção obrigatória, momentos.
    const aviso: PurposeRule = {
      bases: ["on_duty"],
      offOption: "none",
      activity: "none",
      urgencyReason: false,
      selectionRequired: false,
      when: ["now", "shift_start"],
    };
    const comAtividade = {
      ...aviso,
      bases: ["assigned"],
      activity: "required",
      when: ["now"],
    } satisfies PurposeRule;
    expect(PURPOSE_RULES).toEqual({
      shift_notice: aviso,
      meeting: { ...comAtividade, offOption: "checked" },
      alignment: {
        ...comAtividade,
        bases: ["assigned", "on_duty"],
        offOption: "unchecked",
        activity: "optional",
      },
      lecture: { ...comAtividade, offOption: "checked" },
      overtime: {
        ...comAtividade,
        offOption: "unchecked",
        selectionRequired: true,
      },
      urgency: { ...aviso, urgencyReason: true, when: ["now"] },
    });
  });
});
