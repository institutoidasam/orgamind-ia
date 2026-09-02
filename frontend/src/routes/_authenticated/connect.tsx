import { createFileRoute } from '@tanstack/react-router';
import { useProviders } from '@/features/whatsapp/api';
import { useProviderScope, ProviderBadge } from '@/features/whatsapp/provider-scope';
import { EvolutionSection } from '@/features/whatsapp/components/evolution-section';
import { GozapSection } from '@/features/whatsapp/components/gozap-section';
import { CloudProviderSection } from '@/features/whatsapp/components/cloud-provider-section';
import { WebhookDropsBanner } from '@/features/whatsapp/components/webhook-drops-banner';
import { useAuthStore } from '@/stores/auth.store';
import { QueryErrorFallback } from '@/components/query-error-fallback';

export const Route = createFileRoute('/_authenticated/connect')({
  component: ConnectPage,
});

/**
 * "Canais": one section per configured provider (respecting the global provider
 * scope). EVOLUTION and GOZAP are both session-based (pair by QR) but
 * provision differently — EVOLUTION spins up a local Baileys session,
 * GOZAP calls out to create an instance on the GoZap SaaS — so each gets its
 * own section rather than a forced-generic one; TWILIO/ZERNIO/META list their
 * registered channels + a registration form. A provider that isn't configured
 * on this deploy simply has no section — so a single-provider (Evolution-only)
 * deploy renders exactly the old page, with no empty extras.
 */
function ConnectPage() {
  const role = useAuthStore((s) => s.user?.role ?? 'OPERATOR') as 'ADMIN' | 'OPERATOR';
  const providers = useProviders();
  const { scope } = useProviderScope();

  if (providers.isError) {
    return <QueryErrorFallback error={providers.error} onRetry={() => providers.refetch()} />;
  }

  const all = providers.data?.providers ?? [];
  const filtered = scope === 'all' ? all : all.filter((p) => p.provider === scope);
  // A stale persisted scope pointing at a provider that isn't configured here
  // would filter everything out — fall back to all configured providers so the
  // page never goes blank.
  const visible = filtered.length > 0 ? filtered : all;
  // Only label sections when more than one is shown; a lone provider reads as
  // the plain page it always was.
  const showHeaders = visible.length > 1;

  // A deploy with no complete provider credential group at all (e.g. a fresh
  // environment before the operator has set any of it up) — GET
  // /whatsapp/providers legitimately returns `providers: []`. Without this,
  // the page would silently render nothing.
  //
  // O banner de perda vem JUNTO mesmo aqui: "nenhum provedor configurado" e
  // "estamos recebendo webhooks que não conseguimos atender" é exatamente a
  // combinação mais grave — e a mais silenciosa.
  if (providers.data && all.length === 0) {
    return (
      <div className="mx-auto max-w-[720px] space-y-4">
        <WebhookDropsBanner />
        <p className="text-sm text-muted-foreground">
          Nenhum provedor configurado no servidor.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[720px] space-y-8">
      {/* Perda de webhook em curso (conta sem canal) — o alerta que faltava
          quando um disparo inteiro sumiu sem deixar rastro na interface. */}
      <WebhookDropsBanner />

      {visible.map(({ provider, channels }) => (
        <section key={provider} className="space-y-3">
          {showHeaders && (
            <div className="flex items-center gap-2 border-b border-[var(--border)] pb-2">
              <ProviderBadge provider={provider} />
            </div>
          )}
          {provider === 'EVOLUTION' ? (
            <EvolutionSection role={role} />
          ) : provider === 'GOZAP' ? (
            <GozapSection role={role} channels={channels} />
          ) : (
            <CloudProviderSection provider={provider} channels={channels} role={role} />
          )}
        </section>
      ))}
    </div>
  );
}
