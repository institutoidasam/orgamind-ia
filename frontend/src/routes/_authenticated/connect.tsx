import { createFileRoute } from "@tanstack/react-router";
import { useProviders, type ProvidersResponse } from "@/features/whatsapp/api";
import {
  useProviderScope,
  ProviderBadge,
  type ProviderScope,
} from "@/features/whatsapp/provider-scope";
import { EvolutionSection } from "@/features/whatsapp/components/evolution-section";
import { GozapSection } from "@/features/whatsapp/components/gozap-section";
import { CloudProviderSection } from "@/features/whatsapp/components/cloud-provider-section";
import { WebhookDropsBanner } from "@/features/whatsapp/components/webhook-drops-banner";
import { useAuthStore } from "@/stores/auth.store";
import { QueryErrorFallback } from "@/components/query-error-fallback";
import { NumberRegistry } from "@/features/internal-admin/components/number-registry";

const route = createFileRoute("/_authenticated/connect")({
  component: ConnectPage,
});
export { route as Route };

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
  const role = useAuthStore((s) =>
    s.user?.role === "ADMIN" ? "ADMIN" : "OPERATOR",
  );
  const providers = useProviders();
  const { scope } = useProviderScope();

  if (providers.isError) {
    return (
      <QueryErrorFallback
        error={providers.error}
        onRetry={() => providers.refetch()}
      />
    );
  }

  const all = providers.data?.providers ?? [];
  if (providers.data && all.length === 0) return <NoProvidersState />;
  return <ConnectContent role={role} providers={getVisibleProviders(all, scope)} />;
}

type ProviderGroup = ProvidersResponse["providers"][number];

function getVisibleProviders(all: ProviderGroup[], scope: ProviderScope) {
  const filtered = scope === "all" ? all : all.filter((item) => item.provider === scope);
  return filtered.length > 0 ? filtered : all;
}

function NoProvidersState() {
  return <div className="mx-auto max-w-[720px] space-y-4"><WebhookDropsBanner /><p className="text-sm text-muted-foreground">Nenhum provedor configurado no servidor.</p></div>;
}

function ConnectContent({ role, providers }: { role: "ADMIN" | "OPERATOR"; providers: ProviderGroup[] }) {
  const showHeaders = providers.length > 1;
  return <div className="mx-auto max-w-[720px] space-y-8">{role === "ADMIN" ? <NumberRegistry /> : null}<WebhookDropsBanner />{providers.map((group) => <ProviderSection key={group.provider} group={group} role={role} showHeader={showHeaders} />)}</div>;
}

function ProviderSection({ group, role, showHeader }: { group: ProviderGroup; role: "ADMIN" | "OPERATOR"; showHeader: boolean }) {
  const { provider, channels } = group;
  return <section className="space-y-3">{showHeader ? <div className="flex items-center gap-2 border-b border-[var(--border)] pb-2"><ProviderBadge provider={provider} /></div> : null}{provider === "EVOLUTION" ? <EvolutionSection role={role} /> : provider === "GOZAP" ? <GozapSection role={role} channels={channels} /> : <CloudProviderSection provider={provider} channels={channels} role={role} />}</section>;
}
