import { useProviders } from '@/features/whatsapp/api';
import { PROVIDER_LABEL, type ProviderScope } from '@/features/whatsapp/provider-scope';

/**
 * Inbox header filter by channel provider (multi-provider channels — F4).
 * Same visual pattern as {@link InboxTabs} (per-instance tabs): a "Todos" tab
 * plus one tab per configured provider, hidden entirely when fewer than 2
 * providers are configured (nothing to disambiguate — mirrors
 * `ProviderScopeSelector`'s own visibility rule).
 *
 * Purely local: `value`/`onChange` are owned by the caller (ConversationsList
 * seeds the initial value from the global provider scope but does not push
 * local changes back into it — see useProviderScope in provider-scope.tsx).
 *
 * Pedido do cliente (2026-08-25): TWILIO nunca é oferecido aqui, mesmo
 * configurado no backend — o enum/tipo do provider continua intacto, só a
 * oferta na UI do inbox some (o "fewer than 2" acima passa a contar só os
 * providers realmente ofertados). GOZAP, quando presente, vem sempre
 * primeiro — logo após "Todos" — é o canal padrão deste cliente; ver o
 * default correspondente em ConversationsList.
 */
export function ProviderTabs({
  value,
  onChange,
}: {
  value: ProviderScope;
  onChange: (scope: ProviderScope) => void;
}) {
  const { data } = useProviders();
  const offered = (data?.providers ?? []).filter(({ provider }) => provider !== 'TWILIO');
  if (offered.length < 2) return null;

  const gozapIndex = offered.findIndex(({ provider }) => provider === 'GOZAP');
  const providers =
    gozapIndex <= 0
      ? offered
      : [offered[gozapIndex], ...offered.slice(0, gozapIndex), ...offered.slice(gozapIndex + 1)];

  const tabs: Array<{ id: ProviderScope; label: string }> = [
    { id: 'all', label: 'Todos' },
    ...providers.map(({ provider }) => ({ id: provider, label: PROVIDER_LABEL[provider] })),
  ];

  return (
    <div>
      <div
        className="text-[10px] font-medium uppercase"
        style={{ letterSpacing: '0.06em', color: 'var(--foreground-muted)' }}
      >
        provedor
      </div>
      <div className="mt-1 flex gap-1.5 overflow-x-auto pb-0.5 text-xs">
        {tabs.map((t) => {
          const selected = value === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5"
              style={{
                background: selected ? 'var(--st-read-bg)' : 'transparent',
                color: selected ? 'var(--brand-purple)' : 'var(--foreground-muted)',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
