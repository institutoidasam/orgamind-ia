import { Injectable } from '@nestjs/common';
import { Prisma, type Contact, type FailureReason } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  REACHED_STATUSES,
  reachedInCampaignFilter,
} from '../campaigns/batch-audience';
import { brazilianPhoneVariants, canonicalBrPhoneForm } from './phone.util';
import {
  classifyContactValidity,
  contactValidityWhere,
  DELIVERY_PROVEN_STATUSES,
  excludeInvalidWhere,
  unvalidatedContactWhere,
  type ContactValidity,
} from '../../shared/contact-validity';
import { isSessionProvider } from '../../schemas/contracts/channel-provider.schema';

export type ContactCreateData = {
  phoneE164: string;
  name?: string;
  city?: string;
  group?: string;
  tags?: string[];
  customFields?: Record<string, unknown>;
};

export type ContactUpdateData = Partial<Omit<ContactCreateData, 'phoneE164'>> & {
  optedOut?: boolean;
};

export type ListContactsArgs = {
  page: number;
  pageSize: number;
  search?: string;
  city?: string;
  group?: string;
  optedOut?: boolean;
  // F2 T6 — filtra por "última falha definitiva" (Contact.lastFailureReason).
  failureReason?: FailureReason;
  // Filtra "quem RECEBEU esta campanha" (REACHED_STATUSES). É a direção INVERSA
  // do wizard, que usa o mesmo predicado para EXCLUIR da audiência.
  receivedCampaignId?: string;
  // B.3 — "Validação: todos / válidos / inválidos / não validados". O predicado
  // NÃO mora aqui: vem de shared/contact-validity.ts, o mesmo que o assistente,
  // o export e a exclusão em massa usam. Se esta tela tivesse critério próprio,
  // "inválido" na lista e "inválido" no disparo poderiam divergir na cara do
  // operador — que foi exatamente o que aconteceu com o toggle antigo.
  validity?: ContactValidity;
};

/**
 * O resumo "campanhas que este contato recebeu", como a coluna da lista o
 * consome. `names` vem ordenado por `Campaign.createdAt` DESC — a campanha
 * criada mais recentemente primeiro, o que NÃO é o mesmo que "a última que a
 * pessoa recebeu" (isso exigiria um MAX(sentAt) por par contato × campanha, que
 * este agregado deliberadamente não paga). Nada é truncado: `count` é o número
 * cheio e `names` traz TODOS os nomes.
 * Contrato espelhado em `campaignsReceivedSchema` (contact.schema.ts).
 */
export type CampaignsReceived = { count: number; names: string[] };

export type ContactListItem = Contact & {
  campaignsReceived: CampaignsReceived;
  /**
   * B.6, review (achado 1) — a validade JÁ CLASSIFICADA nesta linha, pelo
   * MESMO critério do resto do produto (`classifyContactValidity`, incluindo
   * a sonda de entrega provada). Sem isto, a coluna "WA" só enxergava
   * `whatsappValid`+`lastFailureReason` e discordava do filtro
   * `?validity=valid`, do export e do N do diálogo de sincronização para
   * quem tinha uma mensagem DELIVERED/READ mas nunca foi validado
   * ativamente — a mesma linha virava "Não validado" na tela e "válido" em
   * todo o resto.
   */
  validity: ContactValidity;
};

/** A linha crua que o Prisma devolve para `listPaginated`, com a sonda de
 *  entrega (`messages`) ainda anexada — antes de virar `ContactListItem`. */
type ContactRowWithDeliveryProbe = Contact & {
  messages: Array<{ id: string }>;
};

/**
 * A LINHA DA PLANILHA — colunas mínimas, e nada além (LGPD: o export carrega o
 * mínimo). `messages` traz no máximo UMA linha DELIVERED/READ e serve a uma
 * pergunta só: "houve entrega provada?". Sem ela, quem já recebeu sairia da
 * planilha como "Não validado".
 */
