import type { PendencyMe } from "./pendency-actions";
import type { TeamPendencyItem } from "./schemas";

/** Item de pendência fictício (CK2, já normalizado pelo schema); `overrides` troca só o que o teste olha. */
export function pendencyItem(
  overrides: Partial<TeamPendencyItem> = {},
): TeamPendencyItem {
  return {
    id: "r1",
    dispatchId: "d1",
    person: {
      name: "Pessoa A",
      sectorId: "s1",
      sectorName: "Setor 1",
      shiftName: "Manhã",
      phoneE164: "+5592991110001",
      hasPhone: true,
      phoneMasked: "+55 92 ****-0001",
    },
    alert: {
      text: "Parada de linha",
      authorName: "Gestor S1",
      sentAt: "2026-11-21T13:00:00.000Z",
      ackDeadlineAt: "2026-11-21T13:30:00.000Z",
    },
    group: "no_reply",
    situation: "UNASSIGNED",
    handler: null,
    assignedAt: null,
    dueAt: null,
    closure: null,
    ack: null,
    lastReply: null,
    notes: [],
    conversationId: null,
    canViewDispatch: false,
    ...overrides,
  };
}

/** Quem olha a tela: operador com `equipe.enviar` e sem `equipe.urgencia`, salvo `overrides`. */
export function pendencyMe(overrides: Partial<PendencyMe> = {}): PendencyMe {
  return {
    id: "u-me",
    role: "OPERATOR",
    canWrite: true,
    canUrgency: false,
    ...overrides,
  };
}
