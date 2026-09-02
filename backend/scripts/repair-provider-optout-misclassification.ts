import { PrismaClient, ConsentAction, ConsentSource } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../src/shared/prisma/prisma.service';
import { ConsentService, GLOBAL_PURPOSE } from '../src/modules/consent/consent.service';
import type { Env } from '../src/shared/config/env.schema';

const prisma = new PrismaClient();

/**
 * fix/meta-optout-codes: webhooks.service.ts tinha um `META_OPT_OUT_CODES =
 * ['131026', '131047']` que disparava REVOKE GLOBAL de consentimento (suprime
 * a pessoa para TUDO, inclusive UTILITY) para dois códigos que a doc oficial da
 * Meta NÃO trata como opt-out:
 *   - 131026 "Message Undeliverable" — preferência de PLATAFORMA (o titular
 *     desligou marketing no app), não uma revogação dirigida à organização.
 *   - 131047 "Re-engagement message" — janela de atendimento de 24h expirada,
 *     nada a ver com opt-out.
 * Este script REVERTE os contatos que ficaram indevidamente suprimidos por
 * causa disso. Ver o commit da correção para a evidência/citação da doc.
 */
export const MISCLASSIFIED_OPT_OUT_CODES = ['131026', '131047'] as const;

export type RepairCandidate = {
  contactId: string;
  phoneHash: string;
  phoneE164: string | null;
  /** O ConsentEvent (REVOKE global, PROVIDER_OPTOUT) que suprimiu indevidamente. */
  wrongEventId: string;
  errorCode: string;
};

export type RepairReport = {
  candidates: RepairCandidate[];
  repaired: RepairCandidate[];
  /**
   * Candidatos cujo Contact não existe mais (apagado e nunca reimportado).
   * `ConsentService.reinstate` escreve `ContactConsent` por `contactId` — não
   * há como restaurar o cache de um contato morto. Ficam de fora do reparo
   * automático; precisam de revisão manual (ou reaparecem corretamente
   * suprimidos se o telefone for reimportado — a SuppressionList sobrevive por
   * phoneHash, então isto NÃO é um vazamento de dado, só um reparo adiado).
   */
  skippedMissingContact: RepairCandidate[];
};

type SuppressionDb = Pick<PrismaClient, 'suppressionList' | 'consentEvent'>;

/**
 * Identificação SEGURA dos contatos indevidamente suprimidos: só entra quem
 * está CORRENTEMENTE suprimido (SuppressionList) E cujo `lastEventId` — o
 * evento que causou a supressão ATUAL, não um evento qualquer do histórico — é
 * exatamente um REVOKE global PROVIDER_OPTOUT com um dos códigos indevidos em
 * `evidence.errorCode`.
 *
 * Por que isso é seguro: se depois do REVOKE indevido veio um opt-out de
 * verdade (PARAR, botão, 131050, 21610…), `lastEventId` aponta para ESSE
 * evento, não para o antigo — e o contato fica de fora, corretamente. Se a
 * pessoa já respondeu VOLTAR, a linha da SuppressionList foi apagada — também
 * fica de fora. Não há adivinhação: cada candidato é rastreável até o exato
 * ConsentEvent que causou o dano.
 */
export async function findMisclassifiedSuppressions(
  db: SuppressionDb = prisma,
): Promise<RepairCandidate[]> {
  const suppressed = await db.suppressionList.findMany({
    where: { lastEventId: { not: null } },
    select: { phoneHash: true, phoneE164: true, lastEventId: true },
  });
  if (suppressed.length === 0) return [];

  const eventIds = [
    ...new Set(
      suppressed
        .map((s) => s.lastEventId)
        .filter((id): id is string => id != null),
    ),
  ];
  if (eventIds.length === 0) return [];

  const events = await db.consentEvent.findMany({
    where: {
      id: { in: eventIds },
      purposeKey: GLOBAL_PURPOSE,
      action: ConsentAction.REVOKE,
      source: ConsentSource.PROVIDER_OPTOUT,
    },
    select: { id: true, contactId: true, evidence: true },
  });
  const eventById = new Map(events.map((e) => [e.id, e]));

  const candidates: RepairCandidate[] = [];
  for (const s of suppressed) {
    const event = s.lastEventId ? eventById.get(s.lastEventId) : undefined;
    if (!event || !event.contactId) continue;
    const evidence = event.evidence as { errorCode?: string } | null;
    const errorCode = evidence?.errorCode;
    if (
      !errorCode ||
      !(MISCLASSIFIED_OPT_OUT_CODES as readonly string[]).includes(errorCode)
    ) {
      continue;
    }
    candidates.push({
      contactId: event.contactId,
      phoneHash: s.phoneHash,
      phoneE164: s.phoneE164,
      wrongEventId: event.id,
      errorCode,
    });
  }
  return candidates;
}

