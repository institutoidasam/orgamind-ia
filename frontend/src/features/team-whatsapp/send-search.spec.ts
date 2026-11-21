import { describe, expect, it } from "vitest";
import { initialSendFilters, validateSendSearch } from "./send-search";

const sectors = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];

describe("validateSendSearch: parâmetros de /whatsapp-equipe", () => {
  it("validateSendSearch: texto com vírgulas e lista de textos; descarta o resto", () => {
    expect(
      validateSendSearch({ sectorIds: "s1,s2", date: "2026-11-18" }),
    ).toEqual({
      sectorIds: "s1,s2",
      date: "2026-11-18",
    });
    expect(validateSendSearch({ sectorIds: ["s1", "s2"] })).toEqual({
      sectorIds: "s1,s2",
    });
    expect(validateSendSearch({ sectorIds: ["s1", 7, "", null] })).toEqual({
      sectorIds: "s1",
    });
    expect(
      validateSendSearch({ sectorIds: " , ", date: "2026-02-30" }),
    ).toEqual({});
    expect(validateSendSearch({ sectorIds: 7, date: 20261118 })).toEqual({});
    expect(validateSendSearch({})).toEqual({});
  });

  it("devolve as chaves descartadas como undefined (o router mescla a busca crua da URL por baixo)", () => {
    expect(
      validateSendSearch({ sectorIds: " , ", date: "2026-02-30" }),
    ).toStrictEqual({ sectorIds: undefined, date: undefined });
  });
});

describe("initialSendFilters: estado inicial da tela de envio", () => {
  it("initialSendFilters: ids fora do alcance saem; lista vazia → null; data inválida → null", () => {
    expect(
      initialSendFilters(
        { sectorIds: "s2,inativo,s2", date: "2026-11-18" },
        sectors,
      ),
    ).toEqual({
      sectorIds: ["s2"],
      date: "2026-11-18",
    });
    expect(
      initialSendFilters({ sectorIds: "inativo", date: "2026-02-30" }, sectors),
    ).toEqual({
      sectorIds: null,
      date: null,
    });
    expect(initialSendFilters({}, sectors)).toEqual({
      sectorIds: null,
      date: null,
    });
    expect(initialSendFilters({ sectorIds: "s1" }, [])).toEqual({
      sectorIds: null,
      date: null,
    });
  });
});
