import type { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * Há campanha disparando em algum destes canais? Se sim, o sync cede o balde.
 *
 * A DECISÃO, e por quê
 * --------------------
 * O balde do Zernio (60 req/min) é UM SÓ, compartilhado entre envio e leitura.
 * Depois do throttle, um sync não estoura mais o limite — mas ele ainda COMPETE:
 * cada leitura é um slot de 1s que uma mensagem da campanha não teve. Um
 * backfill de 100 conversas atrasaria a campanha em ~100 segundos, e o envio é
 * o que paga a conta (e o que tem janela de 24h para respeitar).
 *
 * Então a regra é assimétrica de propósito:
 * - o ENVIO nunca espera pelo sync (quando perde o slot, o job é só ADIADO —
 *   `moveToDelayed` — e volta em ~1s; ele nunca falha por causa da leitura);
 * - o SYNC cede o balde INTEIRO enquanto houver campanha ativa: para, guarda o
 *   ponto de retomada e volta depois. Ele é backfill — atrasar 10 minutos não
 *   custa nada; atrasar a campanha custa.
 *
 * Alternativa descartada: reduzir o ritmo do sync (ex.: 1 req a cada 5s) em vez
 * de parar. Continuaria roubando slots do envio, só que mais devagar — resolve
 * pela metade e esconde o problema.
 *
 * O sinal é a campanha em QUEUED/RUNNING no canal (`defaultInstanceId`), que é
 * o que de fato produz jobs de envio.
 *
 * `channelIds` é lista porque o sync de disparos (`GET /broadcasts`) é GLOBAL:
 * ele bebe do balde de todos os canais ZERNIO, então cede se QUALQUER um deles
 * estiver disparando. O sync do inbox passa um canal só.
 */
export async function zernioSendHasPriority(
  prisma: PrismaService,
  channelIds: string[],
): Promise<boolean> {
  if (channelIds.length === 0) return false;
  const active = await prisma.campaign.findFirst({
    where: {
      defaultInstanceId: { in: channelIds },
      status: { in: ['QUEUED', 'RUNNING'] },
    },
    select: { id: true },
  });
  return !!active;
}
