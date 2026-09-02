import { Injectable, Logger } from '@nestjs/common';
import { ConsentAction, ConsentSource, Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { ConsentService } from './consent.service';
import { toPrismaWhere } from '../campaigns/filter.converter';
// F1 T4 — mesmo choke point das campanhas: um nó history com templateIds
// precisa ser expandido em campaignIds ANTES do toPrismaWhere.
import { resolveHistoryTargets } from '../campaigns/history-filter.resolver';
import type { BulkGrant } from '../../schemas/contracts/consent-admin.schema';
import {
  PurposeInactiveError,
  PurposeNotFoundError,
} from './errors/consent.errors';

export type BulkGrantResult = {
  /** Contatos resolvidos pelo filtro. */
  total: number;
  granted: number;
  /** Estavam na SuppressionList — pulados, sempre. */
  skippedSuppressed: number;
  /** Já tinham GRANT ativo para esta finalidade (a idempotência). */
  alreadyGranted: number;
  /** Falharam individualmente (o lote não é abortado — reexecutar é seguro). */
  failed: number;
};

export type BulkGrantActor = { id: string; email: string };

/** Lotes do `IN (...)` da consulta de estado (limite de parâmetros do Postgres). */
const LOOKUP_CHUNK = 2_000;

/**
 * Quantos `record()` correm em paralelo. Cada um é uma transação curta que toca
 * linhas de contatos DIFERENTES (evento + estado + cache), então não há
 * contenção entre elas — mas o pool de conexões do Prisma tem fundo, e 13k
 * transações em série levariam minutos numa requisição HTTP.
 */
const CONCURRENCY = 8;

/**
 * §6.2 coorte C2 — registro de consentimento da BASE EXISTENTE.
 *
 * O problema que isto resolve: a base legada do cliente tem base legal (os
 * titulares concordaram em receber, FORA do WhatsApp — num contrato, numa ficha,
 * num cadastro), mas nenhum `ConsentEvent`. O gate por finalidade, corretamente,
 * pula 100% dela — e nenhuma campanha sai. Sem este caminho, a única saída seria
 * um `UPDATE` na mão no banco, que é exatamente o que a feature inteira existe
 * para impedir.
 *
 * O que NÃO é: um jeito de fabricar consentimento. Três guardas fazem a
 * diferença, e são o produto aqui:
 *
 *  1. **Evidência obrigatória.** `evidenceRef` (onde) e `collectedAt` (quando)
 *     são exigidos pelo contrato de entrada. Um GRANT em massa sem eles seria a
 *     autorização genérica que o art. 8º §4º anula — e, pior, uma prova
 *     documental produzida pelo próprio controlador de que ele registrou
 *     consentimento sem saber de onde veio.
 *  2. **`occurredAt` = a data da coleta, não "agora".** Um consentimento de
 *     março de 2025 é um consentimento de março de 2025: o painel mostra a idade
 *     real, a regra de frescor do §3.3 pode agir sobre ele, e um GRANT retroativo
 *     nunca sobrescreve um REVOKE mais recente (o `record()` recomputa a
 *     precedência pela trilha, não pelo que o chamador esperava).
 *  3. **Supressão é absoluta.** Quem deu PARAR não recebe GRANT nem com contrato,
 *     nem com ADMIN, nem com declaração de base legal (art. 8º §5º).
 *
 * A escrita continua sendo SÓ pelo `ConsentService.record()` — este serviço
 * resolve a audiência, filtra e compõe a evidência; ele não escreve consentimento
 * com as próprias mãos.
 */
@Injectable()
export class ConsentBulkGrantService {
  private readonly logger = new Logger(ConsentBulkGrantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Quantos contatos serão afetados — o número que o operador vê ANTES de
   * confirmar. Não grava nada e não audita: é a mesma resolução do `apply`.
   */
  async preview(input: BulkGrant): Promise<BulkGrantResult> {
    const plan = await this.resolve(input);
    return {
      total: plan.total,
      granted: plan.toGrant.length,
      skippedSuppressed: plan.skippedSuppressed,
      alreadyGranted: plan.alreadyGranted,
      failed: 0,
    };
  }

  async apply(
    input: BulkGrant,
    actor: BulkGrantActor,
  ): Promise<BulkGrantResult> {
    const plan = await this.resolve(input);
    const evidenceText = this.composeEvidenceText(input, actor, plan.label);
    const evidence: Prisma.InputJsonValue = {
      kind: 'bulk_admin_legacy',
      evidenceRef: input.evidenceRef,
      evidenceNote: input.evidenceNote ?? null,
      collectedAt: input.collectedAt.toISOString(),
      actorUserId: actor.id,
      actorEmail: actor.email,
      recordedVia: 'POST /consent/bulk-grant',
      /** O filtro que definiu a audiência — reexecutável, e parte da auditoria. */
      filters: input.filters as unknown as Prisma.InputJsonValue,
    };

    let granted = 0;
    let failed = 0;

    for (let i = 0; i < plan.toGrant.length; i += CONCURRENCY) {
      const slice = plan.toGrant.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        slice.map((c) =>
          this.consent.record({
            contactId: c.id,
            phoneE164: c.phoneE164,
            purposeKey: input.purposeKey,
            action: ConsentAction.GRANT,
            // O enum já tem a fonte certa: este É o backfill auditado da base
            // histórica (§2.3/§6.2 C2). Uma fonte nova (BULK_ADMIN) seria um
            // sinônimo — e o painel de opt-in, que agrupa GRANTs por fonte,
            // passaria a ter duas barras dizendo a mesma coisa.
            source: ConsentSource.IMPORT_LEGACY,
            evidenceText,
            consentTextVersion: plan.textVersion,
            evidence,
            occurredAt: input.collectedAt,
            actorUserId: actor.id,
          }),
        ),
      );

      for (const [idx, r] of results.entries()) {
        if (r.status === 'fulfilled') {
          granted += 1;
        } else {
          failed += 1;
          this.logger.error(
            { contactId: slice[idx]?.id, err: r.reason },
            'falha ao registrar consentimento em massa para um contato — o lote continua (reexecutar é idempotente)',
          );
        }
      }
    }

    const result: BulkGrantResult = {
      total: plan.total,
      granted,
      skippedSuppressed: plan.skippedSuppressed,
      alreadyGranted: plan.alreadyGranted,
      failed,
    };

    // A auditoria é parte da prova: quem declarou, para qual finalidade, com que
    // evidência, sobre quantos titulares.
    await this.audit.log('consent.bulk_grant', 'ConsentPurpose', input.purposeKey, {
      actorUserId: actor.id,
      actorEmail: actor.email,
      purposeKey: input.purposeKey,
      evidenceRef: input.evidenceRef,
      evidenceNote: input.evidenceNote ?? null,
      collectedAt: input.collectedAt.toISOString(),
      filters: input.filters,
      ...result,
    });

    this.logger.log(
      { purposeKey: input.purposeKey, ...result },
      'consentimento da base existente registrado em massa',
    );
    return result;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async resolve(input: BulkGrant): Promise<{
    total: number;
    label: string;
    textVersion: string | null;
    toGrant: { id: string; phoneE164: string }[];
    skippedSuppressed: number;
    alreadyGranted: number;
  }> {
    const purpose = await this.prisma.consentPurpose.findUnique({
      where: { key: input.purposeKey },
      select: { key: true, label: true, active: true },
    });
    if (!purpose) throw new PurposeNotFoundError(input.purposeKey);
    if (!purpose.active) throw new PurposeInactiveError(input.purposeKey);

    // A versão vigente do texto: amarra o GRANT ao corpo que a finalidade
    // declara hoje. É o mais honesto que se consegue num backfill — a pessoa
    // consentiu fora do orgamind, então não há texto renderizado que ela tenha
    // lido AQUI; o `evidenceText` diz isso com todas as letras.
    const text = await this.prisma.consentText.findFirst({
      where: { purposeKey: purpose.key, activeFrom: { lte: new Date() } },
      orderBy: { activeFrom: 'desc' },
      select: { version: true },
    });

    // Mesma resolução de audiência das campanhas — incluindo a expansão de
    // templateIds→campaignIds de um eventual nó history (F1 T4). O que NÃO é
    // mais igual: `toPrismaWhere` deixou de embutir `{ optedOut: false }`
    // (decisão do cliente, 2026-08-25, só para o PÚBLICO de campanha — ver
    // filter.converter.ts). Bulk-grant é o sentido CONTRÁRIO do disparo: ele
    // CONCEDE consentimento, então alcançar quem pediu para sair seria pior
    // que só enviar para ele (art. 8º §5º da LGPD). A exclusão é restaurada
    // logo abaixo, LOCALMENTE a este serviço, não no conversor compartilhado.
    const resolvedFilters = await resolveHistoryTargets(
      input.filters,
      this.prisma,
    );
    const audienceWhere = toPrismaWhere(
      resolvedFilters,
    ) as Prisma.ContactWhereInput;
    const where: Prisma.ContactWhereInput = {
      AND: [
        audienceWhere,
        // `optedOut` é `Boolean NOT NULL DEFAULT false` no schema.prisma —
        // nunca NULL — então a igualdade simples já é null-safe. Não é o
        // mesmo caso de `lastFailureReason` (nulável), que precisa do padrão
        // `OR: [{ campo: null }, ...]` em filter.converter.ts.
        { optedOut: false },
      ],
    };
    const contacts = await this.prisma.contact.findMany({
      where,
      select: { id: true, phoneE164: true },
    });

    if (contacts.length === 0) {
      return {
        total: 0,
        label: purpose.label,
        textVersion: text?.version ?? null,
        toGrant: [],
        skippedSuppressed: 0,
        alreadyGranted: 0,
      };
    }

    // Supressão pela CHAVE DURÁVEL (phoneHash), não pelo cache `optedOut` da
    // linha de Contact: o cache pode divergir (contato apagado e reimportado por
    // planilha renasce com optedOut=false), e é justamente para sobreviver a isso
    // que a SuppressionList existe. Defesa em profundidade, de propósito.
    const suppressed = await this.consent.suppressedPhones(
      contacts.map((c) => c.phoneE164),
    );

    const already = new Set<string>();
    for (let i = 0; i < contacts.length; i += LOOKUP_CHUNK) {
      const ids = contacts.slice(i, i + LOOKUP_CHUNK).map((c) => c.id);
      const granted = await this.consent.grantedContactIds(ids, purpose.key);
      for (const id of granted) already.add(id);
    }

    let skippedSuppressed = 0;
    let alreadyGranted = 0;
    const toGrant: { id: string; phoneE164: string }[] = [];

    for (const c of contacts) {
      if (suppressed.has(c.phoneE164)) {
        skippedSuppressed += 1;
        continue;
      }
      if (already.has(c.id)) {
        alreadyGranted += 1;
        continue;
      }
      toGrant.push(c);
    }

    return {
      total: contacts.length,
      label: purpose.label,
      textVersion: text?.version ?? null,
      toGrant,
      skippedSuppressed,
      alreadyGranted,
    };
  }

  /**
   * O `evidenceText` é NOT NULL e é a prova. Num backfill ele não pode fingir ser
   * o texto que a pessoa leu (ela não leu nada no orgamind) — então ele diz
   * exatamente o que é: uma DECLARAÇÃO do operador, assinada com o e-mail dele,
   * apontando para a evidência externa e para a data em que o titular concordou.
   * Auto-declarado vale menos numa fiscalização (spec §3.3) — e é por isso que a
   * referência externa é obrigatória.
   */
  private composeEvidenceText(
    input: BulkGrant,
    actor: BulkGrantActor,
    purposeLabel: string,
  ): string {
    const linhas = [
      'Consentimento registrado em massa a partir de base legal pré-existente (coletada fora do WhatsApp).',
      `Finalidade: ${purposeLabel} (${input.purposeKey}).`,
      `Onde o titular concordou: ${input.evidenceRef}.`,
      `Quando concordou: ${fmtDate(input.collectedAt)}.`,
    ];
    if (input.evidenceNote?.trim()) {
      linhas.push(`Observação: ${input.evidenceNote.trim()}`);
    }
    linhas.push(
      `Declarado por ${actor.email} (usuário ${actor.id}) em ${fmtDateTime(new Date())}, ` +
        'que afirma haver registro comprovável do consentimento destes titulares.',
    );
    return linhas.join('\n');
  }
}

/**
 * A DATA DA COLETA é uma data de calendário (o operador escolhe "12/03/2025" num
 * `<input type=date>`, que vira meia-noite UTC) — não um instante. Formatá-la em
 * America/Manaus (UTC-4) a jogaria para o dia ANTERIOR: o operador digita 12/03 e
 * a evidência, que é a prova, diria 11/03. Por isso UTC aqui, e Manaus só no
 * carimbo de quem declarou (esse sim é um instante real).
 */
function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

function fmtDateTime(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Manaus',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d);
}
