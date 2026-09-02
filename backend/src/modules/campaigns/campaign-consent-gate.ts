/**
 * ★ O GATE DE CONSENTIMENTO NO ATO DO ENVIO — UMA fonte, NENHUMA cópia.
 *
 * Esta função É o `mayStillSend` que vivia (privado) dentro do
 * `SendMessageProcessor`. Ela saiu de lá SEM MUDAR UMA VÍRGULA DE REGRA, por um
 * motivo específico: agora existem DOIS caminhos de envio.
 *
 *   1. o 1-a-1 (`POST /inbox/conversations`) — o padrão, um job por mensagem;
 *   2. o BROADCAST nativo do Zernio — um job por LOTE de mensagens.
 *
 * Os dois precisam aplicar EXATAMENTE o mesmo gate, e a maneira mais garantida de
 * dois códigos divergirem é escrevê-los duas vezes. Uma divergência aqui não dá
 * erro, não aparece em log e não quebra teste: ela ENVIA. Para 13.400 pessoas de
 * uma campanha eleitoral, sem consentimento — que é precisamente o que a
 * `SKIPPED_NO_CONSENT` existe para provar que não aconteceu.
 *
 * ## Por que o gate roda no ENVIO, e não só na montagem da audiência
 *
 * Porque as duas coisas podem estar separadas por SEMANAS. Com o teto de tier
 * (2.000 destinatários únicos/24h), uma campanha para 13.400 pessoas leva uma
 * semana para escoar. Quem revogou no dia 3 NÃO pode receber no dia 6. O gate da
 * `dispatchAudience` decide quem ENTRA no lote; este decide quem SAI de verdade.
 *
 * ## A ordem importa
 *
 * A supressão global (opt-out) é ABSOLUTA e já foi checada ANTES desta chamada —
 * nem override de admin a fura (art. 8º §5º: a revogação não admite carência).
 * O que se resolve aqui é a revogação POR FINALIDADE, que NÃO suprime o telefone
 * e por isso é invisível para a checagem de supressão.
 */
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { CampaignsRepository } from './campaigns.repository';
import type { ConsentService } from '../consent/consent.service';
import { isOfficialProvider } from '../../schemas/contracts/channel-provider.schema';

/**
 * A janela de atendimento de 24h autoriza CONVERSAR, não fazer campanha de
 * marketing — só a finalidade *utility* pode se apoiar nela (spec §4.3.4).
 */
export const WINDOW_ELIGIBLE_PURPOSE = 'servico_projeto';
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Os colaboradores que o gate consulta. Injetados para o gate continuar testável. */
export type ConsentGateDeps = {
  consent: Pick<ConsentService, 'hasConsent'>;
  campaignsRepo: Pick<CampaignsRepository, 'findContactsWithOpenWindow'>;
  prisma: Pick<PrismaService, 'channel'>;
};

export type ConsentGateCampaign = {
  purposeKey: string | null;
  override: boolean;
  overrideJustification: string | null;
};

/**
 * O destinatário AINDA pode receber esta campanha? (spec §4.3)
 *
 * Extraído de `SendMessageProcessor.mayStillSend` — comportamento IDÊNTICO.
 */
export async function mayStillSendToContact(
  deps: ConsentGateDeps,
  campaign: ConsentGateCampaign,
  contactId: string,
  instanceId: string,
): Promise<boolean> {
  if (await deps.consent.hasConsent(contactId, campaign.purposeKey)) return true;

  // A janela de 24h autoriza CONVERSAR — só cobre a finalidade utility.
  if (campaign.purposeKey === WINDOW_ELIGIBLE_PURPOSE) {
    const open = await deps.campaignsRepo.findContactsWithOpenWindow(
      [contactId],
      instanceId,
      new Date(Date.now() - SERVICE_WINDOW_MS),
    );
    if (open.has(contactId)) return true;
  }

  // Override sobrevivente: inexprimível em canal oficial, e exige a
  // justificativa persistida. (O teto de destinatários e a recusa em finalidade
  // sensível já foram aplicados na criação e na materialização — reconferi-los
  // aqui custaria uma contagem da audiência POR MENSAGEM.)
  if (!campaign.override || !campaign.overrideJustification?.trim()) return false;
  const channel = await deps.prisma.channel.findUnique({
    where: { id: instanceId },
    select: { provider: true },
  });
  return channel?.provider != null && !isOfficialProvider(channel.provider);
}
