import {
  brazilianPhoneVariants,
  canonicalBrPhoneForm,
} from '../contacts/phone.util';

/** "+5592995550101" -> "5592995550101@s.whatsapp.net" (JID canônico, só usado ao CRIAR). */
export function jidFromPhone(phoneE164: string): string {
  return `${phoneE164.replace(/\D/g, '')}@s.whatsapp.net`;
}

/** O mínimo que o resolvedor de titular precisa ler de um Contact. */
export type ResolvedContact = { id: string; phoneE164: string };

type ContactClient = {
  contact: { findMany(args: unknown): Promise<ResolvedContact[]> };
};

/**
 * I13 — QUEM É O TITULAR, na MESMA regra que o resto do sistema usa.
 *
 * O caminho de ENTRADA (o ingest do chat e o reconhecedor de PARAR/VOLTAR do
 * webhook) resolvia o contato com `findFirst({ phoneE164: { in: variantes } })`
 * SEM `orderBy`. Isso não é um empate aleatório: numa tabela de produção o
 * Postgres devolve em ordem de índice (`Contact_phoneE164_key`) e a grafia
 * LEGADA de 12 dígitos ordena ANTES da moderna — ou seja, o inbound escolhia
 * SISTEMATICAMENTE o gêmeo OPOSTO ao que `ContactsRepository.findByAnyBrForm`,
 * a landing pública, o import XLSX e o script de import escolhem.
 *
 * O estrago não é cosmético: a Conversation e o cache `ContactConsent` — que é
 * o que o gate de campanha lê — ficavam pendurados num Contact que a audiência
 * não consulta. Um GRANT do botão, ou pior, uma REVOGAÇÃO de "PARAR", ia parar
 * na linha errada: um registro jurídico no lugar errado, numa base que dispara
 * propaganda eleitoral.
 *
 * O desempate é o MESMO de `findByAnyBrForm`: vence a forma de 13 dígitos
 * (`canonicalBrPhoneForm`). O ponto não é qual grafia é "melhor" — é ser
 * ESTÁVEL: duas regras diferentes fazem dois caminhos de escrita apontar para
 * linhas diferentes, e o gêmeo volta a nascer. É um desempate TEMPORÁRIO, que
 * deixa de existir quando `prisma/merge-duplicate-phone-contacts.ts` funde o par.
 *
 * Devolve TAMBÉM os ids de todos os gêmeos vivos (`ids`): quem precisa varrer o
 * HISTÓRICO do titular (a janela de atribuição do opt-in por botão) tem de
 * perguntar pelos dois, senão enxerga metade da janela.
 */
export async function resolveContactByAnyBrForm(
  db: ContactClient,
  phoneE164: string,
): Promise<{ contact: ResolvedContact | null; ids: string[] }> {
  const variants = brazilianPhoneVariants(phoneE164);
  const rows = await db.contact.findMany({
    where: { phoneE164: { in: variants } },
    // A bijeção do 9º dígito produz no máximo duas grafias — logo, no máximo
    // duas linhas. O `take` é o teto real, não uma paginação.
    take: 2,
    select: { id: true, phoneE164: true },
  });
  if (rows.length === 0) return { contact: null, ids: [] };
  const canonical = canonicalBrPhoneForm(phoneE164);
  const chosen = rows.find((r) => r.phoneE164 === canonical) ?? rows[0];
  return { contact: chosen, ids: rows.map((r) => r.id) };
}

/**
 * Cliente mínimo — casa tanto com o PrismaService do Nest quanto com o
 * PrismaClient cru dos scripts de prisma/ (o backfill usa este mesmo resolvedor).
 */
type ConversationClient = {
  conversation: {
    findFirst(args: unknown): Promise<ResolvedConversation | null>;
    update(args: unknown): Promise<unknown>;
    upsert(args: unknown): Promise<ResolvedConversation>;
  };
};

export type ResolvedConversation = {
  id: string;
  contactId: string | null;
  lastMessageAt: Date | null;
};

/**
 * I14 — O CRITÉRIO ÚNICO DE "ESTA CONVERSA É DO TITULAR?", usado pelos DOIS
 * lados: o espelho da campanha (OUTBOUND) e o ingest do webhook (INBOUND).
 *
 * O caminho de saída já resolvia por variantes; o de entrada dava `upsert` na
 * chave EXATA `[instanceId, remoteJid]`. Com o GoZap vivo isso partia a thread
 * do eleitor em duas linhas na inbox na ordem NORMAL de operação (dispara
 * primeiro, o eleitor responde depois): a campanha abre a conversa com o JID da
 * grafia GRAVADA (13 díg., a da planilha) e o WhatsApp reporta a resposta na
 * grafia legada (12 díg.) — chave diferente, conversa nova. O operador vê o
 * disparo numa linha e a resposta em outra, e nada nunca as junta (o script de
 * fusão só funde conversas quando funde dois CONTATOS).
 *
 * `remoteJid` exato entra SEMPRE na disjunção — é a chave única da tabela.
 * Sem telefone resolvido (um `@lid` ainda não mapeado) ele é o único critério
 * possível, e é o que impede o upsert de colidir com uma linha que já existe.
 */
