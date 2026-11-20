import { describe, expect, it } from "vitest";
import {
  BASE_LABEL,
  basePhrase,
  EXCLUSION_LABEL,
  INCLUDE_OFF_LABEL,
  DISPATCH_STATE_LABEL,
  dispatchSituation,
  isLapsed,
  LEGACY_BASE_LABEL,
  manausDateTime,
  policyLabel,
  PURPOSE_LABEL,
  SCHEDULE_GRACE_MS,
  whenText,
} from "./labels";
import {
  teamExclusionReasonSchema,
  type DispatchCounts,
  type TeamDispatchState,
} from "./schemas";

const NOW = new Date("2026-11-25T15:00:00.000Z");
const ZERO: DispatchCounts = {
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  failed: 0,
  uncertain: 0,
  skipped: 0,
  scheduled: 0,
  cancelled: 0,
};
const PASSOU = "Não enviado: passou da hora";
const horasAntes = (h: number) =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("dispatchSituation", () => {
  it("dispatchSituation: Ninguém recebeu, passou da hora e os de hoje", () => {
    const situation = (
      state: TeamDispatchState,
      counts: Partial<DispatchCounts>,
    ) =>
      dispatchSituation(
        { state, counts: { ...ZERO, ...counts }, scheduledFor: null },
        NOW,
      );
    expect(situation("DISPATCHED", { skipped: 3 })).toBe("Ninguém recebeu");
    expect(situation("DISPATCHED", { skipped: 2, failed: 1 })).toBe(
      "Ninguém recebeu",
    );
    expect(situation("DISPATCHED", { skipped: 2, uncertain: 1 })).toBe(
      "Enviado",
    );
    expect(situation("DISPATCHED", { read: 1 })).toBe("Enviado");
    expect(situation("EXPIRED", { skipped: 3 })).toBe(PASSOU);
    expect(situation("SCHEDULED", { scheduled: 3 })).toBe("Agendado");
    expect(situation("CANCELLED", { cancelled: 3 })).toBe("Cancelado");
    expect(DISPATCH_STATE_LABEL).toEqual({
      DISPATCHED: "Enviado",
      SCHEDULED: "Agendado",
      CANCELLED: "Cancelado",
      EXPIRED: PASSOU,
    });
  });

  it("DG16: SCHEDULED vencido há mais de 2 h — passou da hora; há exatamente 2 h — Agendado", () => {
    const agendado = (scheduledFor: string) =>
      dispatchSituation(
        { state: "SCHEDULED", counts: { ...ZERO, scheduled: 3 }, scheduledFor },
        NOW,
      );
    expect(SCHEDULE_GRACE_MS).toBe(2 * 3_600_000);
    expect(agendado(horasAntes(2))).toBe("Agendado");
    expect(
      agendado(new Date(NOW.getTime() - SCHEDULE_GRACE_MS - 1).toISOString()),
    ).toBe(PASSOU);
    expect(agendado(horasAntes(-1))).toBe("Agendado");
    expect(
      dispatchSituation(
        { state: "CANCELLED", counts: ZERO, scheduledFor: horasAntes(5) },
        NOW,
      ),
    ).toBe("Cancelado");
  });
});

describe("isLapsed", () => {
  it("DG16: vencido só depois de 2 h (exatamente 2 h não está vencido); futuro nunca", () => {
    expect(isLapsed(horasAntes(2), NOW)).toBe(false);
    expect(
      isLapsed(
        new Date(NOW.getTime() - SCHEDULE_GRACE_MS - 1).toISOString(),
        NOW,
      ),
    ).toBe(true);
    expect(isLapsed(horasAntes(-1), NOW)).toBe(false);
  });
});

describe("política e momento do envio", () => {
  it("policyLabel nas três políticas", () => {
    expect(policyLabel("now", null)).toBe("Envio imediato");
    expect(policyLabel("shift_start", "immediate")).toBe("Envio imediato");
    expect(policyLabel("at", "frozen_recheck")).toBe(
      "Lista conferida agora; no disparo, quem deixar de se enquadrar é pulado e ninguém é acrescentado",
    );
    expect(policyLabel("shift_start", null)).toBe(
      "Regra anterior: sai para a lista da criação, sem reconferência",
    );
  });

  it("whenText de at em Manaus", () => {
    // 02:00 UTC do dia 26 ainda é 22:00 do dia 25 em Manaus (UTC-4).
    const scheduledFor = "2026-11-26T02:00:00.000Z";
    expect(manausDateTime(scheduledFor)).toEqual({
      date: "25/11/2026",
      dayMonth: "25/11",
      time: "22:00",
    });
    expect(whenText({ when: "at", scheduledFor })).toBe(
      "Em 25/11/2026 às 22:00",
    );
    expect(manausDateTime("2026-11-25T04:05:00.000Z").time).toBe("00:05");
    expect(whenText({ when: "now", scheduledFor: null })).toBe("Agora");
    expect(whenText({ when: "shift_start", scheduledFor: null })).toBe(
      "No início do turno",
    );
    expect(whenText({ when: "shift_start", scheduledFor })).toBe(
      `No início do turno (${new Date(scheduledFor).toLocaleString("pt-BR")})`,
    );
    expect(whenText({ when: "at", scheduledFor: null })).toBe(
      "Em data e hora escolhidas",
    );
  });
});

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
});
