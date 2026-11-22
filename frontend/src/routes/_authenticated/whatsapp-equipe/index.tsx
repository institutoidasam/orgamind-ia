import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { HTTPError } from 'ky';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useScheduledDispatches, useTeamDispatches, useTeamRoster, useTeamTargets,
} from '@/features/team-whatsapp/api';
import { InProgressNotice } from '@/features/team-whatsapp/components/in-progress-notice';
import { PagedError } from '@/features/team-whatsapp/components/paged-error';
import { RecentDispatches } from '@/features/team-whatsapp/components/recent-dispatches';
import { ScheduledDispatches } from '@/features/team-whatsapp/components/scheduled-dispatches';
import { SendWhatsappDialog } from '@/features/team-whatsapp/components/send-whatsapp-dialog';
import { MemberSelection, type SectorGroup } from '@/features/team-whatsapp/components/member-selection';
import { SectorShiftPicker } from '@/features/team-whatsapp/components/sector-shift-picker';
import {
  buildSectorTarget, eligibleMembers, filterByLevel, noScheduleCount, offMembers, selectedIdsIn, toggleAllEnabled,
  type LevelFilter,
} from '@/features/team-whatsapp/member-filter';
import { apiErrorCode, teamErrorMessage } from '@/features/team-whatsapp/error-messages';
import type { SendTarget, TeamRoster, TeamTargets } from '@/features/team-whatsapp/schemas';
import { useBackToLastPage } from '@/features/team-whatsapp/use-back-to-last-page';
import { useSendFilters } from '@/features/team-whatsapp/use-send-filters';

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
          <SendSection targets={targets.data} onSend={setTarget} />
          <ScheduledSection />
          <RecentSection />
        </>
      )}
      {target && (
        <SendWhatsappDialog open target={target} onOpenChange={(open) => { if (!open) setTarget(null); }} />
      )}
    </div>
  );
}

const TOO_MANY_PEOPLE = 'team_whatsapp.too_many_people';
const NO_SECTORS_TEXT = 'Nenhum setor ativo para envio. Cadastre setores em Setores.';

type Filters = ReturnType<typeof useSendFilters>;
type SendProps = { targets: TeamTargets; onSend: (target: SendTarget) => void };

function SendSection({ targets, onSend }: SendProps) {
  const filters = useSendFilters(targets.today, targets.sectors);
  if (targets.sectors.length === 0) {
    return <p className="rounded-md border p-6 text-sm text-muted-foreground">{NO_SECTORS_TEXT}</p>;
  }
  const { sectorIds, shiftIds, date } = filters;
  const { inProgress } = targets;
  const ready = sectorIds.length > 0 && filters.shiftsPicked && date !== '';
  return (
    <section className="space-y-4">
      {inProgress && (
        <InProgressNotice
          inProgress={inProgress}
          current={{ date, shiftIds }}
          onView={() => filters.viewShift(inProgress.date, inProgress.shift.id)}
        />
      )}
      <SectorShiftPicker
        sectors={targets.sectors} levels={targets.levels} shifts={targets.shifts}
        sectorIds={sectorIds} levelIds={filters.levelIds} withoutLevel={filters.withoutLevel}
        date={date} shiftIds={shiftIds} shiftsPicked={filters.shiftsPicked}
        onSectorsChange={filters.pickSectors} onLevelsChange={filters.pickLevels}
        onDateChange={filters.pickDate} onShiftsChange={filters.pickShifts}
      />
      {ready ? (
        <RosterSection targets={targets} filters={filters} picked={{ sectorIds, date, shiftIds }} onSend={onSend} />
      ) : (
        <p className="rounded-md border p-6 text-sm text-muted-foreground">Escolha o setor, a data e o turno</p>
      )}
    </section>
  );
}

type RosterSectionProps = {
  targets: TeamTargets;
  filters: Filters;
  picked: { sectorIds: string[]; date: string; shiftIds: string[] };
  onSend: (target: SendTarget) => void;
};

/**
 * Erro da escala: o 422 `too_many_people` diz para escolher menos setores (GC11); os demais ficam com
 * o texto do servidor. Sempre com `Tentar novamente` (D14).
 */
function RosterError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const [known, setKnown] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void apiErrorCode(error).then((code) => {
      if (!cancelled) setKnown(code === TOO_MANY_PEOPLE ? teamErrorMessage(code) : null);
    });
    return () => { cancelled = true; };
  }, [error]);
  const shown = useMemo(() => (known ? new Error(known) : error), [known, error]);
  return <QueryErrorFallback error={shown} onRetry={onRetry} />;
}

