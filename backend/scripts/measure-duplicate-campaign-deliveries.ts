import { Prisma, PrismaClient } from '@prisma/client';
import type { MessageStatus, MessageDirection } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * FASE 0 §0.6 — A MEDIÇÃO, ANTES DE QUALQUER CATRACA.
 *
 * Hoje quatro caminhos (`run`, `redispatchCampaign`, `runScheduledLocked` e a
 * prévia) resolvem a audiência por `resolveAudienceWhere`, que NÃO tem cláusula
 * nenhuma sobre `Message` — eles reenviam para quem JÁ RECEBEU. Este script
 * dimensiona o estrago que isso já causou em produção.
 *
 * DUAS medições, de propósito — elas respondem perguntas diferentes e NÃO dão
 * o mesmo número:
 *
 *   (a) danoReal: pares (campanha, contato) que RECEBERAM (D2) mais de uma
 *       vez. É o estrago de fato — mensagem repetida na tela de alguém.
 *   (b) violaIndice: pares que o índice PARCIAL do §0.7 rejeitaria. Recorte
 *       MAIS LARGO — o mesmo predicado do índice, que também rejeita
 *       duplicata em QUEUED/WAITING_INSTANCE/SENDING/RECEIVED. Usar só (a)
 *       para dimensionar a migration subestimaria, e `prisma migrate deploy`
 *       abortaria em produção (mesmo container do merge de contatos: o deploy
 *       inteiro para).
 *
 * Mais o DENOMINADOR (pares de fato entregues): sem ele "300 pares
 * duplicados" não tem leitura — 300 em 400 é catástrofe, 300 em 90.000 é
 * ruído.
 *
 * É pré-requisito do índice parcial do §0.7: sem saber quantas linhas duplicadas
 * existem, a migration abortaria em cima da base.
 *
 * SOMENTE LEITURA. Não tem `--apply` porque não há nada a aplicar — se algum dia
 * alguém acrescentar escrita aqui, o nome do arquivo passou a mentir.
 *
 *   npx tsx scripts/measure-duplicate-campaign-deliveries.ts
 *   npx tsx scripts/measure-duplicate-campaign-deliveries.ts --top 50
 *   npx tsx scripts/measure-duplicate-campaign-deliveries.ts --days 30
 *
 * `--days N` recorta as três consultas para `createdAt >= agora - N dias`.
 * Sem o flag, mede a base inteira. O recorte separa "estrago histórico" de
 * "ainda acontecendo" — a §0.3 já prevê que o tick recorrente reenvia POR
 * DESENHO hoje, então parte dos pares é recorrência configurada, não bug.
 *
 * O que conta como "RECEBEU" é a decisão D2 da spec: `SENT | DELIVERED | READ`.
 * Falha e pulo pelo gate NÃO contam — quem levou `SKIPPED_NO_CONSENT` ou
 * `FAILED` não recebeu nada, e tratá-lo como já-atingido sumiria com ele das
 * campanhas seguintes (inclusive com quem deu opt-in depois).
 */

/** D2 — "recebeu" é isto, e nada além disto. */
export const DELIVERED_STATUSES: MessageStatus[] = ['SENT', 'DELIVERED', 'READ'];

/**
 * O predicado do índice parcial `Message_campaign_contact_active_key` (§0.7):
 * uma linha nesses status não ocupa vaga no UNIQUE, porque ou nunca chegou a
 * sair (FAILED/CANCELLED) ou foi recusada pelo gate antes de enviar
 * (SKIPPED_*).
 *
 * Isto é DELIBERADAMENTE diferente de `BATCH_HANDLED_STATUSES`
 * (`batch-audience.ts`, 11 status) — aquela lista resolve "quem já foi
 * tratado nesta campanha" (um FAILED transitório NÃO conta, para devolver o
 * contato ao próximo lote); esta resolve "essa linha compete pelo mesmo par
 * (campanha, contato) no índice único" (aqui FAILED conta, porque a tentativa
 * já terminou e não ocupa mais nada). Reusar a lista de 11 faria este script
 * mentir sobre o que o índice de fato vai rejeitar.
 */
export const INDEX_EXCLUDED_STATUSES: MessageStatus[] = [
  'FAILED',
  'CANCELLED',
  'SKIPPED_NO_CONSENT',
  'SKIPPED_SUPPRESSED',
  'SKIPPED_NO_OPTIN',
];

/** A tabela é compartilhada com o inbox e com o bot: OUTBOUND explícito, sempre. */
const OUTBOUND: MessageDirection = 'OUTBOUND';

/** Quantas campanhas o relatório imprime por padrão, por medição. */
export const DEFAULT_TOP = 20;

/** Uma campanha com reenvio: quantos pares duplicados e quantas mensagens sobraram. */
export type CampaignDuplicateRow = {
  campaignId: string;
  campaignName: string;
  /** Pares (campanha, contato) que receberam MAIS DE UMA vez, nesta medição. */
  pairs: number;
  /** Mensagens EXCEDENTES: soma de (entregas − 1) sobre esses pares. */
  excess: number;
};

