import { Injectable, Logger } from '@nestjs/common';
import { ContactSourceOrigin, MessageDirection, Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  classifyContact,
  type ContactSignals,
  type ImportRowSignal,
} from './source-origin.classifier';

/** Contatos por página. 13k não cabem numa consulta só (nem em memória, com rawRow). */
const DEFAULT_BATCH_SIZE = 500;

export type ClassifyReport = {
  scanned: number;
  /** Linhas cuja coorte (ou lastInteractionAt) mudou — as únicas que sofreram UPDATE. */
  updated: number;
  /** Linhas já corretas: a prova de que a rotina é re-executável de graça. */
  unchanged: number;
  byOrigin: Record<ContactSourceOrigin, number>;
  startedAt: Date;
  finishedAt: Date;
};

/**
 * C5 — a AUDITORIA DA BASE (spec §6).
 *
 * Percorre os ~13.000 contatos e grava, para cada um, a coorte de procedência
 * (`Contact.sourceOrigin`) e a última interação real (`Contact.lastInteractionAt`),
 * a partir dos sinais que o banco JÁ TEM (§6.1): lote de importação
 * (`ImportItem.rawRow` + `ImportBatch.filename`), histórico de conversa/mensagem
 * e a checagem de WhatsApp.
 *
 * Três invariantes, e cada uma tem um motivo concreto:
 *
 *  1. **NÃO ENVIA NADA.** É uma rotina de leitura + projeção. O §6 inteiro existe
 *     para ser executado ANTES de qualquer botão de envio ser tocado.
 *  2. **IDEMPOTENTE.** Rodar duas vezes seguidas produz o mesmo resultado e, na
 *     segunda, ZERO UPDATEs — a linha só é reescrita quando a coorte ou a
 *     interação mudam de fato. Numa base de 13k, a alternativa reescreveria
 *     `updatedAt` de todo mundo a cada auditoria.
 *  3. **NÃO ESCREVE CONSENTIMENTO.** Coorte é procedência, não permissão. O
 *     backfill de GRANT da coorte C2 (`IMPORT_LEGACY`) é um passo SEPARADO e
 *     auditado — se esta rotina o fizesse sozinha, ela estaria fabricando
 *     consentimento em lote, que é exatamente o bug que a feature fecha.
 */
@Injectable()
export class SourceOriginService {
  private readonly logger = new Logger(SourceOriginService.name);

  constructor(private readonly prisma: PrismaService) {}

  async classifyAll(opts?: { batchSize?: number }): Promise<ClassifyReport> {
    const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
    const startedAt = new Date();
    const byOrigin = {
      INTERAGIU: 0,
      DOCUMENTADA_COM_DECLARACAO: 0,
      DOCUMENTADA_SEM_DECLARACAO: 0,
      DESCONHECIDA: 0,
      INVALIDO_NAO_WHATSAPP: 0,
    } as Record<ContactSourceOrigin, number>;

    let scanned = 0;
    let updated = 0;
    let unchanged = 0;
    let cursor: string | undefined;

    for (;;) {
      const page = await this.prisma.contact.findMany({
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          whatsappValid: true,
          sourceOrigin: true,
          sourceOriginNote: true,
          lastInteractionAt: true,
        },
      });
      if (page.length === 0) break;

      const ids = page.map((c) => c.id);
      const [interactions, imports] = await Promise.all([
        this.lastInteractionByContact(ids),
        this.importRowsByContact(ids),
      ]);

      for (const contact of page) {
        const signals: ContactSignals = {
          contactId: contact.id,
          whatsappValid: contact.whatsappValid,
          lastInteractionAt: interactions.get(contact.id) ?? null,
          importRows: imports.get(contact.id) ?? [],
        };
        const { origin, note } = classifyContact(signals);
        byOrigin[origin] += 1;
        scanned += 1;

        // A escrita só acontece quando o VEREDITO muda. `sourceOriginAt` (quando
        // a auditoria rodou) é deliberadamente ignorado nesta comparação: se ele
        // entrasse, toda passada reescreveria 13k linhas só para carimbar a hora,
        // e a idempotência viraria uma promessa vazia.
        const same =
          contact.sourceOrigin === origin &&
          contact.sourceOriginNote === note &&
          sameInstant(contact.lastInteractionAt, signals.lastInteractionAt);
        if (same) {
          unchanged += 1;
          continue;
        }

        await this.prisma.contact.update({
          where: { id: contact.id },
          data: {
            sourceOrigin: origin,
            sourceOriginNote: note,
            sourceOriginAt: startedAt,
            lastInteractionAt: signals.lastInteractionAt,
          },
        });
        updated += 1;
      }

      if (page.length < batchSize) break;
      cursor = page[page.length - 1].id;
    }

