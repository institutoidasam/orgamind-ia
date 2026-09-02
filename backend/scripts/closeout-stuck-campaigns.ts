import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * fix/gate-silencioso — REPARO DAS CAMPANHAS JÁ PRESAS EM PROD.
 *
 * Quem fecha uma campanha é o WORKER, ao processar a última mensagem. Se o gate
 * de consentimento pulou a audiência INTEIRA, nenhum job entrou no BullMQ, o
 * worker nunca rodou e `maybeCompleteCampaign` nunca foi chamada: a campanha
 * ficou "Em execução" PARA SEMPRE (foi exatamente o que o dono do sistema viu, e
 * por isso passou horas achando que era o agendamento).
 *
 * A correção no código só vale para disparos NOVOS (run/redispatch/sendBatch e o
 * worker agora reavaliam). As campanhas que já estão presas não são reavaliadas
 * por nada — este script é o close-out delas.
 *
 * Dry-run por padrão:
 *   npx tsx scripts/closeout-stuck-campaigns.ts
 *   npx tsx scripts/closeout-stuck-campaigns.ts --apply
 */

/** Status de Message que significam "ainda em voo" — a campanha NÃO acabou. */
export const IN_FLIGHT: readonly string[] = [
  'QUEUED',
  'SENDING',
  'WAITING_INSTANCE',
];
const SUCCEEDED: readonly string[] = ['SENT', 'DELIVERED', 'READ'];

export type CampaignCounts = { status: string; count: number }[];

export type CloseoutDecision =
  | { action: 'skip'; reason: string }
  | { action: 'close'; status: 'COMPLETED' | 'FAILED' };

/**
 * A MESMA regra de `CampaignsService.maybeCompleteCampaign`, aplicada offline:
 *  - nenhuma mensagem materializada  → não fecha (a campanha nem começou);
 *  - qualquer coisa em voo           → não fecha;
 *  - houve envio                     → COMPLETED;
 *  - zero envio e houve FALHA real   → FAILED;
 *  - zero envio e ninguém falhou (100% pulado pelo gate) → COMPLETED.
 *
 * O último caso é o do incidente e é deliberado: uma campanha impedida de enviar
 * pelo gate NÃO falhou — ela foi corretamente bloqueada. Marcá-la FAILED mandaria
 * o operador caçar um erro de envio que não existe. A verdade ("0 enviadas, 2
 * bloqueadas por falta de consentimento") vem dos CONTADORES, não do status.
 */
export function decideCloseout(counts: CampaignCounts): CloseoutDecision {
  const total = counts.reduce((acc, c) => acc + c.count, 0);
  if (total === 0) {
    return { action: 'skip', reason: 'sem mensagens (dispatch nunca rodou)' };
  }
  const inFlight = counts
    .filter((c) => IN_FLIGHT.includes(c.status))
    .reduce((acc, c) => acc + c.count, 0);
  if (inFlight > 0) {
    return { action: 'skip', reason: `${inFlight} mensagem(ns) em voo` };
  }
  const succeeded = counts
    .filter((c) => SUCCEEDED.includes(c.status))
    .reduce((acc, c) => acc + c.count, 0);
  const failed = counts
    .filter((c) => c.status === 'FAILED')
    .reduce((acc, c) => acc + c.count, 0);
  if (succeeded > 0) return { action: 'close', status: 'COMPLETED' };
  return { action: 'close', status: failed > 0 ? 'FAILED' : 'COMPLETED' };
}

export type StuckCampaign = {
  id: string;
  name: string;
  counts: CampaignCounts;
  batches: number;
  decision: CloseoutDecision;
};

/**
 * Campanhas presas: RUNNING/QUEUED sem nada em voo.
 *
 * Campanhas EM LOTES (`CampaignBatch` > 0) ficam de fora do fechamento
 * automático: nelas "nada em voo" é o estado NORMAL entre um lote e o próximo, e
 * fechá-las apagaria a audiência pendente da tela. Elas são apenas REPORTADAS,
 * para revisão manual.
 */
export async function findStuckCampaigns(
  db: Pick<PrismaClient, 'campaign' | 'message' | 'campaignBatch'> = prisma,
): Promise<StuckCampaign[]> {
  const campaigns = await db.campaign.findMany({
    where: { status: { in: ['RUNNING', 'QUEUED'] } },
    select: { id: true, name: true },
  });

  const out: StuckCampaign[] = [];
  for (const c of campaigns) {
    const grouped = await db.message.groupBy({
      by: ['status'],
      where: { campaignId: c.id },
      _count: true,
    });
    const counts: CampaignCounts = grouped.map((g) => ({
      status: String(g.status),
      count: typeof g._count === 'number' ? g._count : 0,
    }));
    const batches = await db.campaignBatch.count({
      where: { campaignId: c.id },
    });
    const decision = decideCloseout(counts);
    out.push({ id: c.id, name: c.name, counts, batches, decision });
  }
  return out.filter((c) => c.decision.action === 'close' || c.batches > 0);
}

export async function applyCloseout(
  db: Pick<PrismaClient, 'campaign'>,
  stuck: StuckCampaign[],
): Promise<StuckCampaign[]> {
  const closed: StuckCampaign[] = [];
  for (const c of stuck) {
    // Lotes NUNCA são fechados automaticamente (ver findStuckCampaigns).
    if (c.batches > 0) continue;
    if (c.decision.action !== 'close') continue;
    await db.campaign.update({
      where: { id: c.id },
      data: { status: c.decision.status, finishedAt: new Date() },
    });
    closed.push(c);
  }
  return closed;
}

const fmt = (counts: CampaignCounts) =>
  counts.map((c) => `${c.status}=${c.count}`).join(' ') || '(nenhuma mensagem)';

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const stuck = await findStuckCampaigns(prisma);
    const closable = stuck.filter(
      (c) => c.batches === 0 && c.decision.action === 'close',
    );
    const manual = stuck.filter((c) => c.batches > 0);

    console.log(`Campanhas presas (fecháveis): ${closable.length}`);
    for (const c of closable) {
      const status = c.decision.action === 'close' ? c.decision.status : 'skip';
      console.log(`  ${c.id} "${c.name}" → ${status}  [${fmt(c.counts)}]`);
    }
    if (manual.length > 0) {
      console.warn(
        `EM LOTES (revisão manual — "nada em voo" pode ser só o intervalo entre lotes): ${manual.length}`,
      );
      for (const c of manual) {
        console.warn(`  ${c.id} "${c.name}"  [${fmt(c.counts)}]`);
      }
    }
    if (closable.length === 0) return;

    if (!process.argv.includes('--apply')) {
      console.log('Dry-run — rode com --apply para fechar de fato.');
      return;
    }
    const closed = await applyCloseout(prisma, closable);
    console.log(`Fechadas: ${closed.length}`);
  })()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => void prisma.$disconnect());
}
