import { Link } from '@tanstack/react-router';
import { useInstances, useProviders } from '@/features/whatsapp/api';

type Indicator = {
  label: string;
  tone: 'green' | 'yellow' | 'red';
  /** Pulses the dot via CSS — used for live transitional states like connecting. */
  pulse: boolean;
};

/** Uma conexão do ponto de vista do chip — Evolution ou canal cloud. */
type Connection = { id: string; name: string; online: boolean };

export const TONE_STYLES: Record<Indicator['tone'], { dot: string; bg: string; fg: string; border: string }> = {
  green: {
    dot: '#10b981',
    bg: 'color-mix(in oklch, #10b981 12%, transparent)',
    fg: '#047857',
    border: 'color-mix(in oklch, #10b981 35%, transparent)',
  },
  yellow: {
    dot: '#eab308',
    bg: 'color-mix(in oklch, #eab308 14%, transparent)',
    fg: '#854d0e',
    border: 'color-mix(in oklch, #eab308 40%, transparent)',
  },
  red: {
    dot: '#ef4444',
    bg: 'color-mix(in oklch, #ef4444 12%, transparent)',
    fg: '#b91c1c',
    border: 'color-mix(in oklch, #ef4444 35%, transparent)',
  },
};

/**
 * Pill in the topbar that reflects the live WhatsApp connection status.
 *
 * Duas famílias de canal, dois critérios de "online":
 * - EVOLUTION: precisa de sessão pareada → online é `lastConnectionState ===
 *   'open'` (vem de GET /whatsapp/instances, que é Evolution-only).
 * - Canal cloud (ZERNIO/TWILIO/META): não existe handshake — o canal ATIVO já
 *   envia e recebe, então conta como online (vem de GET /whatsapp/providers;
 *   mesma composição da barra de abas do inbox, ver conversations-list.tsx).
 *
 * Sem a segunda família, o chip de prod mostrava "Conexões: 0/2" (duas
 * instâncias Evolution zumbis) enquanto o canal ZERNIO entregava campanha —
 * o operador lia "nada conectado" num sistema funcionando.
 *
 * - 0 conexões: renders nothing.
 * - 1 conexão: pill único com o nome.
 * - N conexões: pill compacto "Conexões: X/N".
 * Clicking always jumps to /connect.
 */
export function WhatsappStatusIndicator() {
  const { data: instances } = useInstances();
  const { data: providers } = useProviders();

  const evolution: Connection[] = (instances ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    online: i.lastConnectionState === 'open',
  }));
  // O grupo EVOLUTION de /providers fica de fora: são as MESMAS instâncias de
  // /whatsapp/instances por outra rota — somá-lo contaria cada uma duas vezes.
  const cloud: Connection[] = (providers?.providers ?? [])
    .filter((p) => !p.traits.sessionBased)
    .flatMap((p) => p.channels)
    .filter((c) => c.isActive)
    .map((c) => ({ id: c.id, name: c.name, online: true }));
  const connections = [...evolution, ...cloud];

  if (connections.length === 0) {
    // Nothing configured yet — render nothing (matches old "loading" semantics)
    return null;
  }

  if (connections.length === 1) {
    return <SingleConnectionPill connection={connections[0]} />;
  }

  return <MultiConnectionPill connections={connections} />;
}

function SingleConnectionPill({ connection }: { connection: Connection }) {
  const isOnline = connection.online;
  return (
    <Link
      to="/connect"
      title="Ver status da conexão WhatsApp"
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors hover:opacity-80"
      style={{
        background: isOnline
          ? 'color-mix(in oklch, #10b981 12%, transparent)'
          : 'color-mix(in oklch, #ef4444 12%, transparent)',
        color: isOnline ? '#047857' : '#b91c1c',
        border: `1px solid ${isOnline
          ? 'color-mix(in oklch, #10b981 35%, transparent)'
          : 'color-mix(in oklch, #ef4444 35%, transparent)'}`,
      }}
    >
      <span
        className={`inline-block size-1.5 rounded-full ${isOnline ? '' : 'animate-pulse'}`}
        style={{ background: isOnline ? '#10b981' : '#ef4444' }}
      />
      {connection.name}
    </Link>
  );
}

function MultiConnectionPill({ connections }: { connections: Connection[] }) {
  const online = connections.filter((c) => c.online).length;
  const total = connections.length;
  const allOnline = online === total;

  return (
    <Link
      to="/connect"
      title="Ver status das conexões WhatsApp"
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors hover:opacity-80"
      style={{
        background: allOnline
          ? 'color-mix(in oklch, #10b981 12%, transparent)'
          : 'color-mix(in oklch, #eab308 14%, transparent)',
        color: allOnline ? '#047857' : '#854d0e',
        border: `1px solid ${allOnline
          ? 'color-mix(in oklch, #10b981 35%, transparent)'
          : 'color-mix(in oklch, #eab308 40%, transparent)'}`,
      }}
    >
      <span
        className="inline-block size-1.5 rounded-full"
        style={{ background: allOnline ? '#10b981' : '#eab308' }}
      />
      Conexões: {online}/{total}
    </Link>
  );
}
