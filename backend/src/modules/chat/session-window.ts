import type { ChannelProvider } from '@prisma/client';
import {
  channelProviderEnum,
  PROVIDER_TRAITS,
} from '../../schemas/contracts/channel-provider.schema';

/**
 * A JANELA DE ATENDIMENTO DE 24h — fonte única.
 *
 * É regra da META, não de um provedor: texto livre (mensagem de sessão) só pode
 * ser enviado até 24h depois da ÚLTIMA mensagem que o TITULAR mandou. Fora dela
 * a Meta REJEITA (63016 pela Twilio, 131047 pelo Zernio) e só template passa.
 *
 * Portanto vale IDENTICAMENTE para todo canal que fala com a Cloud API —
 * TWILIO e ZERNIO. Não vale para EVOLUTION (Baileys/WhatsApp Web: não existe
 * janela) nem para META (que ainda não tem caminho de envio de chat).
 *
 * Por que este arquivo existe: a regra estava escrita como `provider ===
 * 'TWILIO'` em TRÊS lugares (guard de envio, mapper do resumo, composer) — e foi
 * exatamente por isso que o ZERNIO ficou de fora dos três de uma vez, deixando o
 * operador sem conseguir responder ninguém no único canal do cliente. Uma regra,
 * um lugar.
 *
 * ATENÇÃO — NÃO CONFUNDIR com a janela de CONSENTIMENTO de campanha
 * (`WINDOW_ELIGIBLE_PURPOSE` / `SERVICE_WINDOW_MS` em campaigns.service e
 * send-message.processor). Aquilo é elegibilidade jurídica de DISPARO; isto aqui
 * é a regra técnica da Meta para RESPOSTA MANUAL 1-a-1 no inbox. São caminhos
 * diferentes, e "unificar as constantes de 24h" entre os dois é exatamente como
 * se afrouxa o gate de consentimento sem perceber.
 */
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Providers cujo envio de texto livre está sujeito à janela de 24h da Meta. */
const SESSION_WINDOW_PROVIDERS: ReadonlySet<string> = new Set(
  channelProviderEnum.options.filter((p) => PROVIDER_TRAITS[p].sessionWindow),
);

export function hasSessionWindow(
  provider: ChannelProvider | string | null | undefined,
): boolean {
  return provider != null && SESSION_WINDOW_PROVIDERS.has(provider);
}

/**
 * Instante em que a janela fecha — null quando o canal não tem janela ou quando
 * nunca houve inbound (a janela nunca abriu; fail-closed).
 */
export function sessionWindowExpiresAt(
  provider: ChannelProvider | string | null | undefined,
  lastInboundAt: Date | null | undefined,
): Date | null {
  if (!hasSessionWindow(provider) || !lastInboundAt) return null;
  return new Date(lastInboundAt.getTime() + SESSION_WINDOW_MS);
}
