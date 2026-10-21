import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { HTTPError } from 'ky';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Skeleton } from '@/components/ui/skeleton';
import { useTeamDispatches, useTeamTargets } from '@/features/team-whatsapp/api';
import { RecentDispatches } from '@/features/team-whatsapp/components/recent-dispatches';
import { SendWhatsappDialog } from '@/features/team-whatsapp/components/send-whatsapp-dialog';
import { MemberSelection } from '@/features/team-whatsapp/components/member-selection';
import { SectorShiftPicker } from '@/features/team-whatsapp/components/sector-shift-picker';
import {
  buildSectorTarget, selectedIdsIn, toggleAllEnabled, visibleMembers, type ShiftChoice,
} from '@/features/team-whatsapp/member-filter';
import type { SendTarget, TeamSector } from '@/features/team-whatsapp/schemas';

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
        Escolha o setor e o turno e envie para todos ou só para quem você marcar.
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
          <SendSection sectors={targets.data.sectors} onSend={setTarget} />
          <RecentSection />
        </>
      )}
      {target && (
        <SendWhatsappDialog open target={target} onOpenChange={(open) => { if (!open) setTarget(null); }} />
      )}
    </div>
  );
}

const NO_SECTORS_TEXT = 'Nenhum setor ativo para envio. Cadastre setores em Setores.';

function SendSection({ sectors, onSend }: { sectors: TeamSector[]; onSend: (target: SendTarget) => void }) {
  const [pickedSectorId, setPickedSectorId] = useState<string | null>(null);
  const [choice, setChoice] = useState<ShiftChoice | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  if (sectors.length === 0) {
    return <p className="rounded-md border p-6 text-sm text-muted-foreground">{NO_SECTORS_TEXT}</p>;
  }
  const sectorId = pickedSectorId ?? (sectors.length === 1 ? sectors[0].id : null);
  const sector = sectors.find((s) => s.id === sectorId) ?? null;
  const visible = sector && choice ? visibleMembers(sector, choice) : [];
  // Trocar setor ou turno limpa a seleção (D4).
  const pickSector = (id: string) => { setPickedSectorId(id); setSelected(new Set()); };
  const pickChoice = (c: ShiftChoice) => { setChoice(c); setSelected(new Set()); };
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  return (
    <section className="space-y-4">
      <SectorShiftPicker sectors={sectors} sectorId={sectorId} choice={choice} onSectorChange={pickSector} onChoiceChange={pickChoice} />
      {sector && choice ? (
        <MemberSelection
          sector={sector}
          choice={choice}
          selected={selected}
          onToggle={toggle}
          onToggleAll={() => setSelected(toggleAllEnabled(visible, selected))}
          onSendAll={() => onSend(buildSectorTarget(sector, choice, visible, null))}
          onSendSelected={() => onSend(buildSectorTarget(sector, choice, visible, selectedIdsIn(visible, selected)))}
        />
      ) : (
        <p className="rounded-md border p-6 text-sm text-muted-foreground">Escolha o setor e o turno</p>
      )}
    </section>
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
