import { inspect } from 'node:util';
import { Logger } from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@prisma/client';
import { vi } from 'vitest';
import type {
  TeamAlertPanel,
  TeamAudiencePreview,
} from '../../schemas/contracts/team-whatsapp.schema';
import { ChatIngestService } from '../chat/chat-ingest.service';
import type { TeamAudienceRequest } from './dto/create-team-dispatch.dto';
import { TeamAlertAckService } from './team-alert-ack.service';
import { TeamAlertPanelService } from './team-alert-panel.service';
import { TeamAlertReminderService } from './team-alert-reminder.service';
import {
  FIRST_SHIFT,
  MINUTE,
  REFERENCE_DATE,
  noticeAt,
  type RecheckDeps,
} from './team-whatsapp.schedule-recheck.test-fixtures';
import {
  T08_CHECKED_AT,
  buildT08World,
  type T08World,
} from './team-whatsapp.t08.test-fixtures';
import { TeamRecipientTrackingService } from './tracking/team-recipient-tracking.service';

/**
 * Demonstração de T09 (Lote I, T10; DI16): o alerta urgente ponta a ponta
 * contra Postgres real, sobre o harness do Lote H (`buildT08World`). Reais:
 * criação (`TeamWhatsappService.dispatch`), processor, `ChatService`, a
 * INGESTÃO da resposta (`ChatIngestService.ingestMessages` com o rastreio real,
 * só Redis, filas e eventos falsos), ciência manual, painel e lembrete. Falsos:
 * a porta do provedor, a porta ao vivo, a fila em memória e a trilha. Nunca
 * WhatsApp de verdade. Não é spec: não roda sozinho.
 *
 * Tempo explícito (GI9): o alerta nasce em `T0` (o `createdAt` do banco é
 * regravado) e cada passo recebe a hora em minutos desde `T0`.
 */

/** Instante da criação do alerta: a hora da conferência da porta ao vivo do harness. */
export const T0 = T08_CHECKED_AT;
/** Instante `minutes` depois da criação do alerta. */
export const at = (minutes: number): Date =>
  new Date(T0.getTime() + minutes * MINUTE);
/** Aceite do provedor: 5 s depois do envio que saiu em `minutes`. */
const accepted = (minutes: number): Date =>
  new Date(at(minutes).getTime() + 5_000);

export const ALERT_TYPED = 'Cano estourado no galpão 3, desliguem as máquinas';
export const ALERT_REASON = 'Vazamento de água';
export const MANUAL_NOTE = 'Confirmou por telefone às 11h';
export const REPLY_UNCLEAR = 'não entendi';
export const REPLY_LATE_OK = 'Ok!';
export const ADMIN_NAME = 'Marta Gestora';

/** Telefone da pessoa semeada (o `seedPerson` sempre grava um). */
export function phoneOf(person: User): string {
  if (!person.phoneE164) throw new Error('pessoa semeada sem telefone');
  return person.phoneE164;
}

/** Nome da pessoa semeada (o `seedPerson` sempre grava um). */
function nameOf(person: User): string {
  if (!person.name) throw new Error('pessoa semeada sem nome');
  return person.name;
}

/**
 * A pessoa ganha um `Contact` ligado ao usuário: o processor grava o contato
 * da conversa no destinatário, e a ingestão casa a resposta por esse contato.
 */
async function seedContacts(
  prisma: PrismaClient,
  people: readonly User[],
): Promise<void> {
  for (const person of people) {
    const contact = await prisma.contact.create({
      data: { phoneE164: phoneOf(person), name: nameOf(person), tags: [] },
    });
    await prisma.user.update({
      where: { id: person.id },
      data: { contactId: contact.id },
    });
  }
}

/** Rastreio real, com uma falha armável: a próxima resposta o encontra fora do ar (best-effort, I4). */
function faultyTracking(prisma: PrismaClient) {
  const real = new TeamRecipientTrackingService(prisma as never);
  const fault = { armed: false };
  const tracking = {
    applyReply: (input: Parameters<typeof real.applyReply>[0]) => {
      if (!fault.armed) return real.applyReply(input);
      fault.armed = false;
      return Promise.reject(new Error('rastreio fora do ar'));
    },
  };
  return { tracking, arm: () => void (fault.armed = true) };
}

/** A ingestão de verdade, com Redis, filas, eventos, consentimento e links falsos. */
function buildIngest(prisma: PrismaClient) {
  const redis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const wa = { fetchProfilePictureUrl: vi.fn().mockResolvedValue(null) };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const consent = { isSuppressed: vi.fn().mockResolvedValue(false) };
  const links = { matchInbound: vi.fn().mockResolvedValue(null) };
  const ingest = new ChatIngestService(
    prisma as never,
    wa as never,
    events as never,
    redis as never,
    queue as never,
    queue as never,
    consent as never,
    links as never,
  );
  // `teamTracking` é injetado por propriedade no Nest; aqui, à mão.
  const { tracking, arm } = faultyTracking(prisma);
  Object.assign(ingest, { teamTracking: tracking });
  return { ingest, failNextTracking: arm };
}

