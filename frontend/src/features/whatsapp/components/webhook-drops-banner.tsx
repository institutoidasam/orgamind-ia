import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useWebhookDrops, type WebhookDropAlert } from '../api';

const PROVIDER_NAME: Record<string, string> = {
  EVOLUTION: 'Evolution',
  TWILIO: 'Twilio',
  ZERNIO: 'Zernio',
  META: 'Meta',
  GOZAP: 'GoZap',
};

/** ZERNIO identifica a conta por id; TWILIO, pelo número. */
function refLabel(drop: WebhookDropAlert): string {
  return drop.provider === 'ZERNIO' ? 'conta' : 'número';
}

/**
 * O alerta que NÃO existia quando um disparo real de ~100 mensagens foi perdido.
 *
 * Naquele incidente, os webhooks do Zernio chegavam para uma conta sem canal
 * configurado, autenticavam (HMAC ok, HTTP 200) e eram descartados com um
 * `logger.warn`. A interface seguia impecável: conversas vazias, dashboard vazio,
 * zero indicação de que dados estavam evaporando. Ninguém lê log de produção por
 * hábito — então a perda ficou invisível até o cliente reclamar.
 *
 * Este banner transforma esse silêncio em algo que grita na página Canais: qual
 * conta, quantos eventos, e o caminho para consertar (criar o canal). Some
 * sozinho assim que o canal certo existe — a resolução é a própria correção, não
 * um "marcar como lido".
 */
export function WebhookDropsBanner() {
  const { data } = useWebhookDrops();
  const drops = data?.drops ?? [];
  if (drops.length === 0) return null;

  return (
    <div className="space-y-3">
      {drops.map((drop) => (
        <Alert
          key={`${drop.provider}:${drop.accountRef}`}
          variant="destructive"
          role="alert"
        >
          <AlertTitle>
            ⚠️ Você está perdendo mensagens e status do {PROVIDER_NAME[drop.provider] ?? drop.provider}
          </AlertTitle>
          <AlertDescription>
            <p>
              Estamos recebendo eventos do{' '}
              {PROVIDER_NAME[drop.provider] ?? drop.provider} para a {refLabel(drop)}{' '}
              <code className="font-mono text-xs">{drop.accountRef}</code>, mas não
              há canal configurado para ela — então{' '}
              <strong>{drop.totalCount}</strong>{' '}
              {drop.totalCount === 1 ? 'evento foi descartado' : 'eventos foram descartados'}{' '}
              e não aparecem em nenhuma conversa nem no dashboard.
            </p>
            <p className="mt-1 text-xs">
              Eventos perdidos: {drop.events.join(', ')}. Último em{' '}
              {drop.lastSeenAt.toLocaleString('pt-BR')}.
            </p>
            <p className="mt-1 text-xs">
              Cadastre o canal desta {refLabel(drop)} abaixo para parar a perda. O
              alerta some sozinho quando o canal existir.
            </p>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