/** Os totais + top de UMA medição (danoReal OU violaIndice). */
export type DuplicateMeasurement = {
  /** Total de pares (campanha, contato) duplicados na base inteira, nesta medição. */
  duplicatePairs: number;
  /** Total de mensagens excedentes na base inteira, nesta medição. */
  excessMessages: number;
  /** Campanhas afetadas (todas, não só as impressas). */
  campaignsAffected: number;
  /**
   * `duplicatePairs` sobre `totalDelivered` (o denominador do relatório), em
   * percentual, arredondado a 1 casa. 0 quando o denominador é 0 — sem base
   * entregue, o percentual não tem leitura, e não pode ser Infinity/NaN.
   */
  percentOfDelivered: number;
  /** As `top` piores, do maior excedente para o menor. */
  topCampaigns: CampaignDuplicateRow[];
};

export type DuplicateDeliveryReport = {
  /**
   * DENOMINADOR: pares (campanha, contato) que de fato RECEBERAM (D2),
   * distintos. É contra ele que as duas medições calculam percentual.
   */
  totalDelivered: number;
  /** (a) DANO REAL: quem recebeu a mesma campanha mais de uma vez. */
  danoReal: DuplicateMeasurement;
  /** (b) VIABILIDADE DO ÍNDICE §0.7: pares que o índice parcial rejeitaria. */
  violaIndice: DuplicateMeasurement;
};

/** O filtro de "recebeu" (D2): OUTBOUND + um dos três status terminais de entrega. */
function deliveredFilterSql(): Prisma.Sql {
  return Prisma.sql`m."direction"::text = ${OUTBOUND} AND m."status"::text IN (${Prisma.join(DELIVERED_STATUSES)})`;
}

/**
 * `AND m."createdAt" >= <corte>` quando `--days` foi passado; fragmento vazio
 * caso contrário. O corte é calculado em JS (não `now() - interval` em SQL)
 * para viajar como parâmetro bindado, no mesmo padrão de
 * `MetricsRepository.bucketSparkline7d` — nada de concatenar o número do
 * usuário dentro do texto do SQL.
 */
function cutoffSql(days?: number): Prisma.Sql {
  if (days === undefined) return Prisma.empty;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return Prisma.sql`AND m."createdAt" >= ${since}`;
}

/**
 * Agrega POR CAMPANHA já no Postgres — de propósito.
 *
 * O `GROUP BY campaignId, contactId ... HAVING count(*) > 1` da spec devolveria
 * UMA LINHA POR PAR duplicado; numa base com dezenas de milhares de envios isso
 * é o relatório inteiro viajando para o Node só para ser somado. O `WITH` faz o
 * mesmo recorte e o SELECT de fora já entrega o que a gente imprime.
 *
 * `contactId IS NOT NULL` não está no SQL da spec e é necessário: sem ele, todas
 * as mensagens da campanha sem contato (não deveria haver, mas a coluna é
 * nullable) colapsariam num único "par" gigante e inventariam um duplicado.
 */
async function queryDuplicatePairsByCampaign(
  db: Pick<PrismaClient, '$queryRaw'>,
  statusFilter: Prisma.Sql,
  cutoff: Prisma.Sql,
): Promise<CampaignDuplicateRow[]> {
  const rows = await db.$queryRaw<
    Array<{
      campaignId: string;
      campaignName: string;
      pairs: number | bigint;
      excess: number | bigint;
    }>
  >`
    WITH dup AS (
      SELECT m."campaignId" AS campaign_id,
             m."contactId"  AS contact_id,
             COUNT(*)       AS deliveries
      FROM "Message" m
      WHERE m."campaignId" IS NOT NULL
        AND m."contactId" IS NOT NULL
        AND ${statusFilter}
        ${cutoff}
      GROUP BY 1, 2
      HAVING COUNT(*) > 1
    )
    SELECT c."id"                       AS "campaignId",
           c."name"                     AS "campaignName",
           COUNT(*)::int                AS "pairs",
           SUM(dup.deliveries - 1)::int AS "excess"
    FROM dup
    JOIN "Campaign" c ON c."id" = dup.campaign_id
    GROUP BY c."id", c."name"
    ORDER BY "excess" DESC, "pairs" DESC, c."name" ASC
  `;

  return rows.map((r) => ({
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    pairs: Number(r.pairs),
    excess: Number(r.excess),
  }));
}

/** O DENOMINADOR: pares (campanha, contato) distintos que RECEBERAM (D2). */
async function queryTotalDelivered(
  db: Pick<PrismaClient, '$queryRaw'>,
  cutoff: Prisma.Sql,
): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: number | bigint }>>`
    SELECT COUNT(*)::int AS n FROM (
      SELECT DISTINCT m."campaignId", m."contactId"
      FROM "Message" m
      WHERE m."campaignId" IS NOT NULL
        AND m."contactId" IS NOT NULL
        AND ${deliveredFilterSql()}
        ${cutoff}
    ) t
  `;
  return Number(rows[0]?.n ?? 0);
}