let replySeq = 0;

/**
 * `reply(pessoa, texto, hora)`: a mensagem de texto que a pessoa manda ao
 * número, pela ingestão real. Devolve o id da `Message` gravada.
 */
function replier(deps: RecheckDeps, channelId: string) {
  const { ingest, failNextTracking } = buildIngest(deps.prisma);
  const reply = async (
    person: User,
    text: string,
    receivedAt: Date,
  ): Promise<string> => {
    const phone = phoneOf(person);
    const providerMessageId = `wamid-resposta-${++replySeq}`;
    const persisted = await ingest.ingestMessages(
      [
        {
          providerMessageId,
          remoteJid: `${phone.slice(1)}@s.whatsapp.net`,
          phoneE164: phone,
          isGroup: false,
          fromMe: false,
          kind: 'TEXT',
          text,
          receivedAt,
          transcript: null,
        },
      ],
      channelId,
    );
    if (persisted !== 1) throw new Error('a resposta não foi gravada');
    const row = await deps.prisma.message.findUniqueOrThrow({
      where: { providerMessageId },
      select: { id: true },
    });
    return row.id;
  };
  return { reply, failNextTracking };
}

/** O alerta enviado: a prévia que a revisão mostrou e o destinatário de cada pessoa. */
export type Alert = {
  id: string;
  review: TeamAudiencePreview;
  ana: string;
  bia: string;
};

/** Urgência com motivo, "agora", só para as duas pessoas (seleção nominal). */
function urgencyRequest(
  w: T08World,
  people: readonly User[],
): TeamAudienceRequest {
  return noticeAt(w.site, {
    purpose: 'urgency',
    when: 'now',
    at: undefined,
    urgencyReason: ALERT_REASON,
    text: ALERT_TYPED,
    target: {
      type: 'sector',
      sectorIds: [w.site.sectorId],
      shiftIds: [FIRST_SHIFT],
      date: REFERENCE_DATE,
      userIds: people.map((p) => p.id),
    },
  });
}

/**
 * O processor grava o aceite do destinatário com o relógio real; o cenário o
 * põe na hora dele, para a resposta (sempre depois do aceite) casar (GI9).
 */
async function stampAcceptedAt(
  prisma: PrismaClient,
  where: Prisma.TeamWhatsappRecipientWhereInput,
  acceptedAt: Date,
): Promise<void> {
  await prisma.teamWhatsappRecipient.updateMany({
    where: { ...where, acceptedAt: { not: null } },
    data: { acceptedAt },
  });
}

/** Pelo caminho da tela (prévia e confirmação) e com o provedor aceitando os dois envios. */
async function sendAlert(w: T08World, people: readonly User[]): Promise<Alert> {
  const { deps, site } = w;
  const request = urgencyRequest(w, people);
  const review = await deps.audience.preview(site.adminId, request);
  const sent = await deps.service.dispatch(site.adminId, {
    ...request,
    audienceKey: review.audienceKey,
  });
  // O `createdAt` do banco é o relógio real; o alerta nasce em T0.
  await deps.prisma.teamWhatsappDispatch.update({
    where: { id: sent.dispatchId },
    data: { createdAt: T0 },
  });
  await w.queue.drain(w.processor);
  const where = { dispatchId: sent.dispatchId };
  await stampAcceptedAt(deps.prisma, where, accepted(0));
  const [ana, bia] = await w.recipients(sent.dispatchId);
  return { id: sent.dispatchId, review, ana: ana.id, bia: bia.id };
}

/** Roda a fila (o processor decide cada lembrete); o aceite dos lembretes vai para `minutes` + 5 s. */
async function deliverReminders(
  w: T08World,
  alertId: string,
  minutes: number,
): Promise<void> {
  await w.queue.drain(w.processor);
  const where = { dispatch: { parentDispatchId: alertId } };
  await stampAcceptedAt(w.deps.prisma, where, accepted(minutes));
}

/** Os serviços do alerta, de verdade, sobre o mesmo banco e a mesma fila do mundo. */
function alertServices(w: T08World) {
  const { deps } = w;
  const reminder = new TeamAlertReminderService(
    deps.repo,
    deps.prisma as never,
    deps.audit as never,
    w.queue as never,
  );
  // `live` e `consent` são injetados por propriedade no Nest; aqui, à mão.
  const consent = { isSuppressed: vi.fn().mockResolvedValue(false) };
  Object.assign(reminder, { live: w.live, consent });
  return {
    reminder,
    ack: new TeamAlertAckService(
      deps.repo,
      deps.prisma as never,
      deps.audit as never,
    ),
    panel: new TeamAlertPanelService(deps.repo, deps.prisma as never),
  };
}

/** Colunas de ciência e resposta do destinatário, como o banco as guarda. */
const ackColumns = (prisma: PrismaClient, id: string) =>
  prisma.teamWhatsappRecipient.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      ackAt: true,
      ackKind: true,
      ackByUserId: true,
      ackNote: true,
      ackMessageId: true,
      ackMessageAt: true,
      lastReplyMessageId: true,
    },
  });

