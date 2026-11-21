import type { MessageKind, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendencyListQuerySchema } from '../../schemas/contracts/team-pendency.schema';
import type { TeamPendencyList } from '../../schemas/contracts/team-pendency.schema';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { newConversation } from '../chat/conversation-ownership.test-fixtures';
import { TeamPendencyService } from './team-pendency.service';
import {
  T0,
  at,
  grantPermission,
  newAlert,
  newPendency,
  newSector,
  newTeamUser,
  revokePermission,
  startPendencyDb,
  stopPendencyDb,
  type NewPendencyInput,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.list.integration.spec.ts
 * `now` fixo (T0); alertas e respostas gravados com `createdAt`/`receivedAt` explícitos.
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const NOW = T0;
const ago = (minutes: number) => at(-minutes);
const daysAgo = (days: number) => ago(days * 1440);
const FORBIDDEN = { code: 'team_whatsapp.forbidden' };
const NOT_FOUND = { code: 'team_whatsapp.pendency_not_found' };

let db: TestDb;
let service: TeamPendencyService;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  service = new TeamPendencyService(db.prisma as unknown as PrismaService);
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

type Boss = { id: string; sectorId: string; sectorName: string };

/** Gestor ativo (remetente) de um setor novo. */
async function boss(role: Role = 'SUPERVISOR'): Promise<Boss> {
  const user = await newTeamUser(db, { role });
  const sector = await newSector(db, { managerId: user.id });
  return { id: user.id, sectorId: sector.id, sectorName: sector.name };
}

type Seed = Partial<Omit<NewPendencyInput, 'dispatchId'>> & { alertAt?: Date };

/** Pendência de um alerta do gestor, no setor dele, enviado há 30 min (prazo de ciência vencido). */
async function seed(b: Boss, over: Seed = {}): Promise<string> {
  const { alertAt = ago(30), ...rest } = over;
  const dispatchId = await newAlert(db, { authorId: b.id, createdAt: alertAt });
  return newPendency(db, {
    dispatchId,
    sectorId: b.sectorId,
    sectorName: b.sectorName,
    ...rest,
  });
}

/** Lista com a consulta já passada pelo schema do contrato (padrões e coerção reais). */
const run = (actorId: string, raw: Record<string, string> = {}, max?: number) =>
  service.list(actorId, pendencyListQuerySchema.parse(raw), NOW, max);

const idsOf = (list: TeamPendencyList): string[] =>
  list.items.map((item) => item.id);
const itemOf = (list: TeamPendencyList, id: string) =>
  list.items.find((item) => item.id === id);

describe.skipIf(!ENABLED)('lista — período (DK7, aceite 15)', () => {
  it('aceite 15: padrão traz Sem responsável, Em tratativa e atrasada, inclusive alerta de 90 dias', async () => {
    const b = await boss();
    const old = await seed(b, { alertAt: daysAgo(90) });
    const progress = await seed(b, { handlerId: b.id, dueAt: at(30) });
    const overdue = await seed(b, { handlerId: b.id, dueAt: ago(5) });
    await seed(b, { ackAt: ago(5) });
    await seed(b, { closedAt: ago(5), closedById: b.id, closeReason: 'x' });
    const list = await run(b.id);
    const situations = list.items.map((i) => [i.id, i.situation]);
    expect(situations).toEqual(
      expect.arrayContaining([
        [old, 'UNASSIGNED'],
        [progress, 'IN_PROGRESS'],
        [overdue, 'OVERDUE'],
      ]),
    );
    expect([list.total, list.truncated]).toEqual([3, false]);
  });

  it('aceite 15: Ciente e Encerrada só dos últimos 7 dias; days=30 amplia', async () => {
    const b = await boss();
    const closed = { closedById: b.id, closeReason: 'x' };
    const acked7 = await seed(b, { alertAt: daysAgo(2), ackAt: ago(5) });
    const closed7 = await seed(b, {
      alertAt: daysAgo(3),
      closedAt: ago(5),
      ...closed,
    });
    const acked30 = await seed(b, { alertAt: daysAgo(10), ackAt: ago(5) });
    const closed30 = await seed(b, {
      alertAt: daysAgo(20),
      closedAt: ago(5),
      ...closed,
    });
    await seed(b, { alertAt: daysAgo(40), closedAt: ago(5), ...closed });
    const resolved = { situations: 'ACKED,CLOSED' };
    const week = await run(b.id, resolved);
    const month = await run(b.id, { ...resolved, days: '30' });
    expect(idsOf(week).sort()).toEqual([acked7, closed7].sort());
    expect(idsOf(month).sort()).toEqual(
      [acked7, closed7, acked30, closed30].sort(),
    );
  });
});

describe.skipIf(!ENABLED)('lista — ordem e teto (DK5, DK7)', () => {
  it('aceite 15: ordem DK5 na resposta', async () => {
    const b = await boss();
    const handled = { handlerId: b.id };
    const e = await seed(b, { alertAt: ago(120) });
    const f = await seed(b, { alertAt: ago(60) });
    const overdue = await seed(b, {
      alertAt: ago(10),
      dueAt: ago(1),
      ...handled,
    });
    const old = await seed(b, { alertAt: ago(200), dueAt: at(30), ...handled });
    const fresh = await seed(b, { alertAt: ago(5) });
    expect(idsOf(await run(b.id))).toEqual([e, f, overdue, old, fresh]);
  });

  it('DK7: acima do teto — truncated true; ficam as mais novas (as mais antigas saem) e a ordem DK5 vale entre as lidas', async () => {
    // Pega a leitura do mais antigo para o mais novo: ficariam as 3 mais antigas.
    const b = await boss();
    const rows = [300, 240, 180, 120, 60].map((minutes) => seedAt(b, minutes));
    const [h5, h4, h3, h2, h1] = await Promise.all(rows);
    const capped = await run(b.id, {}, 3);
    expect(idsOf(capped)).toEqual([h3, h2, h1]);
    expect(capped.truncated).toBe(true);
    expect([h5, h4].some((id) => idsOf(capped).includes(id))).toBe(false);
    expect((await run(b.id, {}, 5)).truncated).toBe(false);
  });
});

/** Pendência aberta cujo alerta e destinatário nasceram há `minutes` minutos. */
async function seedAt(b: Boss, minutes: number): Promise<string> {
  const id = await seed(b, { alertAt: ago(minutes) });
  await db.prisma.teamWhatsappRecipient.update({
    where: { id },
    data: { createdAt: ago(minutes) },
  });
  return id;
}

/** Dois setores do gestor; `nominal` = envio a uma pessoa do segundo setor, sem setor gravado. */
async function twoSectors() {
  const b = await boss();
  const second = await newSector(db, { managerId: b.id });
  const person = await newTeamUser(db, {
    role: 'OPERATOR',
    sectorId: second.id,
  });
  const first = await seed(b, { handlerId: b.id, dueAt: at(30) });
  const inSecond = await seed(b, {
    sectorId: second.id,
    sectorName: second.name,
  });
  const nominal = await seed(b, {
    userId: person.id,
    sectorId: undefined,
    sectorName: undefined,
  });
  const loose = await seed(b, { sectorId: undefined, sectorName: undefined });
  return { b, second, first, inSecond, nominal, loose };
}

describe.skipIf(!ENABLED)('lista — filtros e setores (K2-5)', () => {
  it('filtros setor (setor efetivo, inclusive nominal) e mine', async () => {
    const s = await twoSectors();
    const bySector = await run(s.b.id, { sectorId: s.second.id });
    const mine = await run(s.b.id, { mine: 'true' });
    expect(idsOf(bySector).sort()).toEqual([s.inSecond, s.nominal].sort());
    expect(idsOf(mine)).toEqual([s.first]);
  });

  it('sectors traz os setores efetivos no alcance antes do filtro de setor', async () => {
    const s = await twoSectors();
    const list = await run(s.b.id, { sectorId: s.second.id });
    const expected = [
      { id: s.b.sectorId, name: s.b.sectorName },
      { id: s.second.id, name: s.second.name },
    ].sort((a, b) => new Intl.Collator('pt-BR').compare(a.name, b.name));
    expect(list.sectors).toEqual(expected);
    expect(list.items).toHaveLength(2);
  });
});

/** Mensagem recebida (resposta) ou enviada numa conversa, com hora explícita. */
async function message(
  conversationId: string,
  kind: MessageKind,
  content: string | null,
  direction: 'INBOUND' | 'OUTBOUND' = 'INBOUND',
): Promise<string> {
  const row = await db.prisma.message.create({
    data: {
      instanceId: db.channelId,
      conversationId,
      direction,
      kind,
      content,
      receivedAt: ago(10),
    },
    select: { id: true },
  });
  return row.id;
}

const PHONE = '+5592991110001';
const REPLY_KINDS: [MessageKind, string][] = [
  ['TEXT', 'Preciso de ajuda'],
  ['AUDIO', 'legenda do áudio'],
  ['IMAGE', 'legenda da imagem'],
  ['DOCUMENT', 'legenda do arquivo'],
];

/** Uma resposta ligada por tipo, uma ciente com resposta ligada e uma sem resposta; mais uma mensagem NÃO ligada. */
async function repliedRows(b: Boss) {
  const conversation = await newConversation(db);
  await message(conversation, 'TEXT', 'OUTRA mensagem da conversa');
  const linked: string[] = [];
  for (const [kind, text] of REPLY_KINDS) {
    const lastReplyMessageId = await message(conversation, kind, text);
    linked.push(await seed(b, { lastReplyMessageId }));
  }
  const reply = await message(conversation, 'TEXT', 'ok');
  const acked = await seed(b, { lastReplyMessageId: reply, ackAt: ago(5) });
  return { linked, acked, none: await seed(b) };
}

describe.skipIf(!ENABLED)('lista — última resposta (DK8, aceite 14)', () => {
  it('aceite 14: Respondeu, sem ciência — só a última resposta ligada; mídia como audio/image/file sem legenda; outros grupos sem lastReply', async () => {
    const b = await boss();
    const rows = await repliedRows(b);
    const list = await run(b.id, { situations: 'UNASSIGNED,ACKED' });
    const replyOf = (id: string) => itemOf(list, id)?.lastReply;
    const at10 = ago(10).toISOString();
    expect(rows.linked.map((id) => replyOf(id))).toEqual([
      { text: 'Preciso de ajuda', media: null, at: at10 },
      { text: null, media: 'audio', at: at10 },
      { text: null, media: 'image', at: at10 },
      { text: null, media: 'file', at: at10 },
    ]);
    expect([replyOf(rows.acked), replyOf(rows.none)]).toEqual([null, null]);
    expect(JSON.stringify(list)).not.toContain('OUTRA');
  });
});

/** Pendência com o telefone gravado no envio. */
async function seedWithPhone(b: Boss): Promise<string> {
  const id = await seed(b);
  await db.prisma.teamWhatsappRecipient.update({
    where: { id },
    data: { phoneE164: PHONE },
  });
  return id;
}

async function expectMasked(b: Boss, id: string): Promise<void> {
  const people = [(await run(b.id)).items[0], await service.get(b.id, id, NOW)];
  for (const { person } of people) {
    expect([person.phoneE164, person.hasPhone]).toEqual([null, true]);
    expect(person.phoneMasked).toContain('0001');
    expect(JSON.stringify(person)).not.toContain('991110001');
  }
}

describe.skipIf(!ENABLED)('lista — telefone (DK8, aceite 14)', () => {
  it('aceite 14: telefone completo só com telefone.ver_completo; senão mascarado', async () => {
    const b = await boss();
    const id = await seedWithPhone(b);
    expect((await run(b.id)).items[0].person).toMatchObject({
      phoneE164: PHONE,
      hasPhone: true,
    });
    await revokePermission(db, 'SUPERVISOR', 'telefone.ver_completo');
    try {
      await expectMasked(b, id);
    } finally {
      await grantPermission(db, 'SUPERVISOR', 'telefone.ver_completo');
    }
  });
});

/**
 * Alerta do SUPERVISOR no setor do OPERATOR: ele vê por autoria, o OPERATOR pelo
 * setor; uma pendência com a mensagem do envio e outra sem.
 */
async function conversationCases() {
  const supervisor = await boss('SUPERVISOR');
  const operator = await boss('OPERATOR');
  const admin = await newTeamUser(db, { role: 'ADMIN' });
  const conversation = await newConversation(db);
  const sent = await message(conversation, 'TEXT', 'enviada', 'OUTBOUND');
  const target = {
    sectorId: operator.sectorId,
    sectorName: operator.sectorName,
  };
  const withMessage = await seed(supervisor, { messageId: sent, ...target });
  const without = await seed(supervisor, target);
  return { supervisor, operator, admin, conversation, withMessage, without };
}

/** `conversationId` e `canViewDispatch` do item para o ator. */
async function viewOf(actorId: string, id: string) {
  const item = await service.get(actorId, id, NOW);
  return [item.conversationId, item.canViewDispatch];
}

describe.skipIf(!ENABLED)('item — conversa e resultado (aceite 22)', () => {
  it('aceite 22: abrir conversa só a quem tem a caixa e com mensagem do envio; ver resultado só ADMIN e autor', async () => {
    const c = await conversationCases();
    const [conversation, withMessage] = [c.conversation, c.withMessage];
    expect(await viewOf(c.admin.id, withMessage)).toEqual([conversation, true]);
    expect(await viewOf(c.operator.id, withMessage)).toEqual([
      conversation,
      false,
    ]);
    expect(await viewOf(c.supervisor.id, withMessage)).toEqual([null, true]);
    expect(await viewOf(c.admin.id, c.without)).toEqual([null, true]);
  });
});

/** Responsáveis em quatro situações diante do alcance (K2-2, DK4), num único gestor que lista. */
async function handlerCases() {
  const b = await boss();
  const outsider = await newTeamUser(db, { role: 'OPERATOR' });
  const gone = await newTeamUser(db, { role: 'SUPERVISOR', isActive: false });
  const keyed = await boss('OPERATOR');
  const ahead = { dueAt: at(30) };
  const own = { sectorId: keyed.sectorId, sectorName: keyed.sectorName };
  const rows = {
    ok: await seed(b, { handlerId: b.id, ...ahead }),
    outsider: await seed(b, { handlerId: outsider.id, ...ahead }),
    gone: await seed(b, { handlerId: gone.id, ...ahead }),
    keyed: await seed(b, { handlerId: keyed.id, ...own, ...ahead }),
  };
  return { actorId: b.id, rows };
}

type Rows = Awaited<ReturnType<typeof handlerCases>>['rows'];

function stateOf(list: TeamPendencyList, rows: Rows) {
  const pick = (id: string) => {
    const item = itemOf(list, id);
    return [item?.situation, item?.handler?.state];
  };
  return Object.fromEntries(
    Object.entries(rows).map(([key, id]) => [key, pick(id)]),
  );
}

describe.skipIf(!ENABLED)('responsável (K2-2, aceite 18)', () => {
  it('aceite 18: responsável sem equipe.enviar ou sem setor gerido — Sem responsável, state out_of_scope; inativo — inactive', async () => {
    const { actorId, rows } = await handlerCases();
    expect(stateOf(await run(actorId), rows)).toEqual({
      ok: ['IN_PROGRESS', 'active'],
      outsider: ['UNASSIGNED', 'out_of_scope'],
      gone: ['UNASSIGNED', 'inactive'],
      keyed: ['IN_PROGRESS', 'active'],
    });
    await revokePermission(db, 'OPERATOR', 'equipe.enviar');
    try {
      const after = stateOf(await run(actorId), rows);
      expect(after.keyed).toEqual(['UNASSIGNED', 'out_of_scope']);
    } finally {
      await grantPermission(db, 'OPERATOR', 'equipe.enviar');
    }
  });
});

/** Autor de um alerta que já enviou, mas que não é mais remetente (VIEWER gestor ou SUPERVISOR sem setor). */
async function formerSenders() {
  const viewer = await newTeamUser(db, { role: 'VIEWER' });
  await newSector(db, { managerId: viewer.id });
  const lonely = await newTeamUser(db, { role: 'SUPERVISOR' });
  const rows: { actorId: string; id: string }[] = [];
  for (const author of [viewer, lonely]) {
    const createdAt = ago(30);
    const dispatchId = await newAlert(db, { authorId: author.id, createdAt });
    rows.push({
      actorId: author.id,
      id: await newPendency(db, { dispatchId }),
    });
  }
  return rows;
}

describe.skipIf(!ENABLED)('alcance — recusas (K2-4, aceite 12)', () => {
  it('aceite 12: VIEWER e SUPERVISOR sem setor gerido que já enviou alerta — 403 team_whatsapp.forbidden em lista e item', async () => {
    for (const { actorId, id } of await formerSenders()) {
      await expect(run(actorId)).rejects.toMatchObject(FORBIDDEN);
      await expect(service.get(actorId, id, NOW)).rejects.toMatchObject(
        FORBIDDEN,
      );
    }
  });

  it('item fora do alcance — 404 pendency_not_found', async () => {
    const owner = await boss();
    const other = await boss();
    const id = await seed(owner);
    const get = (actorId: string, target: string) =>
      service.get(actorId, target, NOW);
    await expect(get(other.id, id)).rejects.toMatchObject(NOT_FOUND);
    await expect(get(other.id, 'inexistente')).rejects.toMatchObject(NOT_FOUND);
    expect(idsOf(await run(other.id))).not.toContain(id);
    expect((await get(owner.id, id)).id).toBe(id);
  });
});

describe.skipIf(!ENABLED)('lista — uma pendência por alerta (K2-1)', () => {
  it('K2-1: dois alertas para a mesma pessoa — duas pendências, cada uma com o seu alerta e id próprio', async () => {
    const b = await boss();
    const person = await newTeamUser(db, { role: 'OPERATOR' });
    const first = await seed(b, { userId: person.id, alertAt: ago(60) });
    const second = await seed(b, { userId: person.id, alertAt: ago(30) });
    const list = await run(b.id);
    expect(idsOf(list)).toEqual([first, second]);
    expect(new Set(list.items.map((i) => i.dispatchId)).size).toBe(2);
    expect(list.items.map((i) => i.alert.sentAt)).toEqual([
      ago(60).toISOString(),
      ago(30).toISOString(),
    ]);
  });
});