export type ContactExportRow = {
  id: string;
  phoneE164: string;
  name: string | null;
  city: string | null;
  group: string | null;
  tags: string[];
  whatsappValid: boolean | null;
  whatsappCheckedAt: Date | null;
  lastFailureReason: FailureReason | null;
  lastFailureAt: Date | null;
  messages: Array<{ id: string }>;
};

/**
 * O `where` da LISTA de contatos, num lugar só — a listagem, o export XLSX e a
 * exclusão em massa filtrada precisam ser o MESMO recorte, ou o operador
 * exporta uma planilha e apaga um conjunto diferente do que viu na tela.
 *
 * `validity` entra dentro de `AND`, e não como chave de primeiro nível, porque
 * o predicado de validade fala de `messages` — a mesma chave que
 * `receivedCampaignId` usa. Espalhados no mesmo objeto, um sobrescreveria o
 * outro EM SILÊNCIO.
 */
export function buildContactListWhere(
  args: ListContactsArgs,
): Prisma.ContactWhereInput {
  return {
    ...(args.search && {
      OR: [
        { phoneE164: { contains: args.search } },
        { name: { contains: args.search, mode: 'insensitive' } },
      ],
    }),
    ...(args.city && { city: args.city }),
    ...(args.group && { group: args.group }),
    ...(args.optedOut !== undefined && { optedOut: args.optedOut }),
    ...(args.failureReason && { lastFailureReason: args.failureReason }),
    // REUSA o helper em vez de repetir o literal: é o MESMO predicado que o
    // filter.converter (F1, event:'received') já empurra para o Postgres. Se
    // esta tela filtrasse por um critério próprio, "quem recebeu" na lista e
    // "quem recebeu" na exclusão do wizard poderiam divergir na cara do
    // operador.
    ...(args.receivedCampaignId && {
      messages: { some: reachedInCampaignFilter(args.receivedCampaignId) },
    }),
    ...(args.validity && { AND: [contactValidityWhere(args.validity)] }),
  };
}

