import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import type { Channel } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { QUEUE_NAMES, type ContactSyncJob } from '../queue/queue.constants';
import { ContactsRepository } from './contacts.repository';
import { isWithinSendWindow } from './send-window.util';
import { resolveSyncChannel } from './resolve-sync-channel.util';
import {
  ChannelOfflineForSyncError,
  SyncNotSupportedError,
  SyncOutsideSendWindowError,
} from './errors/contacts.errors';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';

/** Minimal contact shape this processor reads/writes. */
type SyncContact = {
  id: string;
  phoneE164: string;
  whatsappValid: boolean | null;
};

/** A contact confirmed reachable on WhatsApp, with its resolved JID (if any). */
type ValidBucket = { id: string; jid: string | null };

/** Result of splitting a batch by WhatsApp reachability. */
type Reachability = {
  validBuckets: ValidBucket[];
  invalidContacts: SyncContact[];
  /**
   * `exists: null` = NÃO SEI (o `/chat/check` respondeu com o número de outro
   * assinante, ou com um 200 que não reconhecemos) — nunca "não está no
   * WhatsApp". Estes contatos NÃO recebem veredito (`whatsappValid` fica
   * intocado), mas recebem CARIMBO — ver `applyUnknownUpdates`.
   */
  unknownContacts: SyncContact[];
  validCount: number;
  invalidCount: number;
  unknownCount: number;
};

/** Max profile-picture fetches in flight per batch (spec §2.4). */
const PARALLEL_PICTURE_FETCHES = 10;

/**
 * ★ CONCORRÊNCIA 1 — FIX ROUND 1 (revisão pós-commit).
 *
 * A nota anterior deste bloco afirmava que os jobs concorrentes "disputam o
 * MESMO campo e saem serializados" (`lastCheckCallAt`, em `GozapCloudAdapter`)
 * — ERRADO. Aquele campo é lido, DEPOIS esperado (`await clock.sleep(wait)`),
 * e só ENTÃO escrito (`gozap-cloud.adapter.ts`) — não é uma reserva atômica.
 * Sob `concurrency: 3`, três `process()` rodando ao mesmo tempo podiam cada
 * um LER o mesmo `lastCheckCallAt` antes de qualquer um ESCREVER, calcular o
 * MESMO `wait`, dormir juntos e disparar as 3 chamadas HTTP juntas — rajadas
 * de ~3× o ritmo configurado (`GOZAP_CHECK_RATE_PER_MIN`) num cliente NÃO
 * OFICIAL que já foi banido antes.
 *
 * `concurrency: 1` corrige isto: um único job por vez, então o laço de
 * pacing dentro do adapter nunca tem concorrência com quem disputar. Isto
 * NÃO resolve múltiplos WORKERS (processos Node separados, cada um com seu
 * próprio `lastCheckCallAt`) — produção roda um único worker hoje; um
 * limitador por-canal com estado em REDIS (compartilhado entre processos) é
 * pré-requisito antes de subir um segundo worker, e ainda não existe.
 */
