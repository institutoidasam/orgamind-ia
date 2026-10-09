import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Instance } from '../schemas';
import { initials } from '@/lib/initials';
import { QuotaPanel } from './quota-panel';

type Props = {
  instance: Instance;
  isExpanded: boolean;
  isOnline: boolean;
  isAdmin: boolean;
  onToggle: () => void;
  onConnect: () => void;
  onSetDefault: () => void;
  onRestart: () => void;
  onRemove: () => void;
  onOpenConfig: () => void;
};

function stateInfo(online: boolean, instance: Instance) {
  if (online) return { dot: '#10b981', label: 'conectado' };
  if (!instance.phoneE164) return { dot: '#ef4444', label: 'escaneie QR' };
  return { dot: '#ef4444', label: 'desconectado' };
}

export function InstanceRow(props: Props) {
  const { instance, isExpanded, isOnline, isAdmin } = props;
  const info = stateInfo(isOnline, instance);
  // U1: the device WhatsApp profile — non-null parts joined with ' · ',
  // falling back to '—' when the profile was never synced.
  const profileParts = [instance.profileName, instance.phoneE164].filter(
    (p): p is string => p != null,
  );
  const subtitle = `${profileParts.length > 0 ? profileParts.join(' · ') : '—'} · ${info.label}`;

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-3 text-left"
        onClick={props.onToggle}
        aria-expanded={isExpanded}
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ background: info.dot }}
          aria-hidden
        />
        <span
          className="grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold"
          style={{ background: 'var(--surface-sunken)', color: 'var(--foreground-muted)' }}
        >
          {instance.profilePictureUrl ? (
            <img
              src={instance.profilePictureUrl}
              alt=""
              className="size-8 rounded-full object-cover"
            />
          ) : (
            initials(instance.name)
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="truncate text-sm">{instance.name}</strong>
            {instance.isDefault && (
              <span className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                default
              </span>
            )}
          </div>
          <div className="truncate text-xs text-[var(--foreground-muted)]">
            {subtitle}
          </div>
        </div>
        {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </button>

      {isExpanded && (
        <div className="space-y-3 border-t border-[var(--border)] px-3 py-3 text-xs">
          <QuotaPanel instance={instance} />
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              {!isOnline && (
                <button
                  type="button"
                  className="rounded border border-[var(--brand-navy)] bg-[var(--brand-navy)] px-2 py-1 font-medium text-white"
                  onClick={props.onConnect}
                >
                  Conectar (QR)
                </button>
              )}
              <button type="button" className="rounded border px-2 py-1" onClick={props.onOpenConfig}>
                Configurações
              </button>
              <button type="button" className="rounded border px-2 py-1" onClick={props.onRestart}>
                Reiniciar
              </button>
              {!instance.isDefault && (
                <button type="button" className="rounded border px-2 py-1" onClick={props.onSetDefault}>
                  Tornar padrão
                </button>
              )}
              <button type="button" className="rounded border px-2 py-1 text-destructive" onClick={props.onRemove}>
                Remover
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
