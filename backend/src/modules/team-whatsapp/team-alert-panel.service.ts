import { Injectable } from '@nestjs/common';
import type { TeamAlertPanel } from '../../schemas/contracts/team-whatsapp.schema';
import { nameView } from '../../shared/authz/phone-visibility';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { requireViewable } from './team-alert-access';
import {
  factsOf,
  loadAlertHeader,
  loadAlertMessages,
  loadAlertPeople,
  loadAlertReminders,
  loadUserNames,
  type AlertHeader,
  type AlertPersonRow,
  type AlertReminderRow,
  type AlertReplyMessage,
} from './team-alert.repository';
import {
  MAX_REMINDERS,
  REMINDER_INTERVAL_MS,
  alertDeadlineAt,
  alertGroupOf,
  bestStatusOf,
  reminderEligibility,
  type AlertGroup,
} from './team-alert.rules';
import { teamForbidden } from './team-whatsapp.errors';
import { seesFullPhone } from './team-whatsapp.name-view';
import { isTeamSender } from './team-whatsapp.policy';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

export type { TeamAlertPanel } from '../../schemas/contracts/team-whatsapp.schema';

type PanelPerson = TeamAlertPanel['people'][number];

/** Ordem dos grupos na spec (I6): Sem entrega, Sem resposta, Respondeu sem ciência, Ciente. */
const GROUP_ORDER: readonly AlertGroup[] = [
  'no_delivery',
  'no_reply',
  'replied',
  'acked',
];

const collator = new Intl.Collator('pt-BR');

/** O que a montagem do painel lê do banco, já carregado. */
type PanelData = {
  header: AlertHeader;
  people: readonly AlertPersonRow[];
  messages: ReadonlyMap<string, AlertReplyMessage>;
  reminders: readonly AlertReminderRow[];
  names: ReadonlyMap<string, string | null>;
  /** O ator tem `telefone.ver_completo`: os nomes saem sem máscara (D11). */
  full: boolean;
};

/**
 * Painel de pendências do alerta (I6, DI9). Ver o painel não exige a chave da
 * urgência (I1): basta ver o envio. Nada aqui depende do relógio; o rótulo
 * "Pendente · há N min" e o "vencido" são do front, sobre `ackDeadlineAt`.
 */
@Injectable()
export class TeamAlertPanelService {
  constructor(
    private readonly repo: TeamWhatsappRepository,
    private readonly prisma: PrismaService,
  ) {}

  /** findActor → remetente (403) → requireViewable (404) → cabeçalho (422) → pessoas. */
  async getPanel(actorId: string, dispatchId: string): Promise<TeamAlertPanel> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !isTeamSender(actor)) throw teamForbidden();
    await requireViewable(this.repo, actor, dispatchId);
    const header = await loadAlertHeader(this.prisma, dispatchId);
    const people = await loadAlertPeople(this.prisma, dispatchId);
    const [messages, reminders] = await Promise.all([
      loadAlertMessages(this.prisma, messageIdsOf(people)),
      loadAlertReminders(this.prisma, dispatchId),
    ]);
    const names = await loadUserNames(this.prisma, [
      ...people.flatMap((p) => (p.ackByUserId ? [p.ackByUserId] : [])),
      ...reminders.flatMap((r) => (r.authorId ? [r.authorId] : [])),
    ]);
    const full = seesFullPhone(actor);
    return buildPanel({ header, people, messages, reminders, names, full });
  }
}

function messageIdsOf(people: readonly AlertPersonRow[]): string[] {
  return people.flatMap((p) =>
    [p.ackMessageId, p.lastReplyMessageId].filter(
      (id): id is string => id !== null,
    ),
  );
}

function buildPanel(data: PanelData): TeamAlertPanel {
  const { header } = data;
  const deadline = alertDeadlineAt(header.createdAt, header.ackDeadlineMinutes);
  const people = sortPeople(
    data.people.map((p) => personView(p, data, deadline)),
  );
  const countOf = (group: AlertGroup) =>
    people.filter((p) => p.group === group).length;
  return {
    dispatchId: header.id,
    createdAt: header.createdAt.toISOString(),
    ackDeadlineMinutes: header.ackDeadlineMinutes,
    ackDeadlineAt: deadline.toISOString(),
    counts: {
      noDelivery: countOf('no_delivery'),
      noReply: countOf('no_reply'),
      replied: countOf('replied'),
      acked: countOf('acked'),
    },
    people,
    reminders: {
      count: header.reminderCount,
      max: MAX_REMINDERS,
      nextAllowedAt: nextAllowedAt(header),
      items: data.reminders.map((r) => ({
        dispatchId: r.id,
        createdAt: r.createdAt.toISOString(),
        authorName: viewedName(data, r.authorId),
        recipients: r.recipients,
      })),
    },
  };
}

/** `(lastReminderAt ?? createdAt) + 5 min`; `null` depois do último lembrete permitido. */
function nextAllowedAt(header: AlertHeader): string | null {
  if (header.reminderCount >= MAX_REMINDERS) return null;
  const since = header.lastReminderAt ?? header.createdAt;
  return new Date(since.getTime() + REMINDER_INTERVAL_MS).toISOString();
}

function personView(
  row: AlertPersonRow,
  data: PanelData,
  deadline: Date,
): PanelPerson {
  const facts = factsOf(row);
  const { eligible, mayHaveReceived } = reminderEligibility(facts);
  return {
    recipientId: row.id,
    userName: nameView(row.userName, { full: data.full }),
    group: alertGroupOf(facts),
    status: bestStatusOf(facts.statuses),
    ack: ackView(row, data, deadline),
    ackReply: messageView(data.messages, row.ackMessageId),
    lastReply: messageView(data.messages, row.lastReplyMessageId),
    eligible,
    mayHaveReceived,
  };
}

/** Ciência "após o prazo" = `ackAt > ackDeadlineAt` (DI4); autor só na manual. */
function ackView(
  row: AlertPersonRow,
  data: PanelData,
  deadline: Date,
): PanelPerson['ack'] {
  if (row.ackAt === null) return null;
  const manual = row.ackKind === 'MANUAL';
  return {
    at: row.ackAt.toISOString(),
    kind: manual ? 'manual' : 'keyword',
    late: row.ackAt.getTime() > deadline.getTime(),
    byName: manual ? viewedName(data, row.ackByUserId) : null,
    note: row.ackNote,
  };
}

/** `Message` apagada (ou nunca gravada) → `null`. */
function messageView(
  messages: ReadonlyMap<string, AlertReplyMessage>,
  id: string | null,
): PanelPerson['ackReply'] {
  const message = id === null ? undefined : messages.get(id);
  if (!message) return null;
  return {
    text: message.content,
    kind: message.kind,
    at: message.at.toISOString(),
  };
}

function viewedName(data: PanelData, userId: string | null): string | null {
  if (userId === null) return null;
  return nameView(data.names.get(userId) ?? null, { full: data.full });
}

/**
 * Por grupo, na ordem da spec, e pelo nome EXIBIDO (com a chave, é o real);
 * nomes exibidos iguais desempatam pelo id, nunca pela ordem do nome real.
 */
function sortPeople(people: PanelPerson[]): PanelPerson[] {
  return [...people].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      collator.compare(a.userName, b.userName) ||
      collator.compare(a.recipientId, b.recipientId),
  );
}