function RosterSection({ targets, filters, picked, onSend }: RosterSectionProps) {
  const roster = useTeamRoster(picked.sectorIds, picked.date);
  if (roster.isLoading) return <Skeleton className="h-40 w-full" />;
  if (roster.isError) return <RosterError error={roster.error} onRetry={() => roster.refetch()} />;
  if (!roster.data) return null;
  return <RosterList roster={roster.data} targets={targets} filters={filters} shiftIds={picked.shiftIds} onSend={onSend} />;
}

type RosterListProps = {
  roster: TeamRoster;
  targets: TeamTargets;
  filters: Filters;
  shiftIds: string[];
  onSend: (target: SendTarget) => void;
};

/** Anexa o início do turno (ISO do servidor + hora gravada) para o diálogo habilitar o agendamento. */
function withShiftStart(roster: TeamRoster, targets: TeamTargets, target: SendTarget): SendTarget {
  if (target.type !== 'sector' || target.shiftIds.length !== 1) return target;
  const [shiftId] = target.shiftIds;
  const startsAt = roster.shiftStarts.find((s) => s.shiftId === shiftId)?.startsAt;
  const startTime = targets.shifts.find((s) => s.id === shiftId)?.startTime;
  return startsAt && startTime ? { ...target, shiftStart: { startsAt, startTime } } : target;
}

function RosterList({ roster, targets, filters, shiftIds, onSend }: RosterListProps) {
  const { includeOff, selected } = filters;
  const levelFilter: LevelFilter = { levelIds: filters.levelIds, withoutLevel: filters.withoutLevel };
  const shiftNames = new Map(targets.shifts.map((s) => [s.id, s.name]));
  // O filtro de nível vale para quem trabalha e para quem está de folga: a lista conferida é a que o servidor refaz.
  const groups: SectorGroup[] = roster.sectors.map((s) => {
    const members = filterByLevel(s.members, levelFilter);
    return {
      sectorId: s.sectorId,
      name: s.name,
      empty: !s.members.some((m) => m.isActive),
      visible: eligibleMembers(members, shiftIds, includeOff),
      off: offMembers(members),
      noSchedule: noScheduleCount(members),
    };
  });
  const visible = groups.flatMap((g) => g.visible);
  const build = (selectedIds: string[] | null) =>
    withShiftStart(roster, targets, buildSectorTarget({
      sectors: roster.sectors.map((s) => ({ id: s.sectorId, name: s.name, members: s.members })),
      levels: targets.levels, levelFilter, shifts: targets.shifts, shiftIds,
      date: roster.date, includeOff, selectedIds,
    }));
  return (
    <MemberSelection
      shiftIds={shiftIds}
      groups={groups}
      includeOff={includeOff}
      shiftNames={shiftNames}
      selected={selected}
      onToggle={filters.toggle}
      onToggleOff={filters.toggleOff}
      onToggleAll={() => filters.setSelected(toggleAllEnabled(visible, selected))}
      onSendAll={() => onSend(build(null))}
      onSendSelected={() => onSend(build(selectedIdsIn(visible, selected)))}
    />
  );
}

function TargetsError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof HTTPError && error.response.status === 403) {
    return <p className="rounded-md border p-6 text-sm text-muted-foreground">{FORBIDDEN_TEXT}</p>;
  }
  return <QueryErrorFallback error={error} onRetry={onRetry} />;
}

function ScheduledSection() {
  const [page, setPage] = useState(1);
  const scheduled = useScheduledDispatches(page);
  useBackToLastPage(page, setPage, scheduled.data);
  if (scheduled.isError) {
    return <PagedError error={scheduled.error} onRetry={scheduled.refetch} page={page} onFirstPage={() => setPage(1)} />;
  }
  const { data } = scheduled;
  if (!data) return null;
  return <ScheduledDispatches items={data.items} paging={{ page, pageSize: data.pageSize, total: data.total, onPageChange: setPage }} />;
}

function RecentSection() {
  const [page, setPage] = useState(1);
  const dispatches = useTeamDispatches(page);
  useBackToLastPage(page, setPage, dispatches.data);
  const { data } = dispatches;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Envios recentes</h2>
      {dispatches.isError && (
        <PagedError error={dispatches.error} onRetry={dispatches.refetch} page={page} onFirstPage={() => setPage(1)} />
      )}
      {data && (
        <RecentDispatches items={data.items} paging={{ page, pageSize: data.pageSize, total: data.total, onPageChange: setPage }} />
      )}
    </section>
  );
}
