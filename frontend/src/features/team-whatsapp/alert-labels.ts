import { POLL_INTERVAL_MS } from "./api";
import type {
  AlertAck,
  AlertClosure,
  AlertGroup,
  AlertMessage,
  AlertPerson,
  AlertReminder,
  TeamAlertPanel,
} from "./alert-schemas";
import { manausDateTime } from "./labels";

/** Rótulo de cada grupo do painel (I6). */
export const GROUP_LABEL: Record<AlertGroup, string> = {
  no_delivery: "Sem entrega",
  no_reply: "Sem resposta",
  replied: "Respondeu, sem ciência",
  acked: "Ciente",
};

const MINUTE_MS = 60_000;

/** Depois de 2 horas do alerta o painel deixa de ser relido (DI15). */
const ALERT_POLL_WINDOW_MS = 2 * 60 * MINUTE_MS;

const isExpired = (panel: TeamAlertPanel, now: Date): boolean =>
  now.getTime() >= Date.parse(panel.ackDeadlineAt);

/** "Ciente às 09:05", "Ciente (manual, após o prazo) às 09:20": a hora da ciência em Manaus. */
function ackedLabel({ at, kind, late }: AlertAck): string {
  const tags = [
    kind === "manual" ? "manual" : null,
    late ? "após o prazo" : null,
  ].filter(Boolean);
  const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
  return `Ciente${suffix} às ${manausDateTime(at).time}`;
}

/** Sem ciência: "há N min" (minutos inteiros desde a criação) até o prazo e "prazo vencido" depois. */
function pendingLabel(panel: TeamAlertPanel, now: Date): string {
  if (isExpired(panel, now)) return "Pendente — prazo vencido";
  const minutes = Math.floor(
    (now.getTime() - Date.parse(panel.createdAt)) / MINUTE_MS,
  );
  return minutes < 1
    ? "Pendente · há menos de 1 min"
    : `Pendente · há ${minutes} min`;
}

/** Rótulo da ciência ao lado do nome (I6, DI15); o servidor decide quem é ciente, o front só escreve. */
export function ackLabel(
  person: AlertPerson,
  panel: TeamAlertPanel,
  now: Date,
): string {
  return person.ack ? ackedLabel(person.ack) : pendingLabel(panel, now);
}

/** `recipientId` → rótulo, para a coluna "Ciência" da tabela de destinatários. */
export function ackLabelMap(
  panel: TeamAlertPanel | undefined,
  now: Date,
): ReadonlyMap<string, string> {
  if (!panel) return new Map();
  return new Map(
    panel.people.map((p) => [p.recipientId, ackLabel(p, panel, now)]),
  );
}

/** "Prazo de ciência: 15 min": o prazo sozinho (célula do histórico) e a frente do cabeçalho do painel. */
export const deadlineNote = (minutes: number): string =>
  `Prazo de ciência: ${minutes} min`;

/** "Prazo de ciência: 15 min — vence às 09:15" antes do prazo; "— vencido às 09:15" depois (Manaus). */
export function deadlineText(panel: TeamAlertPanel, now: Date): string {
  const verb = isExpired(panel, now) ? "vencido" : "vence";
  const { time } = manausDateTime(panel.ackDeadlineAt);
  return `${deadlineNote(panel.ackDeadlineMinutes)} — ${verb} às ${time}`;
}

/** O que a mensagem é quando não tem texto: áudio, figurinha, imagem sem legenda, reação etc. */
const NO_TEXT_LABEL: ReadonlyMap<string, string> = new Map([
  ["AUDIO", "(Áudio)"],
  ["IMAGE", "(Imagem)"],
  ["VIDEO", "(Vídeo)"],
  ["STICKER", "(Figurinha)"],
  ["DOCUMENT", "(Documento)"],
]);

/** Texto da resposta; sem texto, o tipo entre parênteses. */
export function replyText({ text, kind }: AlertMessage): string {
  if (text !== null && text.trim() !== "") return text;
  return NO_TEXT_LABEL.get(kind) ?? "(Mensagem sem texto)";
}

/** "Obs.: confirmou por ligação — Ana": a observação da ciência manual e quem a registrou. */
function manualNote({ note, byName }: AlertAck): string | null {
  if (!note) return null;
  return byName ? `Obs.: ${note} — ${byName}` : `Obs.: ${note}`;
}

const isLine = (line: string | null): line is string => line !== null;

/**
 * Linhas abaixo do nome (DI15): ciência automática = a mensagem que a deu; manual = observação e autor e, se houver, a
 * última resposta; sem ciência = a última resposta.
 */
export function personDetails({
  ack,
  ackReply,
  lastReply,
}: AlertPerson): string[] {
  if (ack?.kind === "manual") {
    return [manualNote(ack), lastReply ? replyText(lastReply) : null].filter(
      isLine,
    );
  }
  const reply = ack ? ackReply : lastReply;
  return reply ? [replyText(reply)] : [];
}

/** "Tratativa encerrada por Ana: falou por ligação" (K2-2); usuário removido (DK18); sem encerramento, nada. */
export function closureText(
  closure: AlertClosure | null | undefined,
): string | null {
  if (!closure) return null;
  return `Tratativa encerrada por ${closure.byName ?? "Usuário removido"}: ${closure.reason}`;
}

/** "09:05 · Ana · 3 pessoas": um lembrete do alerta (hora em Manaus). */
export function reminderText({
  createdAt,
  authorName,
  recipients,
}: AlertReminder): string {
  const people = recipients === 1 ? "1 pessoa" : `${recipients} pessoas`;
  return [manausDateTime(createdAt).time, authorName ?? "—", people].join(
    " · ",
  );
}

/** Intervalo de leitura do painel: a cada 10 s com alguém sem ciência e o alerta com menos de 2 horas. */
export function alertPollInterval(
  panel: TeamAlertPanel | undefined,
  now: Date,
): number | false {
  if (!panel) return false;
  const { noDelivery, noReply, replied } = panel.counts;
  const recent =
    now.getTime() - Date.parse(panel.createdAt) < ALERT_POLL_WINDOW_MS;
  return noDelivery + noReply + replied > 0 && recent
    ? POLL_INTERVAL_MS
    : false;
}

/** "Lembrete do alerta de 20/11 09:00": o lembrete na lista do histórico e no cabeçalho do resultado (I7, DI12). */
export function reminderOfText({ createdAt }: { createdAt: string }): string {
  const { dayMonth, time } = manausDateTime(createdAt);
  return `Lembrete do alerta de ${dayMonth} ${time}`;
}