export async function measureDuplicateCampaignDeliveries(
  db: Pick<PrismaClient, '$queryRaw'> = prisma,
  opts: { top?: number; days?: number } = {},
): Promise<DuplicateDeliveryReport> {
  const top = opts.top ?? DEFAULT_TOP;
  const cutoff = cutoffSql(opts.days);

  // As três consultas são independentes — dispará-las juntas é uma viagem ao
  // Postgres, não três sequenciais. A ORDEM das chamadas a `$queryRaw` (a),
  // (b), denominador é estável mesmo assim: `Promise.all` invoca cada uma
  // sincronamente antes de esperar qualquer resposta.
  const [danoRealRows, violaIndiceRows, totalDelivered] = await Promise.all([
    queryDuplicatePairsByCampaign(db, deliveredFilterSql(), cutoff),
    // (b) violaIndice: SEM filtro de direção — é o mesmo predicado do índice
    // parcial do §0.7, que não filtra direção, só status.
    queryDuplicatePairsByCampaign(
      db,
      Prisma.sql`m."status"::text NOT IN (${Prisma.join(INDEX_EXCLUDED_STATUSES)})`,
      cutoff,
    ),
    queryTotalDelivered(db, cutoff),
  ]);

  return {
    totalDelivered,
    danoReal: buildMeasurement(danoRealRows, top, totalDelivered),
    violaIndice: buildMeasurement(violaIndiceRows, top, totalDelivered),
  };
}

/**
 * Os totais, o percentual sobre o denominador e o recorte do top-N de UMA
 * medição. Reordena em memória em vez de confiar no ORDER BY: o relatório é a
 * parte que alguém vai ler numa reunião, e a ordem dele não pode depender de o
 * SQL ter sido editado.
 */
export function buildMeasurement(
  rows: readonly CampaignDuplicateRow[],
  top: number = DEFAULT_TOP,
  totalDelivered: number = 0,
): DuplicateMeasurement {
  const ordered = rows
    .slice()
    .sort(
      (a, b) =>
        b.excess - a.excess ||
        b.pairs - a.pairs ||
        a.campaignName.localeCompare(b.campaignName),
    );

  const duplicatePairs = rows.reduce((acc, r) => acc + r.pairs, 0);

  return {
    duplicatePairs,
    excessMessages: rows.reduce((acc, r) => acc + r.excess, 0),
    campaignsAffected: rows.length,
    percentOfDelivered:
      totalDelivered > 0 ? Math.round((duplicatePairs / totalDelivered) * 1000) / 10 : 0,
    topCampaigns: ordered.slice(0, top),
  };
}

/** `--top 50`; sem o flag (ou com lixo), o padrão. */
export function parseTop(argv: readonly string[]): number {
  const i = argv.indexOf('--top');
  if (i === -1) return DEFAULT_TOP;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TOP;
}

/** `--days 30`; sem o flag (ou com lixo), `undefined` — mede a base inteira. */
export function parseDays(argv: readonly string[]): number | undefined {
  const i = argv.indexOf('--days');
  if (i === -1) return undefined;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function formatMeasurement(title: string, m: DuplicateMeasurement): string[] {
  const lines = [
    title,
    `  pares (campanha, contato) duplicados ... ${m.duplicatePairs} (${m.percentOfDelivered}% do entregue)`,
    `  mensagens excedentes ................... ${m.excessMessages}`,
    `  campanhas afetadas ..................... ${m.campaignsAffected}`,
  ];

  if (m.campaignsAffected === 0) {
    lines.push('  Nenhum reenvio duplicado nesta medição.');
    return lines;
  }

  lines.push(`  TOP ${m.topCampaigns.length} POR CAMPANHA:`);
  for (const c of m.topCampaigns) {
    lines.push(
      `    ${c.campaignId} "${c.campaignName}" → ${c.pairs} contato(s) duplicado(s), ${c.excess} mensagem(ns) excedente(s)`,
    );
  }
  return lines;
}

export function formatReport(
  report: DuplicateDeliveryReport,
  opts: { days?: number } = {},
): string {
  const lines = [
    '=== REENVIO PARA QUEM JÁ RECEBEU (somente leitura) ===',
    opts.days ? `recorte: últimos ${opts.days} dia(s)` : 'recorte: base inteira (sem --days)',
    `"recebeu" = direction OUTBOUND e status em ${DELIVERED_STATUSES.join(', ')} (spec D2)`,
    '',
    `pares (campanha, contato) ENTREGUES (denominador) ...... ${report.totalDelivered}`,
    '',
  ];

  lines.push(
    ...formatMeasurement(
      '(a) DANO REAL — recebeu a mesma campanha mais de uma vez:',
      report.danoReal,
    ),
  );
  lines.push('');
  lines.push(
    ...formatMeasurement(
      `(b) VIABILIDADE DO ÍNDICE §0.7 — pares que o UNIQUE parcial rejeitaria (exclui ${INDEX_EXCLUDED_STATUSES.join(', ')}):`,
      report.violaIndice,
    ),
  );

  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const days = parseDays(process.argv);
    const report = await measureDuplicateCampaignDeliveries(prisma, {
      top: parseTop(process.argv),
      days,
    });
    console.log(formatReport(report, { days }));
  })()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => void prisma.$disconnect());
}
