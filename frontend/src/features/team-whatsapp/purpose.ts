import type { TeamAudienceBase, TeamPurpose } from "./schemas";

/**
 * Cópia da matriz de `backend/src/modules/team-whatsapp/team-whatsapp.purpose.ts` (CF5, C1 da spec).
 * O servidor é quem decide; aqui a tela só mostra os campos certos. Mexeu lá, mexa aqui.
 */
export type PurposeRule = {
  /** `[0]` é a base padrão; com mais de uma, o operador escolhe (Alinhamento). */
  bases: readonly TeamAudienceBase[];
  /** Opção "Incluir quem está de folga": `none` = não existe; `checked`/`unchecked` = estado inicial. */
  offOption: "none" | "checked" | "unchecked";
  /** Data, hora e local da atividade: `required` = obrigatória; `optional` = se informar, data e hora valem. */
  activity: "none" | "required" | "optional";
  urgencyReason: boolean;
  /** Hora extra: marcar pelo menos uma pessoa. */
  selectionRequired: boolean;
  /** Momentos permitidos. O G acrescenta 'at'. */
  when: readonly ("now" | "shift_start")[];
};

export const PURPOSE_RULES: Record<TeamPurpose, PurposeRule> = {
  shift_notice: {
    bases: ["on_duty"],
    offOption: "none",
    activity: "none",
    urgencyReason: false,
    selectionRequired: false,
    when: ["now", "shift_start"],
  },
  meeting: {
    bases: ["assigned"],
    offOption: "checked",
    activity: "required",
    urgencyReason: false,
    selectionRequired: false,
    when: ["now"],
  },
  alignment: {
    bases: ["assigned", "on_duty"],
    offOption: "unchecked",
    activity: "optional",
    urgencyReason: false,
    selectionRequired: false,
    when: ["now"],
  },
  lecture: {
    bases: ["assigned"],
    offOption: "checked",
    activity: "required",
    urgencyReason: false,
    selectionRequired: false,
    when: ["now"],
  },
  overtime: {
    bases: ["assigned"],
    offOption: "unchecked",
    activity: "required",
    urgencyReason: false,
    selectionRequired: true,
    when: ["now"],
  },
  urgency: {
    bases: ["on_duty"],
    offOption: "none",
    activity: "none",
    urgencyReason: true,
    selectionRequired: false,
    when: ["now"],
  },
};
