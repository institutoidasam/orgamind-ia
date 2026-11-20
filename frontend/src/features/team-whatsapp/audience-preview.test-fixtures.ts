import type { TeamAudiencePreview, TeamAudienceRuleView } from "./schemas";

/** Regra de um Aviso de turno sem seleção nem atividade (resposta falsa do servidor). */
export const RULE_VIEW: TeamAudienceRuleView = {
  purpose: "shift_notice",
  base: "on_duty",
  includeOff: false,
  rosterDate: "2026-11-20",
  sectors: [{ id: "s1", name: "Logística" }],
  shifts: [{ id: "sh1", name: "Manhã" }],
  levels: [],
  withoutLevel: false,
  selectedCount: null,
  activity: null,
  urgencyReason: null,
  when: "now",
  scheduledFor: null,
  schedulePolicy: null,
};

const PERSON = {
  sectorId: "s1",
  sectorName: "Logística",
  shiftName: "Manhã",
  levelName: null,
};

/** Prévia com uma pessoa que recebe, uma de folga e uma trava. */
export const PREVIEW_RESPONSE: TeamAudiencePreview = {
  audienceKey: "a".repeat(64),
  rule: RULE_VIEW,
  included: [
    { ...PERSON, userId: "u1", name: "Marina Souza", phone: "•••• 0001" },
  ],
  excluded: [
    { ...PERSON, userId: "u2", name: "Rafael Lima", reason: "day_off" },
  ],
  blocks: [
    { code: "team_whatsapp.empty_text", message: "Escreva a mensagem." },
  ],
};