@Injectable()
export class ContactsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Contact | null> {
    return this.prisma.contact.findUnique({ where: { id } });
  }

  /**
   * C5 — A RESOLUÇÃO DE IDENTIDADE: o único jeito de perguntar "este titular já
   * existe?".
   *
   * O `findByPhoneE164` que existia aqui (igualdade exata de string) foi
   * REMOVIDO, não deprecado: era ele que o próximo caminho de escrita usaria
   * sem perceber o problema, e o problema é grave.
   *
   * A identidade efetiva do contato era a igualdade EXATA de `phoneE164`, mas o
   * assinante do WhatsApp é o mesmo nas duas grafias do 9º dígito: quem já estava
   * na base como `+5592995550101` e chegava como `+559295550101` virava um
   * SEGUNDO Contact. E o gêmeo não fica inerte — `ConsentService.rehydrate` casa
   * a trilha pelas DUAS grafias, então ele nasce GRANTED e passa o gate de
   * campanha. No GoZap, que resolve o número canônico no envio, as duas linhas
   * convergem no mesmo destino: a pessoa recebe propaganda eleitoral duas vezes.
   *
   * Devolve a linha com a grafia JÁ GRAVADA — quem chama deve atualizar por `id`,
   * nunca por `phoneE164` (a grafia consultada pode não ser a armazenada).
   *
   * Enquanto a base ainda tiver gêmeos (o reparo roda a cada deploy, mas um
   * import pode criar um par entre dois deploys), a escolha entre os dois é
   * DETERMINÍSTICA: vence a forma de 13 dígitos. O ponto aqui é ser ESTÁVEL —
   * duas regras diferentes fariam dois caminhos de escrita apontar para linhas
   * diferentes, e o gêmeo voltaria a nascer.
   *
   * Não confunda com a eleição da FUSÃO: `prisma/merge-duplicate-phone-contacts.ts`
   * decide quem sobrevive pela EVIDÊNCIA DE ENTREGA (DELIVERED/READ, inbound,
   * whatsappValid) e só cai no formato quando as duas linhas são mudas — porque lá
   * a decisão apaga uma linha para sempre. Aqui não se apaga nada: é um desempate
   * temporário que deixa de existir assim que o reparo roda.
   */
  async findByAnyBrForm(phoneE164: string): Promise<Contact | null> {
    const variants = brazilianPhoneVariants(phoneE164);
    const rows = await this.prisma.contact.findMany({
      where: { phoneE164: { in: variants } },
      // A bijeção do 9º dígito produz no máximo duas grafias — logo, no máximo
      // duas linhas. O `take` é o teto real, não uma paginação.
      take: 2,
    });
    if (rows.length === 0) return null;
    const canonical = canonicalBrPhoneForm(phoneE164);
    return rows.find((r) => r.phoneE164 === canonical) ?? rows[0];
  }

  /**
   * Attach any still-unlinked conversations whose phone matches one of the
   * supplied E.164 variants to the given contact. Used to retroactively link
   * conversations that arrived (via history import or an outbound send) before
   * the contact existed, or whose JID used the legacy Brazilian 8-digit form.
   * Returns how many conversations were linked.
   */
  async linkConversationsByPhone(
    contactId: string,
    phoneVariants: string[],
  ): Promise<number> {
    const result = await this.prisma.conversation.updateMany({
      where: { contactId: null, phoneE164: { in: phoneVariants } },
      data: { contactId },
    });
    return result.count;
  }

  async listPaginated(
    args: ListContactsArgs,
  ): Promise<{ items: ContactListItem[]; total: number }> {
    const where = buildContactListWhere(args);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({
        where,
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
        orderBy: { createdAt: 'desc' },
        // B.6, review (achado 1) — a MESMA sonda `take: 1` do export
        // (`pageForExport`, abaixo): "existe alguma entrega PROVADA
        // (DELIVERED/READ) para este contato?". `classifyContactValidity`,
        // em `attachCampaignsReceived`, usa a resposta para calcular
        // `validity` — sem a sonda, a linha mentiria para quem já recebeu
        // uma campanha mas nunca foi validado ativamente.
        include: {
          messages: {
            where: {
              direction: 'OUTBOUND',
              status: { in: DELIVERY_PROVEN_STATUSES },
            },
            select: { id: true },
            take: 1,
          },
        },
      }),
      this.prisma.contact.count({ where }),
    ]);
    return { items: await this.attachCampaignsReceived(items), total };
  }

  /**
   * Anexa, a cada contato da PÁGINA, quais campanhas ele RECEBEU — e calcula
   * `validity` (B.6, review) com a mesma sonda de entrega que `listPaginated`
   * já carregou no `include`.
   *
   * Duas queries adicionais para a página inteira — nunca uma por contato: um
   * `include` de `messages` SEM filtro traria o histórico completo de cada um
   * só para contar distintos, e um loop seria N+1 numa tela que pagina de 50
   * em 50.
   */
  private async attachCampaignsReceived(
    contacts: ContactRowWithDeliveryProbe[],
  ): Promise<ContactListItem[]> {
    if (contacts.length === 0) return [];

    const grouped = await this.prisma.message.groupBy({
      by: ['contactId', 'campaignId'],
      where: {
        contactId: { in: contacts.map((c) => c.id) },
        // NÃO É OPCIONAL: OUTBOUND + status alcançado também casa mensagem de
        // BOT/INBOX, que não pertence a campanha nenhuma — sem isto uma
        // conversa avulsa entraria na conta como se fosse campanha. O mesmo
        // cuidado está em scripts/measure-duplicate-campaign-deliveries.ts.
        campaignId: { not: null },
        direction: 'OUTBOUND',
        status: { in: REACHED_STATUSES },
      },
    });

    const idsByContact = new Map<string, Set<string>>();
    for (const row of grouped) {
      // O `where` já exclui os dois nulos; o guarda existe porque o tipo do
      // Prisma os mantém nullable (ambas as FKs são opcionais no schema).
      if (row.contactId == null || row.campaignId == null) continue;
      const set = idsByContact.get(row.contactId) ?? new Set<string>();
      set.add(row.campaignId);
      idsByContact.set(row.contactId, set);
    }

    const campaignIds = [
      ...new Set(
        grouped
          .map((r) => r.campaignId)
          .filter((id): id is string => id !== null),
      ),
    ];
    // Campaign é tabela pequena (dezenas de linhas), e só os ids desta página
    // entram no IN — buscar os nomes numa tacada custa menos que carregar o
    // relacionamento em cada Message.
    const campaigns = campaignIds.length
      ? await this.prisma.campaign.findMany({
          where: { id: { in: campaignIds } },
          select: { id: true, name: true },
          // Ordena por data de CRIAÇÃO DA CAMPANHA (desc) — NÃO por quando este
          // contato recebeu. São coisas diferentes: uma campanha criada antes
          // pode ter entregue depois. Ordenar por recebimento pediria um
          // MAX(sentAt) por par contato × campanha, e este agregado não paga
          // isso. É só uma ordem ESTÁVEL e útil o bastante para o `title`.
          orderBy: { createdAt: 'desc' },
        })
      : [];

    return contacts.map((c) => {
      const received = idsByContact.get(c.id);
      const names = received
        ? campaigns.filter((k) => received.has(k.id)).map((k) => k.name)
        : [];
      // `count` sai de `names`, não do Set: se uma campanha sumiu entre as duas
      // queries, a tela mostraria "2 campanhas" e listaria uma só.
      // A sonda (`messages`) NÃO sai na resposta — ela só serve para calcular
      // `validity` aqui dentro; `contact` já vem sem ela (destructuring).
      const { messages, ...contact } = c;
      return {
        ...contact,
        campaignsReceived: { count: names.length, names },
        validity: classifyContactValidity({
          whatsappValid: c.whatsappValid,
          lastFailureReason: c.lastFailureReason,
          hasProvenDelivery: messages.length > 0,
        }),
      };
    });
  }

  create(data: ContactCreateData): Promise<Contact> {
    return this.prisma.contact.create({
      data: {
        ...data,
        tags: data.tags ?? [],
        customFields:
          data.customFields !== undefined
            ? (data.customFields as Prisma.InputJsonValue)
            : undefined,
      },
    });
  }


  update(id: string, data: ContactUpdateData): Promise<Contact> {
    const prismaData: Prisma.ContactUpdateInput = {
      ...data,
      customFields:
        data.customFields !== undefined
          ? (data.customFields as Prisma.InputJsonValue)
          : undefined,
    };
    return this.prisma.contact.update({
      where: { id },
      data: prismaData,
    });
  }

  delete(id: string): Promise<Contact> {
    return this.prisma.contact.delete({ where: { id } });
  }

  /**
   * Persist the canonical waLabels list for a contact. Caller is responsible
   * for actually pushing the add/remove diff to Evolution before calling
   * this — we only mirror the final state locally.
   */
  updateLabels(id: string, waLabels: string[]): Promise<Contact> {
    return this.prisma.contact.update({
      where: { id },
      data: { waLabels },
    });
  }

  deleteMany(ids: string[]): Promise<{ count: number }> {
    return this.prisma.contact.deleteMany({ where: { id: { in: ids } } });
  }

  deleteAll(): Promise<{ count: number }> {
    return this.prisma.contact.deleteMany({});
  }

  /**
   * Apaga por PREDICADO, e não por lista de ids: a lista de "inválidos
   * confirmados" tem milhares de linhas, e materializá-la em memória só para
   * mandá-la de volta num `IN (…)` seria a mesma query duas vezes.
   *
   * ⚠️ `Message.contact` é `onDelete: Cascade` — isto apaga também as mensagens
   * de cada contato (inclusive as falhas que PROVAVAM a invalidez e as linhas
   * de campanhas passadas). Quem chama é responsável por avisar o operador; a
   * confirmação da UI diz isso com todas as letras (B.3).
   */
  deleteWhere(where: Prisma.ContactWhereInput): Promise<{ count: number }> {
    return this.prisma.contact.deleteMany({ where });
  }

  /**
   * Conta por PREDICADO — dois chamadores: o export (o total antes de paginar)
   * e o `bulkDelete` por validade (Round 1, B.3), que usa isto para confirmar
   * que a lista não mudou entre a tela do operador e o clique em "apagar",
   * ANTES de apagar qualquer coisa. Round 2 (revisão): consolidado de
   * `countForExport` — mesma query, dois nomes era o mesmo método duas vezes.
   */
  countWhere(where: Prisma.ContactWhereInput): Promise<number> {
    return this.prisma.contact.count({ where });
  }

  /**
   * O canal de SESSÃO está conectado agora?
   *
   * Mesmo predicado do roteador de envio (`whatsapp-instance-router.service.ts`
   * — o último `WhatsappConnectionEvent` com `state === 'open'`). Provedores
   * OFICIAIS (Twilio/Zernio/Meta) não têm sessão e são sempre "online".
   *
   * Mora aqui, e não num serviço de canais, porque o único consumidor fora do
   * roteador é a validação ativa de contatos — e o roteador vive num módulo
   * que esta fase não é dona.
   */
  async isSessionChannelOnline(channel: {
    id: string;
    provider: string;
  }): Promise<boolean> {
    if (!isSessionProvider(channel.provider)) return true;
    const last = await this.prisma.whatsappConnectionEvent.findFirst({
      where: { instanceId: channel.id },
      orderBy: { occurredAt: 'desc' },
      select: { state: true },
    });
    return last?.state === 'open';
  }

  /** Quantos contatos foram CHECADOS desde `since` — a barra de progresso. */
  countCheckedSince(since: Date): Promise<number> {
    return this.prisma.contact.count({
      where: { whatsappCheckedAt: { gte: since } },
    });
  }

  /** Quantos contatos estão em uma classe de validade (o N dos botões). */
  countByValidity(v: ContactValidity): Promise<number> {
    return this.prisma.contact.count({ where: contactValidityWhere(v) });
  }

  findMessagesForContact(contactId: string) {
    return this.prisma.message.findMany({
      where: { contactId },
      orderBy: { queuedAt: 'desc' },
      include: {
        campaign: { select: { id: true, name: true, templateId: true } },
      },
    });
  }

  async findIdsForSync(
    mode: 'unvalidated' | 'all' | 'stale',
    limit: number,
  ): Promise<string[]> {
    const cutoff = new Date(Date.now() - 30 * 86400 * 1000);
    const where: Prisma.ContactWhereInput =
      mode === 'unvalidated'
        ? // Fase B, review — o MESMO predicado do N que o botão mostra
          // (`unvalidatedContactWhere`), não o `{ whatsappValid: null }`
          // ingênuo: aquele incluía contatos já confirmados inválidos por
          // `lastFailureReason` (ou com entrega provada), então o back podia
          // enfileirar MAIS que o N prometido — puro risco de bloqueio, zero
          // informação nova.
          unvalidatedContactWhere()
        : mode === 'stale'
          ? // B.6, review (achado 2) — 'stale' é o job do CRON de RECHECAGEM:
            // quem JÁ foi validado e está VENCIDO (>30d). NÃO é a rede de
            // segurança para quem nunca foi checado — aquilo é
            // 'unvalidated', o botão "Validar não validados" do operador.
            // Um `{ whatsappCheckedAt: null }` aqui fazia o cron reenfileirar
            // TODA a base nunca checada, disputando com a fila do operador
            // por um trabalho que já tem dono. Também exclui quem já é
            // INVÁLIDO CONFIRMADO (`excludeInvalidWhere`, o complemento
            // NULL-safe de `invalidContactWhere`): rechecar um número que o
            // WhatsApp já recusou não traz informação nova — só risco de
            // banimento.
            {
              AND: [{ whatsappCheckedAt: { lt: cutoff } }, excludeInvalidWhere()],
            }
          : // Hardening (achado 3) — 'all' era LITERALMENTE `{}`: a base
            // inteira, incluindo quem já é INVÁLIDO CONFIRMADO — mesmo risco
            // que 'stale' corrige acima, por um alcance ainda MAIOR ('all'
            // nem exige `whatsappCheckedAt` vencido; é a base toda de uma
            // vez). Rechecar quem o provedor já recusou é puro risco de
            // bloqueio, zero informação nova. O endpoint continua aceitando
            // `mode:'all'` (spec) — só o WHERE ganha o mesmo
            // `excludeInvalidWhere()` complemento NULL-safe que 'stale' usa.
            excludeInvalidWhere();
    const rows = await this.prisma.contact.findMany({
      where,
      select: { id: true },
      take: limit,
    });
    return rows.map((r) => r.id);
  }

  /**
   * Uma página do export, por CURSOR (`id asc`) e não por `skip`: com `skip` a
   * 50ª página custa 50× mais que a 1ª, e o export existe justamente para
   * bases grandes. O `take: 1` no relacionamento é uma sonda, não um join do
   * histórico.
   */
  pageForExport(
    where: Prisma.ContactWhereInput,
    take: number,
    cursor?: string,
  ): Promise<ContactExportRow[]> {
    return this.prisma.contact.findMany({
      where,
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        phoneE164: true,
        name: true,
        city: true,
        group: true,
        tags: true,
        whatsappValid: true,
        whatsappCheckedAt: true,
        lastFailureReason: true,
        lastFailureAt: true,
        messages: {
          where: {
            direction: 'OUTBOUND',
            status: { in: DELIVERY_PROVEN_STATUSES },
          },
          select: { id: true },
          take: 1,
        },
      },
    });
  }

  findImportItemsForContact(contactId: string) {
    return this.prisma.importItem.findMany({
      where: { contactId },
      orderBy: { id: 'desc' },
      include: {
        importBatch: {
          select: { id: true, filename: true, createdAt: true },
        },
      },
    });
  }

  /**
   * Returns distinct values + counts for facet-based filtering UI.
   * Only counts active (not opted-out) contacts.
   */
  async facets() {
    const baseWhere: Prisma.ContactWhereInput = { optedOut: false };

    const [totalActive, totalOptedOut, byCity, byGroup, contactsWithTags] =
      await Promise.all([
        this.prisma.contact.count({ where: baseWhere }),
        this.prisma.contact.count({ where: { optedOut: true } }),
        this.prisma.contact.groupBy({
          by: ['city'],
          where: { ...baseWhere, city: { not: null } },
          _count: { _all: true },
          orderBy: { _count: { city: 'desc' } },
        }),
        this.prisma.contact.groupBy({
          by: ['group'],
          where: { ...baseWhere, group: { not: null } },
          _count: { _all: true },
          orderBy: { _count: { group: 'desc' } },
        }),
        this.prisma.contact.findMany({
          where: baseWhere,
          select: { tags: true },
        }),
      ]);

    // Aggregate tag counts in app code (Postgres array unnest is more
    // complex via Prisma; small dataset makes this trivial).
    const tagCounts = new Map<string, number>();
    for (const c of contactsWithTags) {
      for (const tag of c.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const tags = [...tagCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

    return {
      totalActive,
      totalOptedOut,
      cities: byCity
        .filter((g) => g.city !== null)
        .map((g) => ({ value: g.city as string, count: g._count._all })),
      groups: byGroup
        .filter((g) => g.group !== null)
        .map((g) => ({ value: g.group as string, count: g._count._all })),
      tags,
    };
  }
}
