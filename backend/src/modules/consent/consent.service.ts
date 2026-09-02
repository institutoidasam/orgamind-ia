import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConsentAction,
  ConsentSource,
  ConsentState,
  Prisma,
  type ConsentEvent,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { Env } from '../../shared/config/env.schema';
import { phoneHash, phoneHashVariants } from './phone-hash.util';

/**
 * Sentinela de finalidade para a REVOGAÇÃO GLOBAL (PARAR, botão `optout`,
 * código de opt-out do provedor, opt-out manual): revoga TODAS as finalidades e
 * insere na SuppressionList. Não é uma linha de ConsentPurpose — por isso
 * ConsentEvent.purposeKey não tem foreign key.
 */
export const GLOBAL_PURPOSE = '*';

/** Janela de idempotência: um GRANT/REVOKE repetido aqui dentro não vira evento novo. */
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Tamanho do lote do `IN (...)` na consulta de supressão (limite de parâmetros). */
const SUPPRESSION_LOOKUP_CHUNK = 2_000;

/** A finalidade como a UI a vê (o seletor do wizard e a landing de opt-in). */
export type ConsentPurposeView = {
  key: string;
  label: string;
  description: string;
  isSensitive: boolean;
};

export type RecordConsentInput = {
  contactId?: string | null;
  phoneE164: string;
  /** key de ConsentPurpose, ou GLOBAL_PURPOSE ('*') para revogação global. */
  purposeKey: string;
  action: ConsentAction;
  source: ConsentSource;
  /** O TEXTO RENDERIZADO que a pessoa viu. Obrigatório em GRANT — é a prova. */
  evidenceText: string;
  consentTextVersion?: string | null;
  evidence?: Prisma.InputJsonValue;
  channelId?: string | null;
  senderE164?: string | null;
  /** Quando a PESSOA agiu (na ficha de papel: a data da assinatura). Default: agora. */
  occurredAt?: Date;
  /** Quem registrou (import/manual). null = ato do próprio titular. */
  actorUserId?: string | null;
  /** 'keyword_parar' | 'button_optout' | 'manual' | 'provider_optout_code' */
  suppressionReason?: string;
};

