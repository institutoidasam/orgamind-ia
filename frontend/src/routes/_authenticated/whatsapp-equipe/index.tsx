import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { HTTPError } from 'ky';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Skeleton } from '@/components/ui/skeleton';
import { useTeamDispatches, useTeamTargets } from '@/features/team-whatsapp/api';
import { RecentDispatches } from '@/features/team-whatsapp/components/recent-dispatches';
import { SendWhatsappDialog } from '@/features/team-whatsapp/components/send-whatsapp-dialog';
import { TeamSectorCard } from '@/features/team-whatsapp/components/team-sector-card';
import type { SendTarget } from '@/features/team-whatsapp/schemas';

const route = createFileRoute('/_authenticated/whatsapp-equipe/')({
  component: TeamWhatsappPage,
});
export { route as Route };

const FORBIDDEN_TEXT = 'Só o administrador e o gestor do setor enviam mensagens para a equipe.';

function PageHeader() {
  return (
    <header>
      <p className="ds-eyebrow">comunicação · equipe</p>
      <h1 className="text-2xl font-bold">WhatsApp da equipe</h1>
      <p className="text-sm text-muted-foreground">
        Mande uma mensagem de WhatsApp para uma pessoa ou para o setor inteiro.
      </p>
    </header>
  );
}

function TeamWhatsappPage() {
  const targets = useTeamTargets();
  const [target, setTarget] = useState<SendTarget | null>(null);
  return (
    <div className="space-y-6">
      <PageHeader />
      {targets.isLoading && <Skeleton className="h-40 w-full" />}
      {targets.isError && <TargetsError error={targets.error} onRetry={targets.refetch} />}
      {targets.data && (
        <>
          {targets.data.sectors.map((s) => <TeamSectorCard key={s.id} sector={s} onSend={setTarget} />)}
          <RecentSection />
        </>
      )}
      {target && (
        <SendWhatsappDialog open target={target} onOpenChange={(open) => { if (!open) setTarget(null); }} />
      )}
    </div>
  );
}

function TargetsError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof HTTPError && error.response.status === 403) {
    return <p className="rounded-md border p-6 text-sm text-muted-foreground">{FORBIDDEN_TEXT}</p>;
  }
  return <QueryErrorFallback error={error} onRetry={onRetry} />;
}

function RecentSection() {
  const dispatches = useTeamDispatches();
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Envios recentes</h2>
      {dispatches.isError && <QueryErrorFallback error={dispatches.error} onRetry={dispatches.refetch} />}
      {dispatches.data && <RecentDispatches items={dispatches.data.items} />}
    </section>
  );
}
