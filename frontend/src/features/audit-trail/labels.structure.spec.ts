import { describe, expect, it } from "vitest";
import { fieldLabel } from "./labels";

describe("rótulos da trilha: turno e nível (Lote J)", () => {
  it("aceite 16: fieldLabel de startTime, endTime e order", () => {
    expect(fieldLabel("startTime")).toBe("Início");
    expect(fieldLabel("endTime")).toBe("Término");
    expect(fieldLabel("order")).toBe("Ordem");
  });
});
