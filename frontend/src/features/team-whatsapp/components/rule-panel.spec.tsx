import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RULE_VIEW } from "../audience-preview.test-fixtures";
import { basePhrase } from "../labels";
import type { TeamAudienceRuleView } from "../schemas";
import { RulePanel } from "./rule-panel";

const complete: TeamAudienceRuleView = {
  ...RULE_VIEW,
  purpose: "meeting",
  base: "assigned",
  includeOff: true,
  rosterDate: "2026-11-25",
  sectors: [
    { id: "s1", name: "Logística" },
    { id: "s2", name: "Operação" },
  ],
  shifts: [{ id: "sh1", name: "Manhã" }],
  levels: [{ id: "l1", name: "Líder" }],
  withoutLevel: true,
  selectedCount: 3,
  activity: { date: "2026-11-25", time: "09:30", place: "Sala 2" },
};

const renderPanel = (rule: TeamAudienceRuleView) =>
  render(<RulePanel rule={rule} includedCount={5} excludedCount={2} />);
/** Texto do valor que acompanha o rótulo; `null` quando a linha não existe. */
const value = (label: string) =>
  screen.queryByText(label, { selector: "dt" })?.nextElementSibling
    ?.textContent ?? null;

describe("RulePanel: campos da regra", () => {
  it("painel mostra finalidade, base com a frase, setores, turnos, níveis, folga, data, atividade, momento e política", () => {
    renderPanel(complete);
    expect(
      screen.getByRole("region", { name: "Regra do público" }),
    ).toBeInTheDocument();
    expect(value("Finalidade")).toBe("Reunião");
    expect(value("Base")).toBe(
      `Equipe vinculada${basePhrase("assigned", true, "2026-11-25")}`,
    );
    expect(value("Setores")).toBe("Logística, Operação");
    expect(value("Turnos")).toBe("Manhã");
    expect(value("Níveis")).toBe("Líder, Sem nível");
    expect(value("Folga")).toBe("Incluída");
    expect(value("Data de referência")).toBe("25/11/2026");
    expect(value("Atividade")).toBe("25/11/2026 às 09:30 · Sala 2");
    expect(value("Pessoas marcadas")).toBe("3");
    expect(value("Momento do disparo")).toBe("Agora");
    expect(value("Política do agendamento")).toBe("Envio imediato");
    expect(
      screen.getByText("No público (5) · De fora (2)"),
    ).toBeInTheDocument();
  });
});

describe("RulePanel: turnos, níveis e momento", () => {
  it("turnos nulos aparecem como todos os turnos; política nula no início do turno mostra a lista conferida agora", () => {
    const scheduledFor = "2026-11-25T10:00:00.000Z";
    renderPanel({
      ...complete,
      purpose: "shift_notice",
      base: "on_duty",
      includeOff: false,
      shifts: null,
      levels: [],
      withoutLevel: false,
      selectedCount: null,
      activity: null,
      when: "shift_start",
      scheduledFor,
      schedulePolicy: null,
    });
    expect(value("Turnos")).toBe("Todos os turnos");
    expect(value("Níveis")).toBe("Todos os níveis");
    expect(value("Folga")).toBe("Não incluída");
    expect(value("Momento do disparo")).toBe(
      `No início do turno (${new Date(scheduledFor).toLocaleString("pt-BR")})`,
    );
    expect(value("Política do agendamento")).toBe(
      "No início do turno, para a lista conferida agora",
    );
    expect(value("Atividade")).toBeNull();
    expect(value("Pessoas marcadas")).toBeNull();
    expect(value("Motivo da urgência")).toBeNull();
  });
});

describe("RulePanel: urgência e atividade parcial", () => {
  it("urgência mostra o motivo; atividade só com hora ou só com local mostra o que veio", () => {
    const { rerender } = renderPanel({
      ...complete,
      purpose: "urgency",
      base: "on_duty",
      urgencyReason: "Falta de energia",
    });
    expect(value("Motivo da urgência")).toBe("Falta de energia");
    rerender(
      <RulePanel
        rule={{
          ...complete,
          activity: { date: null, time: null, place: "Sala 2" },
        }}
        includedCount={1}
        excludedCount={0}
      />,
    );
    expect(value("Atividade")).toBe("Sala 2");
    rerender(
      <RulePanel
        rule={{
          ...complete,
          activity: { date: null, time: null, place: null },
        }}
        includedCount={1}
        excludedCount={0}
      />,
    );
    expect(value("Atividade")).toBeNull();
  });
});
