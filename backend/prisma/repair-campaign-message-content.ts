import { PrismaClient } from '@prisma/client';
import { renderTemplateBody } from '../src/shared/template/render-template-body';
import { enrichVariablesWithContact } from '../src/shared/template/enrich-variables';
import { refreshConversationSummary } from './backfill-conversations';

const prisma = new PrismaClient();

/**
 * REPARO DE DADOS (one-shot, idempotente) — as mensagens de campanha JÁ ENVIADAS
 * antes do fix foram gravadas com `content` NULL: o worker tinha o corpo do
 * template e as variáveis resolvidas na mão e jogava os dois fora. No Inbox isso
 * é a bolha VAZIA (só hora + ticks) e a linha da conversa sem preview.
 *
 * O fix no worker só cobre os envios FUTUROS. Este script reconstrói o texto que
 * a pessoa REALMENTE leu — corpo aprovado do template + as variáveis que ficaram
 * gravadas na própria Message, pelas MESMAS funções que o worker usa no envio
 * (renderTemplateBody + enrichVariablesWithContact) — e depois avança o resumo
 * das conversas afetadas, que é o que a lista lateral lê.
 *
 * Nunca sobrescreve conteúdo existente (`content: null` no where): uma mensagem
 * de chat, um eco do provedor ou um texto já reparado ficam intactos.
 *
 * ORDEM em produção (o backfill recalcula o resumo a partir do CONTEÚDO, então o
 * reparo vem primeiro; mensagens órfãs — sem conversationId — ganham a conversa
 * no backfill e o preview certo porque o texto já foi reconstruído):
 *
 *   npx tsx prisma/repair-campaign-message-content.ts
 *   npx tsx prisma/backfill-conversations.ts
 */
export async function repairCampaignMessageContent(
  db: PrismaClient = prisma,
): Promise<{ repaired: number; conversations: number }> {
  const rows = await db.message.findMany({
    where: {
      direction: 'OUTBOUND',
      content: null,
      campaignId: { not: null },
      contactId: { not: null },
    },
    select: {
      id: true,
      variables: true,
      conversationId: true,
      contact: { select: { name: true, city: true, group: true, phoneE164: true } },
      campaign: {
        select: {
          template: { select: { body: true, metaName: true, variables: true } },
        },
      },
    },
  });

  const touched = new Set<string>();
  let repaired = 0;

  for (const m of rows) {
    const tpl = m.campaign?.template;
    if (!tpl || !m.contact) continue;
    const vars = enrichVariablesWithContact(
      (m.variables ?? {}) as Record<string, string>,
      tpl.variables,
      m.contact,
    );
    // Placeholder só como ÚLTIMO recurso (template de mídia pura/interativo, sem
    // corpo renderizável) — é o mesmo fallback do worker e do sync do Zernio.
    const content =
      renderTemplateBody(tpl.body, vars) || `[Template: ${tpl.metaName}]`;
    await db.message.update({ where: { id: m.id }, data: { content } });
    repaired += 1;
    if (m.conversationId) touched.add(m.conversationId);
  }

  for (const conversationId of touched) {
    await refreshConversationSummary(db, conversationId);
  }

  return { repaired, conversations: touched.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  repairCampaignMessageContent()
    .then((r) =>
      console.log(
        `Reparo ok: ${r.repaired} mensagem(ns) com o texto reconstruído, ${r.conversations} conversa(s) com o resumo atualizado`,
      ),
    )
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
