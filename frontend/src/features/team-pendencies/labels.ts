import { historyTime } from "@/features/chat/history-text";
import type { PendencySituation, TeamPendencyItem } from "./schemas";

/** Quem tem nome nulo foi removido do sistema (o id ficou nas linhas antigas). */
export const REMOVED_USER_LABEL = "Usuário removido";

/** Rótulo de cada situação da pendência (DK19). */
export const SITUATION_LABEL: Record<PendencySituation, string> = {
  UNASSIGNED: "Sem responsável",
  IN_PROGRESS: "Em tratativa",
  OVERDUE: "Em tratativa — atrasada",
  ACKED: "Ciente",
  CLOSED: "Encerrada sem ciência",
};

const HANDLER_STATE_SUFFIX: Record<
  NonNullable<TeamPendencyItem["handler"]>["state"],
  string
> = {
  active: "",
  inactive: " (inativo)",
  out_of_scope: " (fora do alcance)",
};

/** 'Responsável: Ana', com "(inativo)" ou "(fora do alcance)" pelo estado; sem responsável, "ninguém". */
export function handlerLabel(handler: TeamPendencyItem["handler"]): string {
  if (!handler) return "Responsável: ninguém";
  const name = handler.name ?? REMOVED_USER_LABEL;
  return `Responsável: ${name}${HANDLER_STATE_SUFFIX[handler.state]}`;
}

const MEDIA_LABEL: Record<string, string> = {
  audio: "Áudio",
  image: "Imagem",
  file: "Arquivo",
};

/** A última resposta: o texto; sem texto, a mídia só pelo tipo (nunca o conteúdo); sem nada, "(Mensagem sem texto)". */
export function replyLabel(
  reply: NonNullable<TeamPendencyItem["lastReply"]>,
): string {
  if (reply.text !== null && reply.text.trim() !== "") return reply.text;
  return (
    (reply.media !== null && MEDIA_LABEL[reply.media]) || "(Mensagem sem texto)"
  );
}

const NOTE_PREFIX: Record<string, string> = {
  CONTACT: "Contato: ",
  ASSUME: "Ao assumir: ",
  CLOSE: "Encerramento: ",
  HANDOVER: "Passagem de turno: ",
};

/** '{dd/MM HH:mm} · {autor} · {prefixo}{texto}'; tipo desconhecido sai sem prefixo. */
export function noteLine(note: TeamPendencyItem["notes"][number]): string {
  const author = note.authorName ?? REMOVED_USER_LABEL;
  const prefix = NOTE_PREFIX[note.kind] ?? "";
  return `${manausTime(note.at)} · ${author} · ${prefix}${note.text}`;
}

export function closureLine(
  closure: NonNullable<TeamPendencyItem["closure"]>,
): string {
  return `Tratativa encerrada por ${closure.byName ?? REMOVED_USER_LABEL}: ${closure.reason}`;
}

/** 'dd/MM HH:mm' de um instante ISO, na hora de Manaus (o front não faz conta de fuso). */
export function manausTime(iso: string): string {
  return historyTime(iso);
}