    const report: ClassifyReport = {
      scanned,
      updated,
      unchanged,
      byOrigin,
      startedAt,
      finishedAt: new Date(),
    };
    this.logger.log(
      report,
      'auditoria de procedência da base concluída (nenhuma mensagem enviada)',
    );
    return report;
  }

  /**
   * A última INTERAÇÃO do titular: o maior entre `Conversation.lastInboundAt` e a
   * última `Message` INBOUND. Duas fontes porque nenhuma delas é completa —
   * `lastInboundAt` só passou a ser preenchido em 2026-07 e conversas apagadas/não
   * ligadas ao contato deixam órfãs as mensagens que sobraram.
   *
   * OUTBOUND está fora de propósito: uma campanha que a pessoa ignorou não é
   * relação prévia dela conosco. É nossa com ela.
   */
  private async lastInteractionByContact(
    ids: string[],
  ): Promise<Map<string, Date>> {
    const [conversations, messages] = await Promise.all([
      this.prisma.conversation.groupBy({
        by: ['contactId'],
        where: { contactId: { in: ids }, lastInboundAt: { not: null } },
        _max: { lastInboundAt: true },
      }),
      this.prisma.message.groupBy({
        by: ['contactId'],
        where: { contactId: { in: ids }, direction: MessageDirection.INBOUND },
        _max: { receivedAt: true, createdAt: true },
      }),
    ]);

    const out = new Map<string, Date>();
    const bump = (contactId: string | null, when: Date | null | undefined) => {
      if (!contactId || !when) return;
      const prev = out.get(contactId);
      if (!prev || when > prev) out.set(contactId, when);
    };

    for (const row of conversations)
      bump(row.contactId, row._max.lastInboundAt);
    for (const row of messages) {
      // `receivedAt` é o carimbo do provedor e é o mais fiel; nem toda linha
      // antiga o tem, e aí `createdAt` (quando o orgamind gravou) é a melhor
      // aproximação disponível.
      bump(row.contactId, row._max.receivedAt ?? row._max.createdAt);
    }
    return out;
  }

  /** A linha ORIGINAL da planilha + o arquivo de onde veio — a melhor prova de proveniência que existe. */
  private async importRowsByContact(
    ids: string[],
  ): Promise<Map<string, ImportRowSignal[]>> {
    const items = await this.prisma.importItem.findMany({
      where: { contactId: { in: ids } },
      select: {
        contactId: true,
        rawRow: true,
        importBatch: { select: { filename: true } },
      },
    });

    const out = new Map<string, ImportRowSignal[]>();
    for (const item of items) {
      if (!item.contactId) continue;
      const list = out.get(item.contactId) ?? [];
      list.push({
        filename: item.importBatch?.filename ?? '',
        raw: asRow(item.rawRow),
      });
      out.set(item.contactId, list);
    }
    return out;
  }
}

/** `rawRow` é Json: pode ser array, string ou null numa linha antiga. Só objeto interessa. */
function asRow(raw: Prisma.JsonValue): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}
