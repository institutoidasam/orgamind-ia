import { describe, expect, it } from "vitest";
import {
  sectorDetailSchema,
  sectorInputSchema,
  sectorSchema,
} from "./schemas";

describe("setores", () => {
  it("normaliza a sigla e preserva payloads setoriais legados sem gerente", () => {
    const sector = sectorSchema.parse({
      id: "sector-1",
      name: "Engenharia",
      code: "ENG",
      description: null,
      memberCount: 0,
      channel: null,
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: "2026-10-10T00:00:00.000Z",
    });

    expect(sector.isActive).toBe(true);
    expect(sector.manager).toBeNull();
    expect(
      sectorInputSchema.parse({ name: "Engenharia", code: " eng " }).code,
    ).toBe("ENG");
  });

  const sectorBase = {
    id: "sector-1",
    name: "Engenharia",
    code: "ENG",
    description: null,
    channel: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
  };

  it("sectorDetailSchema aceita membro sem acesso (email null)", () => {
    const detail = sectorDetailSchema.parse({
      ...sectorBase,
      members: [
        { id: "u1", email: "ana@x.com", name: "Ana", role: "OPERATOR" },
        { id: "u2", email: null, name: "Bia", role: "VIEWER" },
      ],
    });

    expect(detail.members.map(({ email }) => email)).toEqual(["ana@x.com", null]);
  });

  it("manager com email null (pessoa sem acesso) é aceito no setor", () => {
    const sector = sectorSchema.parse({
      ...sectorBase,
      manager: { id: "u2", name: "Bia", email: null },
    });

    expect(sector.manager).toEqual({ id: "u2", name: "Bia", email: null });
  });
});

describe("setor com número (C1)", () => {
  const base = {
    id: "sector-1", name: "Engenharia", code: "ENG", description: null,
    createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
  };

  it("traz o número efetivo (channel) ou null quando não tem", () => {
    const channel = { id: "c1", name: "Loja 1", phoneE164: "+5592911111111" };
    expect(sectorSchema.parse({ ...base, channel }).channel).toEqual(channel);
    expect(sectorSchema.parse({ ...base, channel: null }).channel).toBeNull();
  });
});
