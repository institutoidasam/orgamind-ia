import type { MessageKind, TeamWhatsappRecipientStatus } from '@prisma/client';

/**
 * Regras puras do alerta urgente (Lote I: I2 a I7; DI3, DI4, DI5, DI8).
 * Sem banco, sem relógio, sem provedor: quem chama passa os fatos.
 */

/** Prazo de ciência gravado no alerta (DI4); o front espelha a constante. */
export const ALERT_ACK_DEADLINE_MINUTES = 15;
/** Linha fixa do alerta (DI3). */
export const ALERT_CONFIRM_LINE = 'Responda OK para confirmar que recebeu.';
/** Sufixo gravado no texto: linha em branco e a linha fixa (41 caracteres). */
export const ALERT_CONFIRM_SUFFIX = `\n\n${ALERT_CONFIRM_LINE}`;
export const REMINDER_PREFIX = 'Lembrete: ';
export const MAX_REMINDERS = 3;
export const REMINDER_INTERVAL_MS = 5 * 60_000;
/** Resposta que conta como ciência chega em até 24 h do aceite (inclusive). */
export const ACK_REPLY_WINDOW_MS = 24 * 3_600_000;

/** Texto gravado do alerta: o do usuário, sem aparar, mais a linha fixa. */
export function alertText(text: string): string {
  return text + ALERT_CONFIRM_SUFFIX;
}

/** Texto do lembrete: o prefixo e o texto gravado do alerta. */
export function reminderText(alertText: string): string {
  return REMINDER_PREFIX + alertText;
}

const ACK_WORDS: ReadonlySet<string> = new Set([
  'ok',
  'ciente',
  'confirmo',
  'recebido',
]);
/** Joinha com ou sem modificador de tom de pele (U+1F3FB a U+1F3FF). */
const THUMBS_UP = /^👍[\u{1F3FB}-\u{1F3FF}]?$/u;
const NOISE_CHAR = /[\s\p{P}]/u;

/**
 * Apara espaço e pontuação nas pontas (o equivalente a `/^[\s\p{P}]+|[\s\p{P}]+$/gu`,
 * que o Sonar recusa por backtracking quadrático em texto longo de pontuação).
 */
function trimNoise(text: string): string {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && NOISE_CHAR.test(chars[start])) start += 1;
  while (end > start && NOISE_CHAR.test(chars[end - 1])) end -= 1;
  return chars.slice(start, end).join('');
}

/** Sem acento (e sem o seletor de variação U+FE0F), sem pontas e em minúsculas. */
function normalizeAck(text: string): string {
  return trimNoise(text.normalize('NFD').replace(/\p{M}/gu, '')).toLowerCase();
}

/**
 * Ciência automática (DI5): só mensagem de texto cujo conteúdo inteiro é uma
 * palavra de ciência. Mídia, áudio, figurinha e reação são resposta, nunca ciência.
 */
export function isAckWord(m: {
  kind: MessageKind;
  text: string | null;
}): boolean {
  if (m.kind !== 'TEXT' || m.text === null) return false;
  const normalized = normalizeAck(m.text);
  return ACK_WORDS.has(normalized) || THUMBS_UP.test(normalized);
}

/** A resposta chegou em até 24 h do aceite (inclusive). */
export function withinReplyWindow(acceptedAt: Date, receivedAt: Date): boolean {
  return receivedAt.getTime() - acceptedAt.getTime() <= ACK_REPLY_WINDOW_MS;
}

export type AlertGroup = 'no_delivery' | 'no_reply' | 'replied' | 'acked';

/** `statuses`: estado do original primeiro, depois os dos lembretes. */
export type AlertPersonFacts = {
  ackAt: Date | null;
  lastReplyMessageId: string | null;
  statuses: readonly TeamWhatsappRecipientStatus[];
};

const DELIVERED_STATUSES: readonly TeamWhatsappRecipientStatus[] = [
  'SENT',
  'DELIVERED',
  'READ',
];

/** Grupo da pessoa no painel (I6, DI8); o lembrete e a ciência manual usam esta função. */
export function alertGroupOf(f: AlertPersonFacts): AlertGroup {
  if (f.ackAt !== null) return 'acked';
  if (f.lastReplyMessageId !== null || f.statuses.includes('REPLIED')) {
    return 'replied';
  }
  if (f.statuses.some((s) => DELIVERED_STATUSES.includes(s))) return 'no_reply';
  return 'no_delivery';
}

const STATUS_ORDER: readonly TeamWhatsappRecipientStatus[] = [
  'REPLIED',
  'READ',
  'DELIVERED',
  'SENT',
  'UNCERTAIN',
  'QUEUED',
  'SCHEDULED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
];

/** Melhor estado de entrega (exibição): o primeiro presente na ordem de DI8. */
export function bestStatusOf(
  statuses: readonly TeamWhatsappRecipientStatus[],
): TeamWhatsappRecipientStatus {
  const best = STATUS_ORDER.find((s) => statuses.includes(s));
  if (best === undefined) throw new RangeError('statuses vazio');
  return best;
}

/**
 * Elegível ao lembrete (I7, DI8): sem ciência, em `no_reply` ou `replied`; ou
 * em `no_delivery` com `UNCERTAIN` ("pode já ter recebido"). Falhou, pulado,
 * na fila, agendado ou cancelado, sem incerto, não entra.
 */
export function reminderEligibility(f: AlertPersonFacts): {
  eligible: boolean;
  mayHaveReceived: boolean;
} {
  const group = alertGroupOf(f);
  if (group === 'no_reply' || group === 'replied') {
    return { eligible: true, mayHaveReceived: false };
  }
  if (group === 'no_delivery' && f.statuses.includes('UNCERTAIN')) {
    return { eligible: true, mayHaveReceived: true };
  }
  return { eligible: false, mayHaveReceived: false };
}

/** Vencimento da ciência: `createdAt` mais os minutos gravados no alerta (DI4). */
export function alertDeadlineAt(createdAt: Date, minutes: number): Date {
  return new Date(createdAt.getTime() + minutes * 60_000);
}

/**
 * Recusa de lembrete (I7): o limite vem antes do intervalo; os 5 minutos
 * contam do último lembrete ou, sem lembrete, da criação do alerta.
 */
export function reminderBlock(i: {
  reminderCount: number;
  lastReminderAt: Date | null;
  alertCreatedAt: Date;
  now: Date;
}): 'reminder_limit' | 'reminder_too_soon' | null {
  if (i.reminderCount >= MAX_REMINDERS) return 'reminder_limit';
  const since = i.lastReminderAt ?? i.alertCreatedAt;
  if (i.now.getTime() < since.getTime() + REMINDER_INTERVAL_MS) {
    return 'reminder_too_soon';
  }
  return null;
}
