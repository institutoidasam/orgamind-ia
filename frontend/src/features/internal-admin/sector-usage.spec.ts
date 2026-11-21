import { describe, expect, it } from "vitest";
import { sectorDetailSchema, type SectorUsage } from "./schemas";
import {
  inactivePeopleLine,
  inactivateSectorText,
  sectorHowTo,
  sectorInUse,
  sectorUsageLines,
} from "./sector-usage";

const USAGE: SectorUsage = {
  people: 0,
  exceptions: 0,
  scheduled: 0,
  inactivePeople: 0,
};

describe("sector-usage: textos de uso do setor (E4, DJ14)", () => {
  it("linhas só com contagem > 0, nos textos da spec", () => {
    expect(sectorUsageLines(USAGE)).toEqual([]);
    expect(sectorUsageLines({ ...USAGE, people: 3, scheduled: 1 })).toEqual([
      "3 pessoa(s) ativa(s) neste setor",
      "1 envio(s) agendado(s)",
    ]);
    expect(sectorUsageLines({ ...USAGE, exceptions: 2 })).toEqual([
      "2 exceção(ões) de escala de hoje em diante",
    ]);
  });

  it("Para liberar: um passo por tipo com uso", () => {
    expect(
      sectorHowTo({ ...USAGE, people: 1, exceptions: 1, scheduled: 1 }),
    ).toEqual([
      "Traga as pessoas para outro setor pela tela de pessoas do setor de destino.",
      "Remova as exceções na Escala.",
      "Cancele ou aguarde os envios agendados.",
    ]);
    expect(sectorHowTo({ ...USAGE, exceptions: 4 })).toEqual([
      "Remova as exceções na Escala.",
    ]);
  });

  it("em uso é pessoas, exceções ou envios; pessoas inativas só informam", () => {
    expect(sectorInUse(undefined)).toBe(false);
    expect(sectorInUse({ ...USAGE, inactivePeople: 5 })).toBe(false);
    expect(sectorInUse({ ...USAGE, scheduled: 1 })).toBe(true);
  });

  it("inactivePeopleLine só com N > 0", () => {
    expect(inactivePeopleLine(0)).toBeNull();
    expect(inactivePeopleLine(2)).toBe(
      "2 pessoa(s) inativa(s) mantêm o vínculo",
    );
  });
});

describe("sector-usage: confirmação de inativar (E6)", () => {
  it("inactivateSectorText com e sem número da área", () => {
    const main =
      "Inativar Produção? Ele sai das listas de envio, escala e cadastro. O histórico é mantido.";
    expect(inactivateSectorText("Produção", false)).toEqual([main]);
    expect(inactivateSectorText("Produção", true)).toEqual([
      main,
      "O número da área continua ligado a este setor e nenhum envio sai por ele enquanto o setor estiver inativo. Para usar o número em outra área, desvincule-o antes.",
    ]);
  });

  it("esquema aceita detalhe sem usage e completa contagens ausentes com 0", () => {
    const base = {
      id: "s1",
      name: "Produção",
      code: "PRD",
      description: null,
      channel: null,
      createdAt: "",
      updatedAt: "",
    };
    expect(sectorDetailSchema.parse(base).usage).toBeUndefined();
    expect(
      sectorDetailSchema.parse({ ...base, usage: { people: 2 } }).usage,
    ).toEqual({
      people: 2,
      exceptions: 0,
      scheduled: 0,
      inactivePeople: 0,
    });
  });
});