/** O alerta como foi gravado. */
const storedAlert = (prisma: PrismaClient, id: string) =>
  prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id },
    select: {
      purpose: true,
      urgencyReason: true,
      text: true,
      ackDeadlineMinutes: true,
      createdAt: true,
    },
  });

/** Textos enviados pelo número, na ordem em que as mensagens foram criadas. */
async function outboundTexts(
  prisma: PrismaClient,
  channelId: string,
): Promise<string[]> {
  const rows = await prisma.message.findMany({
    where: { instanceId: channelId, direction: 'OUTBOUND' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { content: true },
  });
  return rows.map((row) => row.content ?? '');
}

/**
 * O mundo da demonstração: o do Lote H (setor com número EVOLUTION, ADMIN, Ana,
 * Bia e Caio) em que só Ana e Bia entram no alerta. O ADMIN ganha nome (o painel
 * o mostra na ciência manual) e a trilha começa vazia.
 */
export async function buildT09World(deps: RecheckDeps) {
  const w = await buildT08World(deps);
  const [ana, bia] = w.people;
  await seedContacts(deps.prisma, [ana, bia]);
  const adminId = w.site.adminId;
  await deps.prisma.user.update({
    where: { id: adminId },
    data: { name: ADMIN_NAME },
  });
  deps.audit.log.mockClear();
  const svc = alertServices(w);
  const { reply, failNextTracking } = replier(deps, w.channelId);
  return {
    ...w,
    ana,
    bia,
    /** Prévia, confirmação e envio do alerta às duas pessoas. */
    sendAlert: () => sendAlert(w, [ana, bia]),
    /** A pessoa responde ao número pela ingestão real; devolve o id da `Message`. */
    reply,
    /** O rastreio da próxima resposta cai (a mensagem é gravada; a ciência não). */
    failNextTracking,
    panel: (alertId: string): Promise<TeamAlertPanel> =>
      svc.panel.getPanel(adminId, alertId),
    /** Lembrete do ADMIN `minutes` depois do alerta; só enfileira. */
    remind: (alertId: string, recipientIds: string[], minutes: number) =>
      svc.reminder.send(adminId, alertId, { recipientIds }, at(minutes)),
    /** O lembrete sai (ou é pulado) pelo processor. */
    deliverReminders: (alertId: string, minutes: number) =>
      deliverReminders(w, alertId, minutes),
    markManual: (alertId: string, recipientId: string, minutes: number) =>
      svc.ack.markManual(adminId, alertId, recipientId, {
        note: MANUAL_NOTE,
        now: at(minutes),
      }),
    undoManual: (alertId: string, recipientId: string) =>
      svc.ack.undoManual(adminId, alertId, recipientId),
    ackColumns: (recipientId: string) => ackColumns(deps.prisma, recipientId),
    storedAlert: (alertId: string) => storedAlert(deps.prisma, alertId),
    outboundTexts: () => outboundTexts(deps.prisma, w.channelId),
  };
}
export type T09World = Awaited<ReturnType<typeof buildT09World>>;

// ---------------------------------------------------------------------------
// Trilha e log (aceite 15)
// ---------------------------------------------------------------------------

const LOG_LEVELS = [
  'log',
  'warn',
  'error',
  'debug',
  'verbose',
  'fatal',
] as const;

/** Sem as linhas de pilha do erro: elas trazem caminhos de arquivo, não o que o log disse. */
const withoutStackLines = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('at '))
    .join('\n');

/**
 * Espia todo `Logger` do Nest; `stop()` o solta e devolve tudo o que ele recebeu
 * (o restore zera as chamadas, então o texto é tirado antes).
 */
export function watchLogger() {
  const spies = LOG_LEVELS.map((level) => vi.spyOn(Logger.prototype, level));
  return {
    stop: (): string => {
      const shown = inspect(
        spies.map((s) => s.mock.calls),
        { depth: 8 },
      );
      spies.forEach((s) => s.mockRestore());
      return withoutStackLines(shown);
    },
  };
}

/** Tudo o que a trilha (`AuditService`) recebeu desde que o mundo foi montado, e as ações. */
export function trailOf(deps: RecheckDeps) {
  const calls = deps.audit.log.mock.calls as unknown[][];
  return {
    actions: calls.map((call) => call[0]),
    text: inspect(calls, { depth: 8 }),
  };
}

/** O que nenhuma trilha nem log pode conter: textos, observação, nomes e telefones. */
export function secretsOf(w: T09World): string[] {
  const phones = [phoneOf(w.ana), phoneOf(w.bia)];
  return [
    ALERT_TYPED,
    ALERT_REASON,
    MANUAL_NOTE,
    REPLY_UNCLEAR,
    REPLY_LATE_OK,
    ADMIN_NAME,
    nameOf(w.ana),
    nameOf(w.bia),
    ...phones,
    ...phones.map((phone) => phone.slice(1)),
  ];
}
