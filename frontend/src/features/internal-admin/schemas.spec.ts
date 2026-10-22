import { describe, expect, it } from "vitest";
import {
  internalNumberInputSchema,
  internalNumberSchema,
  sectorDetailSchema,
  sectorInputSchema,
  sectorSchema,
} from "./schemas";

describe("setores e números internos", () => {
  it("normaliza a sigla e preserva payloads setoriais legados sem gerente", () => {
    const sector = sectorSchema.parse({
      id: "sector-1",
      name: "Engenharia",
      code: "ENG",
      description: null,
      memberCount: 0,
      numberCount: 0,
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

  it("aceita apenas E.164 para o registro estrutural e nunca presume canal conectado", () => {
    expect(() =>
      internalNumberInputSchema.parse({
        name: "GBR Engenharia",
        phone: "5592999990000",
        provider: "META",
        sectorId: "sector-1",
        routeToSector: true,
      }),
    ).toThrow();

    const number = internalNumberSchema.parse({
      id: "number-1",
      name: "GBR Engenharia",
      phone: "+5592999990000",
      provider: "META",
      sectorId: "sector-1",
      sector: { id: "sector-1", name: "Engenharia", code: "ENG" },
      routeToSector: true,
      channelId: null,
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: "2026-10-10T00:00:00.000Z",
    });

    expect(number.configurationStatus).toBe("UNCONFIGURED");
  });

  it("aceita o identificador de um canal existente sem mudar o roteamento pendente", () => {
    expect(
      internalNumberInputSchema.parse({
        name: "GBR Engenharia",
        phone: "+5592999990000",
        provider: "META",
        sectorId: "sector-1",
        routeToSector: true,
        channelId: "channel-1",
      }),
    ).toMatchObject({ channelId: "channel-1", routeToSector: true });
  });
});
