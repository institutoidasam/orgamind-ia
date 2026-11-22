import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type MessageKind, type Prisma } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../../test/migrations';
import { TeamRecipientTrackingService } from './team-recipient-tracking.service';

// Ciência automática pela resposta (Lote I, T5: I4, DI5, DI6; aceites 6 a 9,
// 14, 17 e 22). Respostas simuladas: Message INBOUND gravada antes de cada
// applyReply, sem provedor.
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

const ACCEPTED = new Date('2026-11-10T12:00:00Z');
const after = (minutes: number) =>
  new Date(ACCEPTED.getTime() + minutes * 60_000);
const RECEIVED = after(5);
const NO_ACK = {
  ackAt: null,
  ackKind: null,
  ackMessageId: null,
  ackMessageAt: null,
};
const UNTOUCHED = { ...NO_ACK, lastReplyMessageId: null };
const MANUAL_ACK = {
  ackAt: after(3),
  ackKind: 'MANUAL',
  ackByUserId: 'u-1',
  ackNote: 'Confirmou por ligação',
} as const;

type SeedInput = Partial<Prisma.TeamWhatsappRecipientUncheckedCreateInput>;
type ReplyOpts = { kind?: MessageKind; at?: Date; contactIds?: string[] };

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let svc: TeamRecipientTrackingService;
let seq = 0;

/** Destinatário do alerta (por padrão) aceito em ACCEPTED, com contato próprio. */
async function seed(
  o: SeedInput = {},
): Promise<{ id: string; contactId: string }> {
  seq += 1;
  const row = await prisma.teamWhatsappRecipient.create({
    data: {
      dispatchId: 'd-alert',
      userName: `Pessoa ${seq}`,
      status: 'SENT',
      messageId: `m-${seq}`,
      channelId: 'ch-x',
      contactId: `c-${seq}`,
      acceptedAt: ACCEPTED,
      ...o,
    },
    select: { id: true, contactId: true },
  });
  return { id: row.id, contactId: row.contactId ?? '' };
}

async function inbound(kind: MessageKind, text: string | null, at: Date) {
  const row = await prisma.message.create({
    data: {
      instanceId: 'ch-x',
      direction: 'INBOUND',
      status: 'RECEIVED',
      kind,
      content: text,
      receivedAt: at,
    },
    select: { id: true },
  });
  return { id: row.id, kind, text };
}

async function reply(
  contactId: string,
  text: string | null,
  o: ReplyOpts = {},
) {
  const receivedAt = o.at ?? RECEIVED;
  const message = await inbound(o.kind ?? 'TEXT', text, receivedAt);
  const marked = await svc.applyReply({
    channelId: 'ch-x',
    contactIds: o.contactIds ?? [contactId],
    receivedAt,
    message,
  });
  return { messageId: message.id, marked };
}

const readAck = (id: string) =>
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

// Réplica do desfazer da ciência manual (DI7, um único UPDATE) para provar a
// corrida com a gravação da resposta; o desfazer de verdade é de outra task.
const undoManual = (id: string) => prisma.$queryRaw`
  UPDATE "TeamWhatsappRecipient"
  SET "ackAt" = "ackMessageAt",
      "ackKind" = CASE WHEN "ackMessageAt" IS NOT NULL
        THEN 'KEYWORD'::"TeamAlertAckKind" ELSE NULL END,
      "ackByUserId" = NULL, "ackNote" = NULL
  WHERE id = ${id} AND "ackKind" = 'MANUAL'
  RETURNING "ackKind"`;

const dispatch = (
  id: string,
  over: Partial<Prisma.TeamWhatsappDispatchUncheckedCreateInput>,
) => ({
  id,
  targetType: 'SECTOR' as const,
  targetId: 's-1',
  targetLabel: 'Produção',
  text: 'aviso',
  ...over,
});