export function conversationOwnerWhere(args: {
  instanceId: string;
  contactId?: string | null;
  phoneE164?: string | null;
  remoteJid?: string | null;
}): {
  instanceId: string;
  OR: Array<Record<string, unknown>>;
} {
  const variants = args.phoneE164 ? brazilianPhoneVariants(args.phoneE164) : [];
  return {
    instanceId: args.instanceId,
    OR: [
      ...(args.remoteJid ? [{ remoteJid: args.remoteJid }] : []),
      ...(args.contactId ? [{ contactId: args.contactId }] : []),
      ...(variants.length ? [{ phoneE164: { in: variants } }] : []),
      ...(variants.length
        ? [{ remoteJid: { in: variants.map(jidFromPhone) } }]
        : []),
    ],
  };
}

/**
 * A mais ativa vence: se o histórico já deixou duas linhas para a mesma pessoa
 * (um `@lid` e um `@s.whatsapp.net`), a que o operador está usando é a que tem
 * atividade mais recente. `createdAt asc` desempata para que dois caminhos
 * concorrentes nunca escolham linhas diferentes.
 */
export const CONVERSATION_OWNER_ORDER = [
  { lastMessageAt: { sort: 'desc' as const, nulls: 'last' as const } },
  { createdAt: 'asc' as const },
];

/**
 * Resolve a Conversation de um OUTBOUND nosso (campanha/backfill) — RESOLVER,
 * não adivinhar.
 *
 * A chave da conversa é `[instanceId, remoteJid]`, e o remoteJid é sempre o que
 * o PROVEDOR reporta, nunca o que está no nosso cadastro:
 *  - BR: o WhatsApp/Meta reporta muitos celulares na forma legada de 8 dígitos
 *    (`559295550101@s.whatsapp.net`) enquanto o contato foi salvo canonicamente
 *    com o 9 (`+5592995550101`) — é exatamente por isso que `brazilianPhoneVariants`
 *    e `contacts.linkConversationsByPhone` existem;
 *  - Evolution: muitos contatos são endereçados por LID, e a conversa nasce com
 *    `remoteJid = '<lid>@lid'` (o telefone é resolvido à parte).
 *
 * Fabricar `${digits}@s.whatsapp.net` e dar upsert nessa chave criaria uma
 * SEGUNDA conversa para a mesma pessoa: a bolha do disparo cairia na conversa
 * fantasma e a resposta do eleitor na real — thread partida em duas linhas
 * duplicadas na inbox do operador.
 *
 * Por isso procuramos primeiro a conversa que o ingest já criou (por contactId,
 * por qualquer variante BR do telefone, ou por qualquer JID dessas variantes) e
 * só criamos a canônica quando não existe nenhuma.
 */
export async function resolveConversationForOutbound(
  db: ConversationClient,
  args: { instanceId: string; contactId: string | null; phoneE164: string },
): Promise<ResolvedConversation> {
  const jids = brazilianPhoneVariants(args.phoneE164).map(jidFromPhone);

  const existing = await db.conversation.findFirst({
    where: conversationOwnerWhere(args),
    orderBy: CONVERSATION_OWNER_ORDER,
    select: { id: true, contactId: true, lastMessageAt: true },
  });

  if (existing) {
    // Conversa achada pelo telefone mas ainda sem contato ligado (chegou antes
    // do contato existir): aproveita e liga. Nunca ROUBA de outro contato.
    if (args.contactId && !existing.contactId) {
      await db.conversation.update({
        where: { id: existing.id },
        data: { contactId: args.contactId },
      });
      return { ...existing, contactId: args.contactId };
    }
    return existing;
  }

  // Nenhuma conversa ainda: cria a canônica. `upsert` (e não `create`) porque
  // dois envios concorrentes para o mesmo contato correm juntos aqui.
  return db.conversation.upsert({
    where: {
      instanceId_remoteJid: { instanceId: args.instanceId, remoteJid: jids[0] },
    },
    update: {
      phoneE164: args.phoneE164,
      ...(args.contactId ? { contactId: args.contactId } : {}),
    },
    create: {
      instanceId: args.instanceId,
      remoteJid: jids[0],
      phoneE164: args.phoneE164,
      contactId: args.contactId,
    },
    select: { id: true, contactId: true, lastMessageAt: true },
  });
}
