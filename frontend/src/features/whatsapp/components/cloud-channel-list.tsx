import type { ChannelSummary, ZernioSyncStatus } from '../api';
import { ProviderBadge, ConnectionStateBadge } from '../provider-scope';

/**
 * O rótulo do botão enquanto o job roda. O operador precisa saber DUAS coisas: se
 * anda, e quanto falta. "Sincronizando…" eterno não responde nenhuma das duas —
 * e era o que a tela mostrava enquanto a request de 3 minutos caminhava para o
 * HTTP 500.
 */
function syncLabel(status: ZernioSyncStatus | null | undefined): string {
  if (!status) return 'Sincronizando…';
  switch (status.status) {
    case 'PENDING':
      return 'Na fila…';
    // Cedeu o balde do Zernio para uma campanha em curso. Não é erro nem
    // travamento: o envio tem prioridade e o sync retoma sozinho depois.
    case 'PAUSED':
      return 'Aguardando o envio…';
    case 'RUNNING':
      return status.total > 0
        ? `${status.processed} de ${status.total} conversas…`
        : 'Sincronizando…';
    default:
      return 'Sincronizando…';
  }
}

/**
 * List of cloud-provider (TWILIO/ZERNIO/META) channels: name, number, provider
 * badge, default/inactive markers. Cloud channels have no QR / restart
 * lifecycle, so this is a flat display — creation happens via
 * {@link CreateChannelForm}.
 *
 * A única ação por canal é "Sincronizar inbox" (só ZERNIO, só ADMIN): puxa para
 * o orgamind as conversas que aconteceram no painel do Zernio. A lista é BURRA — a
 * mutação, o polling e o toast ficam na CloudProviderSection, como em
 * instances-list.
 */
export function CloudChannelList({
  channels,
  onSyncInbox,
  syncingId,
  syncStatus,
  onSetActive,
  togglingId,
}: {
  channels: ChannelSummary[];
  /** Ausente => nenhum botão de sync (não-ZERNIO, ou operador). */
  onSyncInbox?: (id: string) => void;
  syncingId?: string | null;
  /** Progresso do job do canal em `syncingId` (vem do polling). */
  syncStatus?: ZernioSyncStatus | null;
  /** Ausente => nenhum botão de ativar/desativar (operador). */
  onSetActive?: (id: string, active: boolean) => void;
  togglingId?: string | null;
}) {
  if (channels.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-[var(--border)] px-3 py-6 text-center text-sm text-[var(--foreground-muted)]">
        Nenhum canal cadastrado ainda.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {channels.map((ch) => (
        <div
          key={ch.id}
          className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <strong className="truncate text-sm">{ch.name}</strong>
              {ch.isDefault && (
                <span className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                  default
                </span>
              )}
              {!ch.isActive && (
                <span className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--foreground-muted)]">
                  inativo
                </span>
              )}
            </div>
            <div className="truncate text-xs text-[var(--foreground-muted)]">
              {ch.phoneE164 ?? '—'}
            </div>
            <ConnectionStateBadge state={ch.connectionState} />
          </div>
          {onSyncInbox && (
            <button
              type="button"
              className="rounded border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-50"
              disabled={syncingId === ch.id}
              onClick={() => onSyncInbox(ch.id)}
              title="Importa para a inbox as conversas que aconteceram no painel do Zernio"
            >
              {syncingId === ch.id ? syncLabel(syncStatus) : 'Sincronizar inbox'}
            </button>
          )}
          {onSetActive && (
            <button
              type="button"
              className="rounded border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-50"
              disabled={togglingId === ch.id}
              onClick={() => onSetActive(ch.id, !ch.isActive)}
              title={
                ch.isActive
                  ? 'Desativa o canal: ele some do assistente de campanha e das abas do inbox. Não apaga nada — as conversas e o histórico continuam.'
                  : 'Reativa o canal: ele volta a ser oferecido como opção de envio.'
              }
            >
              {ch.isActive ? 'Desativar' : 'Reativar'}
            </button>
          )}
          <ProviderBadge provider={ch.provider} />
        </div>
      ))}
    </div>
  );
}