/**
 * Reverte cada candidato com um GRANT de reversão via `ConsentService.reinstate`
 * — o MESMO mecanismo do VOLTAR: levanta a supressão E restaura os GRANTs que
 * estavam ativos imediatamente antes do REVOKE indevido (não um `optInAt =
 * now()` genérico). Fonte `SYSTEM_REPAIR`: não é o titular pedindo, é o orgamind
 * corrigindo o próprio erro — rotular como PROVIDER_OPTOUT ou MANUAL_ADMIN
 * mentiria na trilha (a trilha é a prova, art. 8º §2º).
 *
 * A trilha é append-only: isto NÃO apaga nem edita o REVOKE indevido original —
 * ele continua lá, e o GRANT de reversão, com a evidência do porquê, é que
 * corrige o estado DERIVADO daqui pra frente.
 */
export async function repairMisclassifiedSuppressions(
  db: Pick<PrismaClient, 'contact'>,
  consent: Pick<ConsentService, 'reinstate'>,
  candidates: RepairCandidate[],
): Promise<RepairReport> {
  const repaired: RepairCandidate[] = [];
  const skippedMissingContact: RepairCandidate[] = [];

  for (const c of candidates) {
    const contact = await db.contact.findUnique({
      where: { id: c.contactId },
      select: { id: true, phoneE164: true },
    });
    if (!contact) {
      skippedMissingContact.push(c);
      continue;
    }
    await consent.reinstate({
      contactId: c.contactId,
      phoneE164: contact.phoneE164,
      source: ConsentSource.SYSTEM_REPAIR,
      evidenceText:
        `Revogação revertida automaticamente: o código Meta ${c.errorCode} foi ` +
        'classificado indevidamente como opt-out (bug corrigido em fix/meta-optout-codes; ' +
        `evento original: ${c.wrongEventId}).`,
      evidence: { repairOf: c.wrongEventId, errorCode: c.errorCode },
    });
    repaired.push(c);
  }

  return { candidates, repaired, skippedMissingContact };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const candidates = await findMisclassifiedSuppressions(prisma);
    console.log(`Candidatos (suprimidos indevidamente por 131026/131047): ${candidates.length}`);
    if (candidates.length === 0) return;

    const apply = process.argv.includes('--apply');
    if (!apply) {
      console.log('Dry-run — rode com --apply para reverter de fato. Candidatos:');
      for (const c of candidates) {
        console.log(`  contactId=${c.contactId} errorCode=${c.errorCode} wrongEventId=${c.wrongEventId}`);
      }
      return;
    }

    const config = {
      get: () => process.env.PICOA_CONSENT_SALT,
    } as unknown as ConfigService<Env>;
    const consent = new ConsentService(prisma as unknown as PrismaService, config);

    const report = await repairMisclassifiedSuppressions(prisma, consent, candidates);
    console.log(`Reparados: ${report.repaired.length}`);
    if (report.skippedMissingContact.length > 0) {
      console.warn(
        `PENDENTES (Contact não existe mais — revisão manual): ${report.skippedMissingContact.length}`,
      );
      for (const c of report.skippedMissingContact) {
        console.warn(`  contactId=${c.contactId} phoneHash=${c.phoneHash} wrongEventId=${c.wrongEventId}`);
      }
    }
  })()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
