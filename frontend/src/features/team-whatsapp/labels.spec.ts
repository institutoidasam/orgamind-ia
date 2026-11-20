import { describe, expect, it } from "vitest";
import {
  BASE_LABEL,
  basePhrase,
  EXCLUSION_LABEL,
  INCLUDE_OFF_LABEL,
  LEGACY_BASE_LABEL,
  policyLabel,
  PURPOSE_LABEL,
} from "./labels";
import { teamExclusionReasonSchema } from "./schemas";

describe("basePhrase", () => {
  it("basePhrase nas três combinações", () => {
    expect(basePhrase("on_duty", false, "2026-11-20")).toBe(
      "Equipe em serviço: quem a escala de 20/11 põe para trabalhar nos setores e turnos escolhidos. Quem está de folga ou de férias fica de fora.",
    );
    expect(basePhrase("assigned", true, "2026-11-05")).toBe(
      "Equipe vinculada: quem tem os setores e turnos escolhidos no cadastro em 05/11. Quem está de folga entra porque a opção foi marcada; quem está de férias fica de fora.",
    );
    expect(basePhrase("assigned", false, "2026-11-05")).toBe(
      "Equipe vinculada: quem tem os setores e turnos escolhidos no cadastro em 05/11. Quem está de folga fica de fora porque a opção não foi marcada; quem está de férias também.",
    );
  });

  it("na base em serviço a folga marcada não muda a frase (a opção não existe)", () => {
    expect(basePhrase("on_duty", true, "2026-11-20")).toBe(
      basePhrase("on_duty", false, "2026-11-20"),
    );
  });
});

describe("rótulos do público", () => {
  it("rótulos dos oito motivos", () => {
    expect(EXCLUSION_LABEL).toEqual({
      not_selected: "Não selecionado",
      day_off: "Folga",
      vacation: "Férias",
      other_sector: "Em outro setor nesta data",
      other_shift: "Fora do turno nesta data",
      no_phone: "Sem telefone",
      not_authorized: "Contato não autorizado",
      suppressed: "Número bloqueado",
    });
    expect(Object.keys(EXCLUSION_LABEL).sort()).toEqual(
      [...teamExclusionReasonSchema.options].sort(),
    );
  });

  it("finalidades, bases e opção de folga têm o texto do CF10", () => {
    expect(Object.values(PURPOSE_LABEL)).toEqual([
      "Aviso de turno",
      "Reunião",
      "Alinhamento",
      "Palestra",
      "Hora extra",
      "Urgência",
    ]);
    expect(BASE_LABEL).toEqual({
      on_duty: "Equipe em serviço",
      assigned: "Equipe vinculada",
    });
    expect(LEGACY_BASE_LABEL).toBe("equipe em serviço (regra anterior)");
    expect(INCLUDE_OFF_LABEL).toBe("Incluir quem está de folga");
  });

  it("policyLabel: agora é imediato; início do turno sem política conta a lista conferida agora", () => {
    expect(policyLabel("now", null)).toBe("Envio imediato");
    expect(policyLabel("shift_start", null)).toBe(
      "No início do turno, para a lista conferida agora",
    );
  });
});