beforeAll(async () => {
  if (!ENABLED) return;
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  svc = new TeamRecipientTrackingService(prisma as never);
  await prisma.channel.create({ data: { id: 'ch-x', name: 'Número X' } });
  await prisma.teamWhatsappDispatch.create({
    data: dispatch('d-alert', { purpose: 'URGENCY', ackDeadlineMinutes: 15 }),
  });
  await prisma.teamWhatsappDispatch.createMany({
    data: [
      dispatch('d-reminder', {
        purpose: 'URGENCY',
        parentDispatchId: 'd-alert',
      }),
      dispatch('d-routine', { purpose: 'SHIFT_NOTICE' }),
      dispatch('d-meeting', { purpose: 'MEETING' }),
    ],
  });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

describe.skipIf(!ENABLED)('ciência pela palavra (aceites 6 e 7)', () => {
  it('aceite 6: OK — ciência KEYWORD com ackAt = receivedAt, ackMessageId, ackMessageAt = receivedAt e lastReplyMessageId; estado REPLIED', async () => {
    const alert = await seed();
    const r = await reply(alert.contactId, 'OK');
    expect(r.marked).toBe(alert.id);
    expect(await readAck(alert.id)).toEqual({
      status: 'REPLIED',
      ackAt: RECEIVED,
      ackKind: 'KEYWORD',
      ackByUserId: null,
      ackNote: null,
      ackMessageId: r.messageId,
      ackMessageAt: RECEIVED,
      lastReplyMessageId: r.messageId,
    });
  });

  it('aceite 7: não entendi seguido de Ok! — depois do 1º, Respondeu sem ciência com lastReply = não entendi; depois do 2º, ciente', async () => {
    const alert = await seed();
    const first = await reply(alert.contactId, 'não entendi');
    expect(await readAck(alert.id)).toMatchObject({
      status: 'REPLIED',
      ...NO_ACK,
      lastReplyMessageId: first.messageId,
    });
    const second = await reply(alert.contactId, 'Ok!', { at: after(8) });
    expect(await readAck(alert.id)).toMatchObject({
      ackAt: after(8),
      ackKind: 'KEYWORD',
      ackMessageId: second.messageId,
      lastReplyMessageId: second.messageId,
    });
  });
});

describe.skipIf(!ENABLED)('resposta que não é ciência (aceite 7)', () => {
  it('aceite 7: ok, mas não vou — sem ciência', async () => {
    const alert = await seed();
    const r = await reply(alert.contactId, 'ok, mas não vou');
    expect(await readAck(alert.id)).toMatchObject({
      status: 'REPLIED',
      ...NO_ACK,
      lastReplyMessageId: r.messageId,
    });
  });

  it.each([
    ['áudio', 'AUDIO', null],
    ['imagem com legenda ok', 'IMAGE', 'ok'],
    ['figurinha', 'STICKER', null],
    ['reação (UNSUPPORTED)', 'UNSUPPORTED', null],
  ] as const)(
    'aceite 7: %s — Respondeu, sem ciência',
    async (_name, kind, text) => {
      const alert = await seed();
      const r = await reply(alert.contactId, text, { kind });
      expect(await readAck(alert.id)).toMatchObject({
        status: 'REPLIED',
        ...NO_ACK,
        lastReplyMessageId: r.messageId,
      });
    },
  );
});

describe.skipIf(!ENABLED)(
  'destinatário mais recente e janela de 24 h (aceite 8)',
  () => {
    it('aceite 8: OK depois de um envio de rotina mais novo — rotina REPLIED, alerta sem mudança', async () => {
      const alert = await seed();
      const routine = await seed({
        dispatchId: 'd-routine',
        contactId: alert.contactId,
        acceptedAt: after(1),
      });
      const r = await reply(alert.contactId, 'OK');
      expect(r.marked).toBe(routine.id);
      expect(await readAck(routine.id)).toMatchObject({
        status: 'REPLIED',
        ...UNTOUCHED,
      });
      expect(await readAck(alert.id)).toMatchObject({
        status: 'SENT',
        ...UNTOUCHED,
      });
    });

    it('aceite 8: OK 25 h depois — só REPLIED, sem lastReplyMessageId', async () => {
      const alert = await seed();
      await reply(alert.contactId, 'OK', { at: after(25 * 60) });
      expect(await readAck(alert.id)).toMatchObject({
        status: 'REPLIED',
        ...UNTOUCHED,
      });
    });
  },
);

describe.skipIf(!ENABLED)('borda da janela, gêmeo e aceite (aceite 8)', () => {
  it('24 h exatas — ciente', async () => {
    const alert = await seed();
    await reply(alert.contactId, 'OK', { at: after(24 * 60) });
    expect(await readAck(alert.id)).toMatchObject({
      ackAt: after(24 * 60),
      ackKind: 'KEYWORD',
    });
  });

  it('aceite 8: OK de contato gêmeo (9º dígito) — ciente', async () => {
    const alert = await seed();
    const contactIds = ['c-gemeo-sem-9', alert.contactId];
    await reply('c-gemeo-sem-9', 'OK', { contactIds });
    expect(await readAck(alert.id)).toMatchObject({
      ackAt: RECEIVED,
      ackKind: 'KEYWORD',
    });
  });

  it('resposta anterior ao aceite — alerta sem mudança', async () => {
    const alert = await seed({ acceptedAt: after(10) });
    expect((await reply(alert.contactId, 'OK')).marked).toBeNull();
    expect(await readAck(alert.id)).toMatchObject({
      status: 'SENT',
      ...UNTOUCHED,
    });
  });
});

describe.skipIf(!ENABLED)('lembrete e situação incerta (aceite 9)', () => {
  const withReminder = async () => {
    const alert = await seed();
    const reminder = await seed({
      dispatchId: 'd-reminder',
      contactId: alert.contactId,
      acceptedAt: after(5),
      parentRecipientId: alert.id,
    });
    return { alert, reminder };
  };

  it('aceite 9: OK ao lembrete — ciência no original; lembrete REPLIED', async () => {
    const { alert, reminder } = await withReminder();
    const r = await reply(alert.contactId, 'OK', { at: after(10) });
    expect(r.marked).toBe(reminder.id);
    expect(await readAck(reminder.id)).toMatchObject({
      status: 'REPLIED',
      ...UNTOUCHED,
    });
    expect(await readAck(alert.id)).toMatchObject({
      status: 'SENT',
      ackAt: after(10),
      ackKind: 'KEYWORD',
      ackMessageId: r.messageId,
      lastReplyMessageId: r.messageId,
    });
  });

  it('aceite 9: não entendi ao lembrete — lastReplyMessageId no original', async () => {
    const { alert } = await withReminder();
    const r = await reply(alert.contactId, 'não entendi', { at: after(10) });
    expect(await readAck(alert.id)).toMatchObject({
      ...NO_ACK,
      lastReplyMessageId: r.messageId,
    });
  });

  it('aceite 9: OK de quem está UNCERTAIN sem recibo — alerta sem mudança', async () => {
    const alert = await seed({ status: 'UNCERTAIN', acceptedAt: null });
    expect((await reply(alert.contactId, 'OK')).marked).toBeNull();
    expect(await readAck(alert.id)).toMatchObject({
      status: 'UNCERTAIN',
      ...UNTOUCHED,
    });
  });
});

describe.skipIf(!ENABLED)(
  'reunião, já respondido e ciência já gravada (aceite 14)',
  () => {
    it('aceite 14: reunião com OK — só REPLIED', async () => {
      const meeting = await seed({ dispatchId: 'd-meeting' });
      await reply(meeting.contactId, 'OK');
      expect(await readAck(meeting.id)).toMatchObject({
        status: 'REPLIED',
        ...UNTOUCHED,
      });
    });

    it('já REPLIED: um OK seguinte ainda dá ciência', async () => {
      const alert = await seed({ status: 'REPLIED', repliedAt: after(1) });
      expect((await reply(alert.contactId, 'OK')).marked).toBeNull();
      expect(await readAck(alert.id)).toMatchObject({
        ackAt: RECEIVED,
        ackKind: 'KEYWORD',
      });
    });

    it('segundo OK depois da ciência — ackAt e ackMessageId não mudam; lastReplyMessageId muda', async () => {
      const alert = await seed();
      const first = await reply(alert.contactId, 'OK');
      const second = await reply(alert.contactId, 'Ciente.', { at: after(7) });
      expect(await readAck(alert.id)).toMatchObject({
        ackAt: RECEIVED,
        ackMessageId: first.messageId,
        ackMessageAt: RECEIVED,
        lastReplyMessageId: second.messageId,
      });
    });

    it('ciência manual já gravada: OK guarda ackMessageId e não mexe na ciência', async () => {
      const alert = await seed(MANUAL_ACK);
      const r = await reply(alert.contactId, 'OK');
      expect(await readAck(alert.id)).toMatchObject({
        ...MANUAL_ACK,
        ackMessageId: r.messageId,
        ackMessageAt: RECEIVED,
        lastReplyMessageId: r.messageId,
      });
    });
  },
);

describe.skipIf(!ENABLED)('corrida com a ciência manual (aceite 22)', () => {
  const replyNow = async (contactId: string) => {
    const message = await inbound('TEXT', 'OK', RECEIVED);
    const run = svc.applyReply({
      channelId: 'ch-x',
      contactIds: [contactId],
      receivedAt: RECEIVED,
      message,
    });
    return { message, run };
  };

  it('OK e ciência manual em paralelo — uma ciência só, coerente, e ackMessageId guardado', async () => {
    const alert = await seed();
    const { message, run } = await replyNow(alert.contactId);
    const [, manual] = await Promise.all([
      run,
      prisma.teamWhatsappRecipient.updateMany({
        where: { id: alert.id, ackAt: null },
        data: MANUAL_ACK,
      }),
    ]);
    const row = await readAck(alert.id);
    expect(row.ackMessageId).toBe(message.id);
    const keyword = { ackAt: RECEIVED, ackKind: 'KEYWORD', ackByUserId: null };
    expect(row).toMatchObject(manual.count === 1 ? MANUAL_ACK : keyword);
  });

  it('OK durante o desfazer da manual — ciência automática', async () => {
    const alert = await seed(MANUAL_ACK);
    const { message, run } = await replyNow(alert.contactId);
    await Promise.all([run, undoManual(alert.id)]);
    expect(await readAck(alert.id)).toMatchObject({
      ackAt: RECEIVED,
      ackKind: 'KEYWORD',
      ackByUserId: null,
      ackNote: null,
      ackMessageId: message.id,
      ackMessageAt: RECEIVED,
    });
  });
});

describe.skipIf(!ENABLED)('falha no rastreio (aceite 17)', () => {
  it('aceite 17: falha ao gravar lastReplyMessageId — nenhuma ciência gravada', async () => {
    const alert = await seed();
    const recipients = prisma.teamWhatsappRecipient;
    const failing = {
      teamWhatsappRecipient: {
        findFirst: (args: Prisma.TeamWhatsappRecipientFindFirstArgs) =>
          recipients.findFirst(args),
        updateMany: (args: Prisma.TeamWhatsappRecipientUpdateManyArgs) =>
          'lastReplyMessageId' in args.data
            ? Promise.reject(new Error('db fora'))
            : recipients.updateMany(args),
      },
    };
    const broken = new TeamRecipientTrackingService(failing as never);
    const message = await inbound('TEXT', 'OK', RECEIVED);
    await expect(
      broken.applyReply({
        channelId: 'ch-x',
        contactIds: [alert.contactId],
        receivedAt: RECEIVED,
        message,
      }),
    ).rejects.toThrow('db fora');
    expect(await readAck(alert.id)).toMatchObject(UNTOUCHED);
  });
});
