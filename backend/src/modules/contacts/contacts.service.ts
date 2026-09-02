import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ContactsRepository,
  type ContactUpdateData,
  type ListContactsArgs,
} from './contacts.repository';
import {
  ContactNotFoundError,
  ContactPhoneConflictError,
  ContactBulkDeleteCountMismatchError,
  InvalidPhoneError,
  ChannelOfflineForSyncError,
  SyncOutsideSendWindowError,
} from './errors/contacts.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { ConsentService, GLOBAL_PURPOSE } from '../consent/consent.service';
import { OrganizationService } from '../organization/organization.service';
import { ConsentAction, ConsentSource, type Prisma } from '@prisma/client';
import { normalizeToE164, brazilianPhoneVariants } from './phone.util';
import type {
  CreateContact,
  ListContactsQuery,
  UpdateContact,
} from '../../schemas/contracts/contact.schema';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { QUEUE_NAMES, type ContactSyncJob } from '../queue/queue.constants';
import { contactValidityWhere } from '../../shared/contact-validity';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { isWithinSendWindow } from './send-window.util';
import { resolveSyncChannel } from './resolve-sync-channel.util';

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly repo: ContactsRepository,
    private readonly audit: AuditService,
    private readonly wa: WhatsappProvidersService,
    @InjectQueue(QUEUE_NAMES.CONTACT_SYNC)
    private readonly syncQueue: Queue<ContactSyncJob>,
    private readonly consent: ConsentService,
    private readonly organization: OrganizationService,
    // B.5 — a validação ativa precisa saber QUAL canal vai fazê-la: a decisão
    // deixou de ser "existe Evolution no deploy?" e passou a ser "o canal
    // padrão sabe checar número, está online e dentro da janela?".
    private readonly instancesRepo: WhatsappInstancesRepository,
  ) {}

  async list(q: ListContactsQuery) {
    const { items, total } = await this.repo.listPaginated(q as ListContactsArgs);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  facets() {
    return this.repo.facets();
  }

  async create(input: CreateContact) {
    const phoneE164 = normalizeToE164(input.phone);
    if (!phoneE164) throw new InvalidPhoneError(input.phone);
    // C5 — o conflito é do TITULAR, não da string. `+5592995550101` e
    // `+559295550101` são a mesma conta de WhatsApp: casar por igualdade exata
    // deixava o operador criar o gêmeo sem nenhum aviso. A mensagem nomeia a
    // grafia JÁ CADASTRADA, para que ele entenda por que o número "novo" colide.
    const existing = await this.repo.findByAnyBrForm(phoneE164);
    if (existing) throw new ContactPhoneConflictError(existing.phoneE164);

    const result = await this.repo.create({
      phoneE164,
      name: input.name,
      city: input.city,
      group: input.group,
      tags: input.tags,
    });
    await this.audit.log('contact.create', 'Contact', result.id, {
      phoneE164,
    });
    await this.rehydrateConsent(result.id, phoneE164);
    await this.linkExistingConversations(result.id, phoneE164);
    this.enqueueSync([result.id], 'create');
    return result;
  }

  /**
   * C5.3 — um contato NOVO não é necessariamente uma PESSOA nova.
   *
   * `ContactConsent` cai por cascata quando o contato é apagado; a trilha
   * (`ConsentEvent`, append-only) não, porque é chaveada pelo `phoneHash` durável.
   * Recriar o contato — pela UI ou pela planilha — tem de reprojetar o estado
   * derivado a partir dela: senão quem já tinha consentido renasce sem
   * consentimento (o gate o pula, e a pessoa deixa de receber o que autorizou), e
   * quem já tinha revogado uma finalidade renasce sem a revogação.
   *
   * Best-effort: a falha não desfaz a criação. O contato sem estado derivado é
   * pulado pelo gate (lado seguro), e uma reexecução do fluxo o conserta.
   */
  private async rehydrateConsent(
    contactId: string,
    phoneE164: string,
  ): Promise<void> {
    try {
      const purposes = await this.consent.rehydrate(contactId, phoneE164);
      if (purposes.length > 0) {
        this.logger.log(
          { contactId, purposes: purposes.length },
          'consentimento reidratado a partir da trilha do phoneHash',
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        { err, contactId },
        'falha ao reidratar o consentimento',
      );
    }
  }

  /**
   * Best-effort: attach conversations that already exist for this phone (e.g. an
   * inbound chat or an outbound campaign that arrived before the contact was
   * created) so the inbox shows the contact's name instead of a raw number.
   * Matches across both Brazilian 9th-digit forms. Never fails the create.
   */
  private async linkExistingConversations(
    contactId: string,
    phoneE164: string,
  ): Promise<void> {
    try {
      const linked = await this.repo.linkConversationsByPhone(
        contactId,
        brazilianPhoneVariants(phoneE164),
      );
      if (linked > 0) {
        await this.audit.log('contact.conversations_linked', 'Contact', contactId, {
          linked,
        });
      }
    } catch (err) {
      this.logger.warn({ err, contactId }, 'Failed to link existing conversations');
    }
  }

  private enqueueSync(
    contactIds: string[],
    triggeredBy: ContactSyncJob['triggeredBy'],
  ): void {
    this.syncQueue
      .add('sync', { contactIds, triggeredBy })
      .catch((err) =>
        this.logger.warn({ err }, 'Failed to enqueue contact sync'),
      );
  }

  async update(id: string, data: UpdateContact) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new ContactNotFoundError(id);

    // C1 — `optedOut` é CACHE derivado da SuppressionList. Escrevê-lo direto na
    // linha (o que este endpoint fazia) produzia um opt-out que (a) não deixava
    // trilha, e (b) evaporava na próxima reimportação da planilha. O operador
    // continua podendo suprimir/reativar pela UI, mas o caminho é o mesmo de
    // todo mundo: ConsentService.record(), com fonte MANUAL_ADMIN.
    const { optedOut, ...rest } = data as UpdateContact & { optedOut?: boolean };
    if (optedOut !== undefined) {
      // O `evidenceText` NOMEIA a organização: ele é a prova de QUEM registrou a
      // revogação (art. 8º §2º). Vem da configuração, nunca de uma constante.
      const orgName = (await this.organization.get()).name;
      if (optedOut) {
        await this.consent.record({
          contactId: id,
          phoneE164: existing.phoneE164,
          purposeKey: GLOBAL_PURPOSE,
          action: ConsentAction.REVOKE,
          source: ConsentSource.MANUAL_ADMIN,
          evidenceText: `Opt-out registrado manualmente por um operador de ${orgName} no painel.`,
          suppressionReason: 'manual',
        });
      } else {
        // Reativação manual: levanta a supressão e restaura os GRANTs que
        // estavam ativos antes dela — não inventa consentimento novo.
        await this.consent.reinstate({
          contactId: id,
          phoneE164: existing.phoneE164,
          source: ConsentSource.MANUAL_ADMIN,
          evidenceText: `Reativação registrada manualmente por um operador de ${orgName} no painel.`,
        });
      }
    }

    const result = Object.keys(rest).length
      ? await this.repo.update(id, rest as ContactUpdateData)
      : await this.repo.findById(id);
    await this.audit.log('contact.update', 'Contact', id, data as Record<string, unknown>);
    return result;
  }

  async delete(id: string) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new ContactNotFoundError(id);
    const result = await this.repo.delete(id);
    await this.audit.log('contact.delete', 'Contact', id, {
      phoneE164: existing.phoneE164,
    });
    return result;
  }

  async bulkDelete(input: {
    ids?: string[];
    all?: boolean;
    validity?: 'invalid';
    expectedCount?: number;
  }) {
    // ORDEM DELIBERADA: `validity` é checado ANTES de `all`. Um corpo com os
    // dois é ambíguo, e das duas leituras a mais restrita é a única segura —
    // `all` apagaria a base inteira de uma campanha eleitoral.
    //
    // Round 2 (revisão) — `=== 'invalid'`, não truthiness: o tipo só permite
    // este valor hoje, mas o `if` é a última linha de defesa se uma validação
    // upstream algum dia for contornada. Um `if (input.validity)` genérico
    // deixaria QUALQUER string cair aqui e chamar `contactValidityWhere` com um
    // valor nunca pretendido (ex. `'valid'`, que apagaria o oposto do que o
    // operador pediu).
    if (input.validity === 'invalid') {
      const where = contactValidityWhere(input.validity);
      // Round 1 (pré-revisão) — `expectedCount` é a confirmação que o
      // operador DIGITOU na tela. Se veio, a contagem viva tem de bater ANTES
      // de apagar qualquer linha: uma tela desatualizada (outra sincronização,
      // outro operador) nunca pode apagar mais — nem menos — do que a pessoa
      // viu e confirmou. Sem `expectedCount`, nada muda (caminho antigo).
      let deleteWhereClause: Prisma.ContactWhereInput = where;
      if (input.expectedCount !== undefined) {
        // Round 2 (revisão) — FECHA A CORRIDA entre contar e apagar.
        //
        // `snapshot` é tirado ANTES de `countWhere`. Entre o `countWhere` e o
        // `deleteWhere` (duas queries, não uma) uma linha pode virar inválida
        // de verdade — o contact-sync grava `whatsappValid=false`, ou um
        // inbound de falha grava `lastFailureReason` — e `Contact.updatedAt`
        // (`@updatedAt`) é bumped nesse exato escrever. Sem o filtro abaixo,
        // essa linha nunca foi contada (não entrou em `liveCount`, que bateu
        // com `expectedCount`) mas SERIA apagada mesmo assim, porque na hora
        // do `deleteWhere` ela já combina com `where`: o gate viraria "≈N" em
        // vez de "≤N" — exatamente o que a confirmação promete impedir.
        //
        // Um `$transaction([count, delete])` sozinho NÃO fecha isso: sob
        // READ COMMITTED (o isolamento padrão do Postgres, e o que o Prisma
        // usa aqui), cada statement dentro da transação enxerga o snapshot
        // mais recente NO MOMENTO em que roda — não o snapshot do início da
        // transação (isso só existiria em REPEATABLE READ/SERIALIZABLE, que
        // trocaria "falha silenciosa" por "erro de serialização para tratar
        // em todo caller"). Duas queries na mesma transação sob READ COMMITTED
        // continuam vendo o UPDATE que aconteceu entre elas.
        //
        // `updatedAt <= snapshot` é determinístico e não precisa de isolamento
        // mais forte: qualquer linha que mudou de estado DEPOIS do instante em
        // que contamos fica de fora do delete, mesmo que agora combine com
        // `where`. Falha para o lado seguro — o resultado é `count <= N`,
        // nunca `count > N` — e o `AuditEvent` já registra o `count` real
        // (pode ser menor que `expectedCount` numa corrida rara; nunca maior).
        const snapshot = new Date();
        const liveCount = await this.repo.countWhere(where);
        if (liveCount !== input.expectedCount) {
          throw new ContactBulkDeleteCountMismatchError(
            liveCount,
            input.expectedCount,
          );
        }
        deleteWhereClause = {
          AND: [where, { updatedAt: { lte: snapshot } }],
        };
      }
      const result = await this.repo.deleteWhere(deleteWhereClause);
      const metadata: Record<string, unknown> = {
        validity: input.validity,
        count: result.count,
      };
      if (input.expectedCount !== undefined) {
        metadata.expectedCount = input.expectedCount;
      }
      await this.audit.log(
        'contact.bulk_delete_invalid',
        'Contact',
        undefined,
        metadata,
      );
      return { deleted: result.count };
    }
    if (input.all === true) {
      const result = await this.repo.deleteAll();
      await this.audit.log('contact.bulk_delete_all', 'Contact', undefined, {
        count: result.count,
      });
      return { deleted: result.count };
    }
    const ids = input.ids ?? [];
    if (ids.length === 0) return { deleted: 0 };
    const result = await this.repo.deleteMany(ids);
    await this.audit.log('contact.bulk_delete', 'Contact', undefined, {
      count: result.count,
      ids,
    });
    return { deleted: result.count };
  }

  /**
   * Replace a contact's WhatsApp labels in full. We compute add/remove diffs
   * against the persisted `waLabels` and push each one through Evolution
   * (`/label/handleLabel`) before mirroring the final state locally. The
   * upstream calls go through one at a time — Evolution serializes label
   * mutations on the same chat anyway, and the per-contact label list is
   * tiny in practice (<10 labels), so concurrency wouldn't help much.
   *
   * On any Evolution failure we persist whatever WA actually accepted (the
   * `applied` set) before re-throwing — partial state is preferable to
   * losing the diff entirely, since WA already holds the successful adds
   * and a stale DB would re-issue them next call (likely 409s).
   */
  async setLabels(id: string, labelIds: string[]) {
    const contact = await this.repo.findById(id);
    if (!contact) throw new ContactNotFoundError(id);

    const prev = contact.waLabels ?? [];
    const additions = labelIds.filter((l) => !prev.includes(l));
    const removals = prev.filter((l) => !labelIds.includes(l));

    // Evolution wants the JID format: <digits>@s.whatsapp.net
    const jid = `${contact.phoneE164.replace(/^\+/, '')}@s.whatsapp.net`;

    // Mutable working set — starts as `prev`, mutates as each WA call succeeds.
    const applied = new Set(prev);
    let firstError: unknown = null;

    for (const labelId of additions) {
      try {
        await this.wa.handleContactLabel({ jid, labelId, action: 'add' });
        applied.add(labelId);
      } catch (err) {
        firstError = firstError ?? err;
        break; // stop after first failure to avoid amplifying inconsistency
      }
    }

    if (!firstError) {
      for (const labelId of removals) {
        try {
          await this.wa.handleContactLabel({ jid, labelId, action: 'remove' });
          applied.delete(labelId);
        } catch (err) {
          firstError = firstError ?? err;
          break;
        }
      }
    }

    // Persist the actual WA state, even if partial.
    const finalLabels = [...applied];
    const result = await this.repo.updateLabels(id, finalLabels);

    await this.audit.log('contact.set_labels', 'Contact', id, {
      added: additions,
      removed: removals,
      total: finalLabels.length,
      applied: finalLabels,
      partial: !!firstError,
    });

    if (firstError) throw firstError;
    return result;
  }

  async exportData(id: string) {
    const contact = await this.repo.findById(id);
    if (!contact) throw new ContactNotFoundError(id);

    const [messages, importItems] = await Promise.all([
      this.repo.findMessagesForContact(id),
      this.repo.findImportItemsForContact(id),
    ]);

    await this.audit.log('contact.export', 'Contact', id);

    return {
      contact,
      messages,
      importItems,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * ★ A TRAVA MUDOU DE NATUREZA (spec B.5).
   *
   * Antes: "existe um canal EVOLUTION configurado neste deploy?". Em produção
   * o canal é GOZAP, então esta rota recusava e o processor virava no-op
   * SILENCIOSO — é literalmente o "não verificados" que o cliente relata nos
   * áudios. Agora a pergunta é sobre O CANAL CERTO, e são três, todas
   * respondidas AQUI, na hora do clique:
   *
   *   1. existe um canal ATIVO e DEFAULT que sabe validar número? (capacidade
   *      do adapter, não nome de provedor — `resolveSyncChannel`, que
   *      TAMBÉM decide QUAL, entre vários defaults por-provedor, escolher —
   *      fix round 1: `findDefault()` sem provider pegava o mais VELHO entre
   *      todos, que podia ser um canal morto)
   *   2. está online? (sessão de QR cai — validar com o canal caído não valida
   *      nada e ainda queima a fila)
   *   3. está dentro da janela de envio? (o aviso da tela promete "só em
   *      horário comercial"; ou é verdade, ou o aviso ensina a desconfiar de
   *      todos os outros)
   *
   * Recusar aqui, com o motivo, é o ponto: enfileirar 300 jobs que vão morrer
   * um a um deixa o operador vendo "300 lotes enfileirados" e nada acontecendo.
   *
   * `startedAt` volta na resposta porque é o marco da BARRA DE PROGRESSO
   * (`syncProgress` conta quem foi checado a partir dele). `total` (fix round
   * 1) é o denominador da barra — quantos ids este pedido selecionou, antes
   * de fatiar em lotes de 50 (a T13 usa os dois para "enfileirados X de Y").
   */
  async syncBackfill(mode: 'unvalidated' | 'all'): Promise<{
    enqueued: number;
    total: number;
    mode: 'unvalidated' | 'all';
    startedAt: string;
  }> {
    const channel = await resolveSyncChannel(
      this.instancesRepo,
      this.wa,
      this.repo,
    );
    if (!isWithinSendWindow(new Date(), channel)) {
      throw new SyncOutsideSendWindowError(
        channel.sendWindowStartHour,
        channel.sendWindowEndHour,
      );
    }
    if (!(await this.repo.isSessionChannelOnline(channel))) {
      throw new ChannelOfflineForSyncError(channel.id);
    }

    const startedAt = new Date();
    const ids = await this.repo.findIdsForSync(mode, 50_000);
    let enqueued = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        await this.syncQueue.add('sync', {
          contactIds: chunk,
          triggeredBy: 'backfill',
        });
        enqueued += 1;
      } catch (err) {
        this.logger.warn(
          { err },
          'Failed to enqueue sync chunk during backfill',
        );
      }
    }
    await this.audit.log(
      'contact.sync_backfill_requested',
      'Contact',
      undefined,
      { mode, enqueued, channelId: channel.id, provider: channel.provider },
    );
    return {
      enqueued,
      total: ids.length,
      mode,
      startedAt: startedAt.toISOString(),
    };
  }

  /**
   * O PROGRESSO da validação ativa, para a barra do diálogo.
   *
   * `checked` conta quem tem `whatsappCheckedAt >= início` — o marco que
   * `syncBackfill` devolveu. É uma contagem de EFEITO, não de fila: se um lote
   * falhar, o número simplesmente para de subir, e o operador vê isso.
   * `unvalidated` é quanto ainda falta no total.
   */
  async syncProgress(
    since: Date,
  ): Promise<{ checked: number; unvalidated: number }> {
    const [checked, unvalidated] = await Promise.all([
      this.repo.countCheckedSince(since),
      this.repo.countByValidity('unvalidated'),
    ]);
    return { checked, unvalidated };
  }
}
