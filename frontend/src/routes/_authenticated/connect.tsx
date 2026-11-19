import { createFileRoute } from "@tanstack/react-router";
import { useProviders, type ProvidersResponse } from "@/features/whatsapp/api";
import { EvolutionSection } from "@/features/whatsapp/components/evolution-section";
import { DisabledChannelsSection } from "@/features/whatsapp/components/disabled-channels-section";
import { SectorsWithoutNumberNotice } from "@/features/whatsapp/components/sectors-without-number-notice";
import { useAuthStore } from "@/stores/auth.store";
import { QueryErrorFallback } from "@/components/query-error-fallback";
import { isEnabledProvider } from "@/features/whatsapp/disabled-provider";

const route = createFileRoute("/_authenticated/connect")({
  component: ConnectPage,
});
export { route as Route };

/**
 * "Conexões": só a seção Evolution (nenhuma escolha de provedor na UI). No topo,
 * um aviso único das áreas sem número (D15); associar número a área é por linha,
 * no botão `Áreas` de cada conexão (só o ADMIN). Para o ADMIN, números de
 * integrações desligadas que ainda existem aparecem no bloco "Números
 * desligados", com a ação Remover (a autorização é do back; aqui só se esconde).
 */
function ConnectPage() {
  const isAdmin = useAuthStore((s) => s.user?.role === "ADMIN");
  const providers = useProviders();

  if (providers.isError) {
    return (
      <QueryErrorFallback
        error={providers.error}
        onRetry={() => providers.refetch()}
      />
    );
  }

  const data = providers.data;
  if (data && !data.providers.some((g) => isEnabledProvider(g.provider))) return <NoProvidersState />;
  return <ConnectContent isAdmin={isAdmin} data={data} />;
}

/** `data` indefinido = carregando: só o aviso de áreas, sem seções nem estado vazio. */
function ConnectContent({ isAdmin, data }: { isAdmin: boolean; data: ProvidersResponse | undefined }) {
  const disabled = isAdmin && data ? data.disabledChannels : [];
  return (
    <div className="mx-auto max-w-[720px] space-y-8">
      <SectorsWithoutNumberNotice />
      {data ? <EvolutionSection role={isAdmin ? "ADMIN" : "OPERATOR"} /> : null}
      {disabled.length > 0 ? <DisabledChannelsSection channels={disabled} /> : null}
    </div>
  );
}

function NoProvidersState() {
  return (
    <div className="mx-auto max-w-[720px] space-y-4">
      <p className="text-sm text-muted-foreground">Nenhum provedor configurado no servidor.</p>
    </div>
  );
}