/**
 * CAMINHO ÚNICO DE ESCRITA do consentimento.
 *
 * Nada mais no orgamind escreve ConsentEvent, ContactConsent, SuppressionList ou os
 * caches Contact.optInAt/optInSource/optedOut. Essa é a razão de o serviço
 * existir: antes desta feature, o consentimento era um `DateTime?` que o ingest,
 * o webhook e o importador escreviam cada um do seu jeito — e qualquer inbound
 * (inclusive "não quero mais") fabricava um "consentiu".
 *
 * Regras implementadas (spec §2.7):
 *  1. Estado de (contato, finalidade) = ação do evento mais recente por
 *     occurredAt; empate → recordedAt; empate total → REVOKE vence (fail-safe).
 *  2. REVOKE global ('*') revoga todas as finalidades + suprime o telefone.
 *  3. Um GRANT '*' NÃO concede finalidade nenhuma — só levanta a supressão.
 *  4. Um GRANT posterior ao REVOKE global reabre APENAS a finalidade que declara.
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env>,
  ) {}

  private get salt(): string {
    return this.config.get('PICOA_CONSENT_SALT', { infer: true }) ?? '';
  }

  hashOf(phoneE164: string): string {
    return phoneHash(phoneE164, this.salt);
  }

  /**
   * Grava o evento, aplica a precedência, recomputa ContactConsent + os caches
   * de Contact e, em REVOKE global, insere na SuppressionList. Tudo numa
   * transação: um estado derivado que discorda da trilha é pior que não ter
   * estado derivado nenhum.
   */
  async record(input: RecordConsentInput): Promise<{
    eventId: string | null;
    /** false quando o evento foi absorvido como repetição idempotente. */
    created: boolean;
  }> {
    if (
      input.action === ConsentAction.GRANT &&
      (!input.evidenceText || !input.evidenceText.trim())
    ) {
      // Nunca um GRANT sem o texto exibido: o que dá validade ao clique é o
      // corpo de texto acima dele, e a Meta permite editar templates — guardar
      // só o nome do template não prova, em 2028, o que foi exibido em 2026.
      throw new Error(
        'ConsentService.record: GRANT exige evidenceText (o texto renderizado que o titular viu).',
      );
    }

    const occurredAt = input.occurredAt ?? new Date();
    const hash = this.hashOf(input.phoneE164);
    const isGlobal = input.purposeKey === GLOBAL_PURPOSE;

    return this.prisma.$transaction(async (tx) => {
      if (await this.isIdempotentRepeat(tx, input, hash, occurredAt)) {
        return { eventId: null, created: false };
      }

      const event = await tx.consentEvent.create({
        data: {
          contactId: input.contactId ?? null,
          phoneHash: hash,
          purposeKey: input.purposeKey,
          action: input.action,
          source: input.source,
          channelId: input.channelId ?? null,
          senderE164: input.senderE164 ?? null,
          evidenceText: input.evidenceText,
          consentTextVersion: input.consentTextVersion ?? null,
          evidence: input.evidence ?? Prisma.DbNull,
          occurredAt,
          actorUserId: input.actorUserId ?? null,
        },
      });

      if (input.action === ConsentAction.REVOKE && isGlobal) {
        await this.applyGlobalRevoke(tx, input, hash, event);
      } else if (input.action === ConsentAction.REVOKE) {
        await this.recomputePurpose(
          tx,
          input.contactId,
          input.phoneE164,
          input.purposeKey,
        );
      } else if (!isGlobal) {
        await this.recomputePurpose(
          tx,
          input.contactId,
          input.phoneE164,
          input.purposeKey,
        );
        // Regra 4: qualquer GRANT posterior ao REVOKE global levanta a supressão.
        await this.liftSuppression(tx, input.phoneE164);
      } else {
        // GRANT '*' — usado pelo VOLTAR quando não havia finalidade a restaurar:
        // levanta a supressão e não concede nada. O contato volta a poder ser
        // ATENDIDO, não a receber campanha.
        await this.liftSuppression(tx, input.phoneE164);
      }

      await this.refreshContactCache(tx, input.contactId, input.phoneE164);
      return { eventId: event.id, created: true };
    });
  }

  /**
   * VOLTAR (spec §2.7 regra 5). Levanta a supressão E restaura os GRANTs que
   * estavam ativos IMEDIATAMENTE ANTES do REVOKE global — não um `optInAt =
   * now()` genérico, que era exatamente a autorização genérica que o art. 8º §4º
   * anula. Se não havia GRANT anterior, apenas levanta a supressão.
   *
   * @returns as finalidades restauradas (vazio = só a supressão foi levantada).
   */
  async reinstate(input: {
    contactId: string;
    phoneE164: string;
    source: ConsentSource;
    /** Texto que o contato leu (a confirmação de opt-out). */
    evidenceText: string;
    evidence?: Prisma.InputJsonValue;
    channelId?: string | null;
  }): Promise<string[]> {
    // Por phoneHash, não por contactId (C5.3): o VOLTAR de um contato que foi
    // reimportado depois do PARAR precisa achar o REVOKE da encarnação anterior —
    // senão ele só levanta a supressão e o titular perde as finalidades que tinha.
    const lastGlobalRevoke = await this.prisma.consentEvent.findFirst({
      where: {
        phoneHash: { in: phoneHashVariants(input.phoneE164, this.salt) },
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
      },
      orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
    });

    // As linhas que o REVOKE global derrubou carregam o id dele em lastEventId
    // (applyGlobalRevoke só toca em quem estava GRANTED) — ou seja, são
    // exatamente o conjunto que estava ativo um instante antes.
    const toRestore = lastGlobalRevoke
      ? await this.prisma.contactConsent.findMany({
          where: {
            contactId: input.contactId,
            state: ConsentState.REVOKED,
            lastEventId: lastGlobalRevoke.id,
          },
          select: { purposeKey: true },
        })
      : [];

    if (toRestore.length === 0) {
      await this.record({
        contactId: input.contactId,
        phoneE164: input.phoneE164,
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.GRANT,
        source: input.source,
        evidenceText: input.evidenceText,
        evidence: input.evidence,
        channelId: input.channelId,
      });
      return [];
    }

    for (const { purposeKey } of toRestore) {
      await this.record({
        contactId: input.contactId,
        phoneE164: input.phoneE164,
        purposeKey,
        action: ConsentAction.GRANT,
        source: input.source,
        evidenceText: input.evidenceText,
        evidence: input.evidence,
        channelId: input.channelId,
      });
    }
    return toRestore.map((r) => r.purposeKey);
  }

  /**
   * C5.3 — REIDRATA o estado derivado de um contato a partir da trilha do seu
   * `phoneHash`. Chamado sempre que um contato é (re)criado.
   *
   * O buraco que isto fecha: `ContactConsent` é chaveado por `contactId` e cai
   * por CASCATA quando o contato é apagado. A `SuppressionList` sobrevive (é
   * chaveada por `phoneHash`), mas os GRANTs não — então quem consentiu, foi
   * excluído e voltou por reimportação de XLSX renascia SEM consentimento, e o
   * gate (corretamente) o pulava. Pior, um REVOKE por finalidade ("não quero mais
   * convites", sem PARAR) evaporava junto: só o opt-out GLOBAL era durável.
   *
   * O conserto é a própria trilha. `ConsentEvent` é append-only e carrega o
   * `phoneHash`, que sobrevive a tudo — o estado derivado é uma PROJEÇÃO dela, e
   * projeção se recalcula. Note que os eventos antigos continuam apontando para o
   * `contactId` MORTO (o trigger append-only proíbe UPDATE, então não há como
   * "adotá-los"): por isso a reidratação consulta por `phoneHash`, nunca por id.
   *
   * Não cria evento nenhum: reidratar não é um ato do titular. Aplica a mesma
   * precedência do §2.7 (occurredAt → recordedAt → REVOKE vence) e é idempotente.
   *
   * @returns as finalidades que ficaram GRANTED.
   */
  async rehydrate(contactId: string, phoneE164: string): Promise<string[]> {
    const hashes = phoneHashVariants(phoneE164, this.salt);
    const events = await this.prisma.consentEvent.findMany({
      where: { phoneHash: { in: hashes } },
      orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
    });
    if (events.length === 0) return [];

    // O evento mais recente de cada finalidade, e o REVOKE global mais recente.
    // A lista já vem ordenada do mais novo para o mais velho, mas `isNewer`
    // desempata com a regra completa (empate total → REVOKE vence), que um
    // `orderBy` do Postgres não expressa.
    const lastByPurpose = new Map<string, ConsentEvent>();
    let lastGlobalRevoke: ConsentEvent | null = null;
    for (const event of events) {
      if (event.purposeKey === GLOBAL_PURPOSE) {
        if (
          event.action === ConsentAction.REVOKE &&
          (!lastGlobalRevoke || this.isNewer(event, lastGlobalRevoke))
        ) {
          lastGlobalRevoke = event;
        }
        // Um GRANT '*' não concede finalidade nenhuma (regra 4) — ele só levanta
        // a supressão, e quem decide isso é a `SuppressionList`, que é durável e
        // já reflete o desfecho. Ignorá-lo aqui é o comportamento correto.
        continue;
      }
      const current = lastByPurpose.get(event.purposeKey);
      if (!current || this.isNewer(event, current)) {
        lastByPurpose.set(event.purposeKey, event);
      }
    }

    const granted: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const [purposeKey, lastForPurpose] of lastByPurpose) {
        const winner =
          lastGlobalRevoke && !this.isNewer(lastForPurpose, lastGlobalRevoke)
            ? lastGlobalRevoke
            : lastForPurpose;
        const isGranted = winner.action === ConsentAction.GRANT;
        if (isGranted) granted.push(purposeKey);

        await tx.contactConsent.upsert({
          where: { contactId_purposeKey: { contactId, purposeKey } },
          create: {
            contactId,
            purposeKey,
            state: isGranted ? ConsentState.GRANTED : ConsentState.REVOKED,
            lastEventId: winner.id,
            grantedAt: isGranted ? winner.occurredAt : null,
            revokedAt: isGranted ? null : winner.occurredAt,
            source: isGranted ? winner.source : null,
          },
          update: {
            state: isGranted ? ConsentState.GRANTED : ConsentState.REVOKED,
            lastEventId: winner.id,
            ...(isGranted
              ? { grantedAt: winner.occurredAt, source: winner.source }
              : { revokedAt: winner.occurredAt }),
          },
        });
      }

      await this.refreshContactCache(tx, contactId, phoneE164);
    });

    if (granted.length > 0 || lastGlobalRevoke) {
      this.logger.log(
        { contactId, purposes: granted.length, suppressed: !!lastGlobalRevoke },
        'consentimento reidratado a partir da trilha do phoneHash (contato recriado)',
      );
    }
    return granted;
  }

  /** O gate. GRANTED para ESTA finalidade — nunca "tem algum opt-in". */
  async hasConsent(contactId: string, purposeKey: string | null): Promise<boolean> {
    if (!purposeKey || purposeKey === GLOBAL_PURPOSE) return false;
    const row = await this.prisma.contactConsent.findUnique({
      where: { contactId_purposeKey: { contactId, purposeKey } },
      select: { state: true },
    });
    return row?.state === ConsentState.GRANTED;
  }

  /** Revogação é ABSOLUTA (art. 8º §5º) — nem override de ADMIN fura isto. */
  async isSuppressed(phoneE164: string): Promise<boolean> {
    const row = await this.prisma.suppressionList.findFirst({
      where: { phoneHash: { in: phoneHashVariants(phoneE164, this.salt) } },
      select: { phoneHash: true },
    });
    return row !== null;
  }

  /**
   * Versão em lote do hasConsent(), para o gate de dispatch: o loop é paginado e
   * não pode fazer uma consulta por contato. Devolve os contactIds com
   * consentimento ATIVO para ESTA finalidade.
   *
   * Sem `purposeKey` devolve conjunto vazio — campanha sem finalidade não passa
   * ninguém (art. 8º §4º: sem finalidade não há consentimento válido a checar).
   */
  async grantedContactIds(
    contactIds: string[],
    purposeKey: string | null | undefined,
  ): Promise<Set<string>> {
    if (!purposeKey || purposeKey === GLOBAL_PURPOSE || contactIds.length === 0) {
      return new Set();
    }
    const rows = await this.prisma.contactConsent.findMany({
      where: {
        contactId: { in: contactIds },
        purposeKey,
        state: ConsentState.GRANTED,
      },
      select: { contactId: true },
    });
    return new Set(rows.map((r) => r.contactId));
  }

  /**
   * C1b — as finalidades OFERECÍVEIS ao operador (o seletor do wizard).
   *
   * Só as ativas: desativar uma finalidade tira-a de campanhas NOVAS sem apagar
   * a trilha das antigas (os ConsentEvent históricos continuam apontando para
   * ela — é por isso que a FK é RESTRICT e nada aqui deleta linha).
   */
  async listPurposes(): Promise<ConsentPurposeView[]> {
    return this.prisma.consentPurpose.findMany({
      where: { active: true },
      orderBy: { label: 'asc' },
      select: { key: true, label: true, description: true, isSensitive: true },
    });
  }

  /**
   * Resolve uma finalidade ATIVA pela key. É o que a criação de campanha usa
   * para recusar uma `purposeKey` desconhecida: no gate, uma key errada é
   * indistinguível de campanha sem finalidade (`grantedContactIds` devolve
   * vazio) — ou seja, ela pularia 100% dos destinatários em silêncio.
   */
  async findActivePurpose(
    purposeKey: string | null | undefined,
  ): Promise<ConsentPurposeView | null> {
    if (!purposeKey || purposeKey === GLOBAL_PURPOSE) return null;
    return this.prisma.consentPurpose.findFirst({
      where: { key: purposeKey, active: true },
      select: { key: true, label: true, description: true, isSensitive: true },
    });
  }

  /**
   * C1b — quantos contatos da audiência FILTRADA consentiram para esta
   * finalidade. É o número que o wizard mostra antes do disparo.
   *
   * Uma contagem só (relation filter), não uma varredura: a audiência pode ter
   * 13k linhas, e isto roda a cada mudança de filtro/finalidade no wizard.
   * `optedOut` entra no filtro porque um contato suprimido é pulado de qualquer
   * jeito — prometer que ele receberia seria mentira.
   */
  async countGrantedInAudience(
    where: Prisma.ContactWhereInput,
    purposeKey: string | null | undefined,
  ): Promise<number> {
    if (!purposeKey || purposeKey === GLOBAL_PURPOSE) return 0;
    return this.prisma.contact.count({
      where: {
        AND: [
          where,
          { optedOut: false },
          { consents: { some: { purposeKey, state: ConsentState.GRANTED } } },
        ],
      },
    });
  }

  /**
   * Quantos da audiência o GATE deixaria passar — que NÃO é o mesmo que
   * "quantos consentiram".
   *
   * `decide()` (campaigns.service) autoriza por TRÊS caminhos:
   *   granted  ||  janela de atendimento aberta  ||  override
   * e `countGrantedInAudience` só conhece o primeiro. Enquanto essa contagem era
   * DECORATIVA isso era só um número a menos na tela; no momento em que ela
   * passou a travar o botão de disparo, virou o bug do ticket AO CONTRÁRIO: uma
   * campanha `servico_projeto` para quem respondeu nas últimas 24h (envio
   * legítimo, o gate manda) apareceria como "0 de 200" e ficaria INDISPARÁVEL.
   *
   * Por isso esta contagem espelha os dois caminhos que dependem do BANCO
   * (granted ∪ janela). O terceiro (override) é decisão do operador, resolvida
   * no dispatch — a UI não o antecipa, apenas não bloqueia quando ele está
   * marcado.
   *
   * A janela só é consultada quando `window` é passada: quem decide se ela vale
   * para esta finalidade é o chamador (WINDOW_ELIGIBLE_PURPOSE), exatamente como
   * no gate — assim não existe uma segunda regra de elegibilidade aqui.
   */
  async countEligibleInAudience(
    where: Prisma.ContactWhereInput,
    purposeKey: string | null | undefined,
    window?: { instanceId: string; since: Date } | null,
  ): Promise<number> {
    if (!purposeKey || purposeKey === GLOBAL_PURPOSE) return 0;
    const paths: Prisma.ContactWhereInput[] = [
      { consents: { some: { purposeKey, state: ConsentState.GRANTED } } },
    ];
    if (window) {
      paths.push({
        conversations: {
          some: {
            instanceId: window.instanceId,
            lastInboundAt: { gt: window.since },
          },
        },
      });
    }
    return this.prisma.contact.count({
      where: { AND: [where, { optedOut: false }, { OR: paths }] },
    });
  }

  /**
   * art. 11 — para dado sensível o legítimo interesse simplesmente não existe.
   * O gate usa isto para RECUSAR override em finalidade sensível (não é aviso
   * de UI: é recusa).
   */
  async isSensitivePurpose(purposeKey: string | null | undefined): Promise<boolean> {
    if (!purposeKey || purposeKey === GLOBAL_PURPOSE) return false;
    const purpose = await this.prisma.consentPurpose.findUnique({
      where: { key: purposeKey },
      select: { isSensitive: true },
    });
    return purpose?.isSensitive === true;
  }

  /**
   * Versão em lote do isSuppressed(), para o pipeline de importação: uma
   * planilha de 13k linhas não pode virar 13k round-trips. Devolve o subconjunto
   * de `phones` (nas MESMAS strings recebidas) que está suprimido.
   */
  async suppressedPhones(phones: string[]): Promise<Set<string>> {
    if (phones.length === 0) return new Set();

    // hash (de qualquer variante) → telefone original, para devolver ao chamador
    // exatamente a string que ele passou.
    const byHash = new Map<string, string>();
    for (const phone of phones) {
      for (const h of phoneHashVariants(phone, this.salt)) byHash.set(h, phone);
    }

    const hashes = [...byHash.keys()];
    const found = new Set<string>();
    for (let i = 0; i < hashes.length; i += SUPPRESSION_LOOKUP_CHUNK) {
      const rows = await this.prisma.suppressionList.findMany({
        where: { phoneHash: { in: hashes.slice(i, i + SUPPRESSION_LOOKUP_CHUNK) } },
        select: { phoneHash: true },
      });
      for (const r of rows) {
        const phone = byHash.get(r.phoneHash);
        if (phone) found.add(phone);
      }
    }
    return found;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Repetição idempotente: mesma (finalidade, ação, fonte) numa janela de 24h
   * de `occurredAt` E o estado atual JÁ correspondendo à ação. Cobre a
   * redelivery de webhook (o mesmo `optin_yes` chegando duas vezes) e a regra da
   * landing (§3.2: 1 GRANT por telefone+finalidade a cada 24h).
   *
   * As DUAS condições são necessárias. Só a janela engoliria um re-consentimento
   * legítimo: GRANT 10:00 → PARAR 10:30 → GRANT 10:45 casaria com o GRANT das
   * 10:00 e o titular ficaria revogado apesar de ter reconsentido — um opt-in
   * silenciosamente perdido. Só o estado não deduplicaria nada.
   */
  private async isIdempotentRepeat(
    tx: Prisma.TransactionClient,
    input: RecordConsentInput,
    hash: string,
    occurredAt: Date,
  ): Promise<boolean> {
    const recent = await tx.consentEvent.findFirst({
      where: {
        phoneHash: hash,
        purposeKey: input.purposeKey,
        action: input.action,
        source: input.source,
        occurredAt: { gte: new Date(occurredAt.getTime() - IDEMPOTENCY_WINDOW_MS) },
      },
      orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
      select: { id: true },
    });
    if (!recent) return false;

    return this.stateAlreadyMatches(tx, input, hash);
  }

  /** O estado derivado atual já é o que este evento produziria? */
  private async stateAlreadyMatches(
    tx: Prisma.TransactionClient,
    input: RecordConsentInput,
    hash: string,
  ): Promise<boolean> {
    const suppressed =
      (await tx.suppressionList.findFirst({
        where: { phoneHash: { in: phoneHashVariants(input.phoneE164, this.salt) } },
        select: { phoneHash: true },
      })) !== null;

    const isGlobal = input.purposeKey === GLOBAL_PURPOSE;
    if (isGlobal) {
      return input.action === ConsentAction.REVOKE ? suppressed : !suppressed;
    }

    if (!input.contactId) return false;
    const row = await tx.contactConsent.findUnique({
      where: {
        contactId_purposeKey: { contactId: input.contactId, purposeKey: input.purposeKey },
      },
      select: { state: true },
    });

    if (input.action === ConsentAction.GRANT) {
      // Um GRANT só é "repetição" se a finalidade já está concedida E o titular
      // não está suprimido — senão este GRANT tem trabalho a fazer (regra 4:
      // levantar a supressão).
      return row?.state === ConsentState.GRANTED && !suppressed;
    }
    return row?.state === ConsentState.REVOKED;
  }

  /**
   * REVOKE global: derruba TODAS as finalidades ainda GRANTED (só elas — as já
   * revogadas mantêm o lastEventId original, que é o que permite ao VOLTAR
   * saber o que estava ativo) e insere na SuppressionList.
   */
  private async applyGlobalRevoke(
    tx: Prisma.TransactionClient,
    input: RecordConsentInput,
    hash: string,
    event: ConsentEvent,
  ): Promise<void> {
    if (input.contactId) {
      await tx.contactConsent.updateMany({
        where: { contactId: input.contactId, state: ConsentState.GRANTED },
        data: {
          state: ConsentState.REVOKED,
          revokedAt: event.occurredAt,
          lastEventId: event.id,
        },
      });
    }

    await tx.suppressionList.upsert({
      where: { phoneHash: hash },
      create: {
        phoneHash: hash,
        phoneE164: input.phoneE164,
        reason: input.suppressionReason ?? 'manual',
        scope: 'ALL',
        lastEventId: event.id,
        suppressedAt: event.occurredAt,
      },
      update: {
        reason: input.suppressionReason ?? 'manual',
        lastEventId: event.id,
        suppressedAt: event.occurredAt,
      },
    });
  }

  private async liftSuppression(
    tx: Prisma.TransactionClient,
    phoneE164: string,
  ): Promise<void> {
    await tx.suppressionList.deleteMany({
      where: { phoneHash: { in: phoneHashVariants(phoneE164, this.salt) } },
    });
  }

  /**
   * Recomputa o estado de (contato, finalidade) a partir da TRILHA — nunca a
   * partir do que o chamador achou que ia acontecer. Um GRANT retroativo (ficha
   * de papel assinada há 3 meses) não pode sobrescrever um REVOKE de ontem, e
   * essa é exatamente a diferença entre `occurredAt` e `recordedAt`.
   *
   * A trilha é lida por `phoneHash`, NÃO por `contactId` (C5.3). O `contactId` é
   * descartável: o contato é apagado e reimportado por planilha, e renasce com um
   * cuid novo. Um recompute chaveado nele enxergaria apenas os eventos da
   * encarnação ATUAL — e a ficha de papel de janeiro, importada em julho depois de
   * um PARAR de junho, passaria a valer, porque o PARAR ficou na encarnação
   * anterior. Seria um opt-out ressuscitado em silêncio, que é precisamente o que
   * a chave durável existe para impedir.
   */
  private async recomputePurpose(
    tx: Prisma.TransactionClient,
    contactId: string | null | undefined,
    phoneE164: string,
    purposeKey: string,
  ): Promise<void> {
    if (!contactId) return;
    const hashes = phoneHashVariants(phoneE164, this.salt);

    const lastForPurpose = await tx.consentEvent.findFirst({
      where: { phoneHash: { in: hashes }, purposeKey },
      orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
    });
    if (!lastForPurpose) return;

    const lastGlobalRevoke = await tx.consentEvent.findFirst({
      where: {
        phoneHash: { in: hashes },
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
      },
      orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
    });

    // Um GRANT '*' é deliberadamente ignorado aqui: ele levanta a supressão, mas
    // NÃO concede finalidade (regra 4 — a autorização genérica é nula).
    const winner =
      lastGlobalRevoke && !this.isNewer(lastForPurpose, lastGlobalRevoke)
        ? lastGlobalRevoke
        : lastForPurpose;

    const granted = winner.action === ConsentAction.GRANT;
    await tx.contactConsent.upsert({
      where: { contactId_purposeKey: { contactId, purposeKey } },
      create: {
        contactId,
        purposeKey,
        state: granted ? ConsentState.GRANTED : ConsentState.REVOKED,
        lastEventId: winner.id,
        grantedAt: granted ? winner.occurredAt : null,
        revokedAt: granted ? null : winner.occurredAt,
        source: granted ? winner.source : null,
      },
      update: {
        state: granted ? ConsentState.GRANTED : ConsentState.REVOKED,
        lastEventId: winner.id,
        ...(granted
          ? { grantedAt: winner.occurredAt, source: winner.source }
          : { revokedAt: winner.occurredAt }),
      },
    });
  }

  /**
   * Ordem estrita da spec §2.7: occurredAt, depois recordedAt; empate total →
   * REVOKE vence. `a` é estritamente mais novo que `b`?
   */
  private isNewer(
    a: Pick<ConsentEvent, 'occurredAt' | 'recordedAt' | 'action'>,
    b: Pick<ConsentEvent, 'occurredAt' | 'recordedAt' | 'action'>,
  ): boolean {
    if (a.occurredAt.getTime() !== b.occurredAt.getTime()) {
      return a.occurredAt.getTime() > b.occurredAt.getTime();
    }
    if (a.recordedAt.getTime() !== b.recordedAt.getTime()) {
      return a.recordedAt.getTime() > b.recordedAt.getTime();
    }
    // Empate total: REVOKE vence → `a` só é "mais novo" se `b` for o GRANT.
    return a.action === ConsentAction.REVOKE && b.action === ConsentAction.GRANT;
  }

  /**
   * Reprojeta os caches de Contact a partir do estado derivado:
   *   optInAt     = grantedAt do GRANT ativo mais recente de QUALQUER finalidade
   *   optInSource = source desse mesmo evento
   *   optedOut    = existe supressão para o telefone
   * Nenhum outro ponto do código escreve estes três campos.
   */
  private async refreshContactCache(
    tx: Prisma.TransactionClient,
    contactId: string | null | undefined,
    phoneE164: string,
  ): Promise<void> {
    if (!contactId) return;

    const active = await tx.contactConsent.findMany({
      where: { contactId, state: ConsentState.GRANTED },
      orderBy: { grantedAt: 'desc' },
      take: 1,
    });
    const latest = active[0];

    const suppressed = await tx.suppressionList.findFirst({
      where: { phoneHash: { in: phoneHashVariants(phoneE164, this.salt) } },
      select: { phoneHash: true },
    });

    await tx.contact.update({
      where: { id: contactId },
      data: {
        optInAt: latest?.grantedAt ?? null,
        optInSource: latest?.source ?? null,
        optedOut: suppressed !== null,
      },
    });
  }
}
