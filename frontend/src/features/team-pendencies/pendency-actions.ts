import type { TeamPendencyItem } from "./schemas";

/** `canWrite` = `equipe.enviar`; `canUrgency` = `equipe.urgencia`. */
export type PendencyMe = {
  id: string;
  role: string;
  canWrite: boolean;
  canUrgency: boolean;
};

export type PendencyActionFlags = {
  assume: boolean;
  takeOver: boolean;
  transfer: boolean;
  note: boolean;
  close: boolean;
  reopen: boolean;
  manualAck: boolean;
  undoManualAck: boolean;
};

const NO_ACTIONS: PendencyActionFlags = {
  assume: false,
  takeOver: false,
  transfer: false,
  note: false,
  close: false,
  reopen: false,
  manualAck: false,
  undoManualAck: false,
};

type Treatment = Pick<
  PendencyActionFlags,
  "assume" | "takeOver" | "transfer" | "note" | "close" | "reopen"
>;

const isOpen = (item: TeamPendencyItem): boolean =>
  item.situation === "UNASSIGNED" ||
  item.situation === "IN_PROGRESS" ||
  item.situation === "OVERDUE";

/**
 * Pendência em aberto: o responsável ativo (ou o administrador) trata; os demais só assumem. "Sem responsável"
 * (inclui o responsável inativo ou fora do alcance) só oferece Assumir; o administrador também transfere e encerra.
 */
function openTreatment(
  item: TeamPendencyItem,
  mine: boolean,
  admin: boolean,
): Treatment {
  const unassigned = item.situation === "UNASSIGNED";
  const manage = admin || (mine && !unassigned);
  return {
    assume: unassigned,
    takeOver: !unassigned && !mine,
    transfer: manage,
    note: manage && !unassigned,
    close: manage,
    reopen: false,
  };
}

function treatment(item: TeamPendencyItem, me: PendencyMe): Treatment {
  const admin = me.role === "ADMIN";
  const mine = item.handler?.id === me.id;
  if (isOpen(item)) return openTreatment(item, mine, admin);
  const reopen = item.situation === "CLOSED" && (mine || admin);
  return { ...NO_ACTIONS, reopen };
}

/**
 * O que a tela oferece em cada pendência (DK20). Esconder é a tela; recusar é do servidor (DK11–DK14). Sem
 * `equipe.enviar` nada aparece; a ciência manual pede também `equipe.urgencia`, e só a manual se desfaz.
 */
export function pendencyActions(
  item: TeamPendencyItem,
  me: PendencyMe,
): PendencyActionFlags {
  if (!me.canWrite) return NO_ACTIONS;
  const ackable = me.canUrgency;
  return {
    ...treatment(item, me),
    manualAck: ackable && item.ack === null,
    undoManualAck: ackable && item.ack?.kind === "MANUAL",
  };
}