@Processor(QUEUE_NAMES.CONTACT_SYNC, { concurrency: 1 })
export class ContactSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ContactSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappProvidersService,
    private readonly audit: AuditService,
    private readonly instancesRepo: WhatsappInstancesRepository,
    private readonly contactsRepo: ContactsRepository,
  ) {
    super();
  }

  async process(job: Job<ContactSyncJob>): Promise<void> {
    const { contactIds, triggeredBy } = job.data;

    // A validação de número deixou de ser "Evolution ou nada": qualquer canal
    // ATIVO e DEFAULT cujo adapter implemente checkNumbersOnWhatsapp serve
    // (hoje Evolution e GoZap) — `resolveSyncChannel` decide QUAL, entre
    // vários defaults por-provedor (fix round 1, item #5 — `findDefault()`
    // sem provider pegava o mais VELHO entre todos, que podia ser um canal
    // morto). Sem candidato algum não há como validar — não é uma FALHA do
    // job, é um estado de CONFIGURAÇÃO: pula em silêncio (debug), sem
    // lançar; o cron re-seleciona estes contatos amanhã, porque
    // `whatsappCheckedAt` continua NULL.
    let channel: Channel;
    try {
      channel = await resolveSyncChannel(
        this.instancesRepo,
        this.wa,
        this.contactsRepo,
      );
    } catch (err) {
      if (err instanceof SyncNotSupportedError) {
        this.logger.debug(
          `contact-sync skipped (${contactIds.length} ids) — nenhum canal ativo padrão sabe validar números`,
        );
        return;
      }
      throw err;
    }

    // ★ FIX ROUND 1, item #2 — o cron periódico ('periodic') roda toda
    // noite, sempre na MESMA hora. Se essa hora cair fora da janela do canal
    // (era o caso antes desta correção: cron às 06:00 UTC = 02:00 Manaus,
    // janela padrão 08h–20h — worker.ts corrigido para 13:00 UTC = 09:00
    // Manaus, mas o gate abaixo é o que impede a PRÓXIMA vez que os dois
    // horários divergirem de virar falha permanente), o cron não fez PEDIDO
    // NENHUM que mereça aparecer como erro: pula graciosamente, audita as
    // contagens, sem lançar, sem retentar. Já o clique do operador
    // (`backfill`) e a criação/importação de contato continuam recusando
    // ALTO (`UnrecoverableError` abaixo) — é um pedido explícito, e "por que
    // não fez nada?" merece um erro visível, não um log silencioso.
    if (!isWithinSendWindow(new Date(), channel)) {
      if (triggeredBy === 'periodic') {
        this.logger.debug(
          `contact-sync skipped (${contactIds.length} ids) — fora da janela de envio do canal; o cron periódico não força fora do horário`,
        );
        await this.audit.log(
          'contact.sync_skipped_outside_window',
          'Contact',
          undefined,
          { channelId: channel.id, count: contactIds.length, triggeredBy },
        );
        return;
      }
      this.abort(
        new SyncOutsideSendWindowError(
          channel.sendWindowStartHour,
          channel.sendWindowEndHour,
        ),
      );
    }
    // ★ REVISÃO FINAL DA FASE B — o MESMO raciocínio do gate de janela acima,
    // aplicado ao gate de canal offline. Ele abortava ALTO para todo mundo,
    // inclusive o cron: com a sessão do GoZap caída (o estado normal quando o
    // QR expira de madrugada), a varredura noturna enfileira ~100 lotes e os
    // 100 falham VERMELHOS, toda noite. Isso treina o operador a ignorar o
    // Bull Board — justamente onde as falhas de verdade aparecem. O cron não
    // fez pedido nenhum: não há o que reportar como erro, só um fato a
    // registrar. O clique do operador continua recusando alto.
    //
    // O evento de auditoria é `contact.sync_skipped_channel_offline`, e NÃO o
    // `contact.sync_aborted_channel_offline` usado logo abaixo (no meio do
    // lote): "abortado" descreve um lote que COMEÇOU e morreu no caminho —
    // chamar de "abortado" um lote que nunca começou apagaria a diferença
    // entre "a sessão caiu durante a validação" e "a sessão já estava fora
    // quando o cron acordou".
    if (!(await this.contactsRepo.isSessionChannelOnline(channel))) {
      if (triggeredBy === 'periodic') {
        this.logger.debug(
          `contact-sync skipped (${contactIds.length} ids) — canal de sessão offline; o cron periódico não falha por isso`,
        );
        await this.audit.log(
          'contact.sync_skipped_channel_offline',
          'Contact',
          undefined,
          { channelId: channel.id, count: contactIds.length, triggeredBy },
        );
        return;
      }
      this.abort(new ChannelOfflineForSyncError(channel.id));
    }

    const contacts = await this.prisma.contact.findMany({
      where: { id: { in: contactIds } },
      select: { id: true, phoneE164: true, whatsappValid: true },
    });
    if (contacts.length === 0) return;

    const phones = contacts.map((c) => c.phoneE164);
    let results: Array<{
      exists: boolean | null;
      jid: string | null;
      number: string;
    }>;
    try {
      results = await this.wa.checkNumbersOnWhatsappVia(channel, phones);
    } catch (err) {
      // Um lote de 50 leva ~75s no ritmo de 40/min: dá tempo de a sessão cair
      // no meio. O erro cru do adapter ("socket hang up") não diz nada ao
      // operador; reclassificar diz.
      if (!(await this.contactsRepo.isSessionChannelOnline(channel))) {
        await this.audit.log(
          'contact.sync_aborted_channel_offline',
          'Contact',
          undefined,
          { channelId: channel.id, count: contacts.length, triggeredBy },
        );
        this.abort(new ChannelOfflineForSyncError(channel.id));
      }

      // ★ REDE DE SEGURANÇA (a pílula de veneno foi curada NA ORIGEM).
      //
      // Historicamente o adapter GoZap LANÇAVA `gozap.check_unknown_response`
      // ao ver um HTTP 200 sem `IsIn` reconhecível — e como ele processa o
      // lote num laço só, a exceção descartava o progresso do lote INTEIRO.
      // Nada era marcado, `whatsappCheckedAt` continuava NULL, e o cron
      // reselecionava o MESMO lote amanhã: consultas reais, pagas, repetidas
      // para sempre. Um fix seguinte passou a devolver o já consultado, mas
      // ainda ENCERRAVA o lote e marcava todo o restante como não
      // confirmado — e como `findIdsForSync` não tem `orderBy`, o
      // número-veneno se reformava na MESMA posição amanhã, nunca deixando
      // quem vinha depois dele ser consultado de verdade. A revisão final da
      // Fase B corrigiu isso de vez NO ADAPTER: ele agora marca só AQUELE
      // número como `exists: null` ("não sei") e CONTINUA consultando os
      // próximos do lote — que este processor carimba com
      // `whatsappCheckedAt` sem gravar veredito (ver `applyUnknownUpdates`).
      //
      // Este bloco fica como REDE: o código de erro faz parte do vocabulário
      // do port, e qualquer adapter (ou uma regressão neste) que volte a
      // lançá-lo não pode virar 3 retentativas contra a mesma resposta
      // irreconhecível. `UnrecoverableError`: falha VISÍVEL no Bull Board, UMA
      // tentativa, contatos intocados.
      if (
        err instanceof WhatsappSendError &&
        err.providerErrorCode === 'gozap.check_unknown_response'
      ) {
        this.logger.warn(
          `contact-sync: lote de ${contacts.length} ids abortado — o canal ${channel.id} devolveu uma resposta que o provedor não reconhece; ninguém foi marcado`,
        );
        await this.audit.log(
          'contact.sync_batch_unknown_response',
          'Contact',
          undefined,
          { channelId: channel.id, count: contacts.length, triggeredBy },
        );
        throw new UnrecoverableError(
          'GoZap devolveu uma resposta que o /chat/check não reconhece — lote abortado, nenhum contato foi marcado.',
        );
      }

      throw err;
    }

    const now = new Date();
    const {
      validBuckets,
      invalidContacts,
      unknownContacts,
      validCount,
      invalidCount,
      unknownCount,
    } = this.classifyByReachability(contacts, results);

    // Foto de perfil é feature do Evolution (`fetchProfilePictureUrl`); o
    // GoZap não a implementa, e `this.wa.fetchProfilePictureUrl` resolveria o
    // adapter EVOLUTION — buscando avatar na instância ERRADA, uma chamada por
    // contato, todas falhando em silêncio.
    const pictures =
      channel.provider === 'EVOLUTION' && channel.evolutionInstanceName
        ? await this.fetchPicturesInParallel(
            validBuckets,
            channel.evolutionInstanceName,
          )
        : new Map<string, string | null>();

    await this.applyValidUpdates(validBuckets, pictures, now);
    await this.applyInvalidUpdates(invalidContacts, now);
    await this.applyUnknownUpdates(unknownContacts, now);

    await this.audit.log('contact.sync_batch', 'Contact', undefined, {
      count: contacts.length,
      validCount,
      invalidCount,
      unknownCount,
      triggeredBy,
      provider: channel.provider,
    });
  }

  /**
   * Fix round 1, item #3 — os abortos DETERMINÍSTICOS (canal offline, fora
   * da janela) não são erros TRANSITÓRIOS: tentar de novo sem que nada mude
   * (o canal continua offline, o relógio não anda pra trás) só queima os 3
   * `attempts` configurados para esta fila (`queue.module.ts`) até falhar de
   * qualquer jeito — 3× mais devagar para chegar no mesmo lugar.
   * `UnrecoverableError` (BullMQ) avisa o worker para NÃO tentar de novo:
   * falha visível no Bull Board, UMA tentativa, contatos intocados.
   */
  private abort(reason: { message: string }): never {
    throw new UnrecoverableError(reason.message);
  }

  /**
   * Split a batch into reachable (valid), unreachable (invalid), and
   * unconfirmed (unknown) contacts based on the WhatsApp number-check
   * results. Contacts with no matching result entry are silently ignored
   * (neither bucketed nor counted).
   *
   * `exists` is tri-state (fix round 2 — design ruling, Task 11 review):
   * `null` means the adapter could not confirm nor deny (e.g. GoZap's
   * `/chat/check` answered with a different subscriber's number). Those
   * contacts are neither valid nor invalid — writing `whatsappValid:false`
   * from a `null` would turn "não sei" into a DURABLE "inválido" the moment
   * a non-Evolution provider feeds this path. The minimal, correct handling
   * here is to skip: no update either way, just counted for the summary.
   * The full UI/consumer treatment of "unconfirmed" is Task 12's job.
   */
  private classifyByReachability(
    contacts: SyncContact[],
    results: Array<{
      number: string;
      exists: boolean | null;
      jid: string | null;
    }>,
  ): Reachability {
    const byNumber = new Map<
      string,
      { exists: boolean | null; jid: string | null }
    >();
    for (const r of results) {
      byNumber.set(r.number, { exists: r.exists, jid: r.jid });
    }

    // Bucket the valid contacts so we can fetch profile pictures in parallel
    // (cap 10 concurrent fetches per batch — matches spec §2.4). The invalid
    // path does not need a fetch.
    const validBuckets: ValidBucket[] = [];
    const invalidContacts: SyncContact[] = [];
    const unknownContacts: SyncContact[] = [];
    let validCount = 0;
    let invalidCount = 0;
    let unknownCount = 0;
    for (const c of contacts) {
      const key = c.phoneE164.replace(/^\+/, '');
      const r = byNumber.get(key);
      if (!r) continue;
      if (r.exists === true) {
        validCount += 1;
        validBuckets.push({ id: c.id, jid: r.jid });
      } else if (r.exists === false) {
        invalidCount += 1;
        invalidContacts.push(c);
      } else {
        // r.exists === null: não confirmado. Sem veredito, MAS com carimbo
        // (ver `applyUnknownUpdates`).
        unknownCount += 1;
        unknownContacts.push(c);
      }
    }

    return {
      validBuckets,
      invalidContacts,
      unknownContacts,
      validCount,
      invalidCount,
      unknownCount,
    };
  }

  /**
   * Fetch profile pictures for the valid buckets, capped at
   * PARALLEL_PICTURE_FETCHES in flight. Returns Map<id, url|null>; a null value
   * means no successful fetch happened (jid missing / fetch threw) so callers
   * must not overwrite a cached value (review #1: previously the processor wrote
   * null on every restricted/404 fetch, eventually wiping all cached avatars).
   */
  private async fetchPicturesInParallel(
    validBuckets: ValidBucket[],
    instanceName: string,
  ): Promise<Map<string, string | null>> {
    const pictures = new Map<string, string | null>();
    for (let i = 0; i < validBuckets.length; i += PARALLEL_PICTURE_FETCHES) {
      const slice = validBuckets.slice(i, i + PARALLEL_PICTURE_FETCHES);
      const settled = await Promise.all(
        slice.map(async ({ id, jid }) => {
          if (!jid) return { id, url: null };
          try {
            const url = await this.wa.fetchProfilePictureUrl(jid, instanceName);
            return { id, url };
          } catch {
            return { id, url: null };
          }
        }),
      );
      for (const { id, url } of settled) pictures.set(id, url);
    }
    return pictures;
  }

  /**
   * Mark valid contacts as reachable. Only includes profilePictureUrl in the
   * update payload when a non-empty URL was fetched — preserves the
   * previously-cached avatar when the current fetch returned null/empty
   * (profile private / 404 / transient).
   */
  private async applyValidUpdates(
    validBuckets: ValidBucket[],
    pictures: Map<string, string | null>,
    now: Date,
  ): Promise<void> {
    for (const { id } of validBuckets) {
      const fetched = pictures.get(id);
      const data: {
        whatsappValid: true;
        whatsappCheckedAt: Date;
        profilePictureUrl?: string;
      } = {
        whatsappValid: true,
        whatsappCheckedAt: now,
      };
      if (typeof fetched === 'string' && fetched.length > 0) {
        data.profilePictureUrl = fetched;
      }
      await this.prisma.contact.update({ where: { id }, data });
    }
  }

  /**
   * Mark invalid contacts as unreachable, and audit-log only those that flip
   * away from a previously-invalid state (null/true → invalid).
   */
  private async applyInvalidUpdates(
    invalidContacts: SyncContact[],
    now: Date,
  ): Promise<void> {
    for (const c of invalidContacts) {
      await this.prisma.contact.update({
        where: { id: c.id },
        data: { whatsappValid: false, whatsappCheckedAt: now },
      });
      if (c.whatsappValid !== false) {
        await this.audit.log('contact.sync_marked_invalid', 'Contact', c.id, {
          previousValue: c.whatsappValid,
        });
      }
    }
  }

  /**
   * ★ REVISÃO FINAL DA FASE B (importante) — o NÃO CONFIRMADO era repago toda
   * noite.
   *
   * `exists: null` é "não sei", não um veredito. A versão anterior apenas
   * CONTAVA esses contatos: nada era gravado, nem sequer `whatsappCheckedAt`.
   * Como a seleção do cron é por `whatsappCheckedAt` vencido, o mesmo contato
   * voltava amanhã, e depois de amanhã — uma consulta real, paga, ao GoZap,
   * para receber o mesmo "não sei". Cada consulta desperdiçada é risco de
   * bloqueio gasto à toa num cliente que já perdeu um número.
   *
   * Grava o CARIMBO e MAIS NADA. `whatsappValid` fica intocado de propósito
   * (`false` transformaria "não sei" numa mentira DURÁVEL, e o contato sumiria
   * de toda campanha), e `lastFailureReason` também não é escrito — nada aqui
   * falhou no ENVIO. O contato continua dentro do N de "Validar não validados"
   * (`unvalidatedContactWhere` chaveia em `whatsappValid: null`), então o
   * operador pode reexaminá-lo por clique quando quiser; o que muda é que o
   * cron para de martelá-lo diariamente.
   *
   * `updateMany` (e não N `update`s): não há nada por-contato a decidir aqui —
   * é o mesmo carimbo para todos —, e o lote é de até 50.
   */
  private async applyUnknownUpdates(
    unknownContacts: SyncContact[],
    now: Date,
  ): Promise<void> {
    if (unknownContacts.length === 0) return;
    await this.prisma.contact.updateMany({
      where: { id: { in: unknownContacts.map((c) => c.id) } },
      data: { whatsappCheckedAt: now },
    });
  }
}
