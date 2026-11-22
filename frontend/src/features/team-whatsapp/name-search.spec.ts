import { describe, expect, it } from "vitest";
import { matchesName, normalizeName } from "./name-search";

describe("name-search", () => {
  it("matchesName sem acento e sem caixa", () => {
    expect(normalizeName("  JOSÉ  ")).toBe("jose");
    expect(matchesName("José da Conceição", "jose")).toBe(true);
    expect(matchesName("Jose Silva", "JOSÉ")).toBe(true);
    expect(matchesName("Conceição", "conceicao")).toBe(true);
    expect(matchesName("Ana Souza", "sou")).toBe(true);
    expect(matchesName("Ana Souza", "bia")).toBe(false);
  });

  it("termo vazio ou só espaços casa com todos", () => {
    expect(matchesName("Ana Souza", "")).toBe(true);
    expect(matchesName("Ana Souza", "   ")).toBe(true);
  });
});
