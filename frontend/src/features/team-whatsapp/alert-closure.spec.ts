import { describe, expect, it } from "vitest";
import { closureText } from "./alert-labels";
import { teamAlertPanelSchema } from "./alert-schemas";
import { alertPanel, alertPerson } from "./alert.test-fixtures";

const at = "2026-11-20T13:20:00.000Z";

describe("alert-labels: tratativa encerrada", () => {
  it("aceite 20: Tratativa encerrada por {nome}: {motivo}", () => {
    expect(
      closureText({ at, byName: "Gestor S1", reason: "Falou por ligação" }),
    ).toBe("Tratativa encerrada por Gestor S1: Falou por ligação");
  });

  it("byName nulo — Usuário removido", () => {
    expect(closureText({ at, byName: null, reason: "Sem retorno" })).toBe(
      "Tratativa encerrada por Usuário removido: Sem retorno",
    );
  });

  it("sem closure — null", () => {
    expect(closureText(null)).toBeNull();
    expect(closureText(undefined)).toBeNull();
  });
});

describe("alert-schemas: closure da pessoa (CK9)", () => {
  const closure = { at, byName: null, reason: "Sem retorno" };
  const parse = (over: Parameters<typeof alertPerson>[0]) =>
    teamAlertPanelSchema.parse(alertPanel({ people: [alertPerson(over)] }))
      .people[0];

  it("aceita closure com nome nulo, null e a ausência do campo (back antigo)", () => {
    expect(parse({ closure })?.closure).toEqual(closure);
    expect(parse({ closure: null })?.closure).toBeNull();
    expect(parse({})?.closure).toBeUndefined();
  });
});
