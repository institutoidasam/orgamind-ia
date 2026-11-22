import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { HTTPError } from 'ky';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/features/permissions/use-permission';
import {
  useScheduledDispatches, useTeamRoster, useTeamTargets,
} from '@/features/team-whatsapp/api';
import { InProgressNotice } from '@/features/team-whatsapp/components/in-progress-notice';
import { PagedError } from '@/features/team-whatsapp/components/paged-error';
import { PurposeFields } from '@/features/team-whatsapp/components/purpose-fields';
import { RecentHistory } from '@/features/team-whatsapp/components/recent-dispatches';
import { ScheduledDispatches } from '@/features/team-whatsapp/components/scheduled-dispatches';
import { SendWhatsappDialog } from '@/features/team-whatsapp/components/send-whatsapp-dialog';
import { MemberSelection } from '@/features/team-whatsapp/components/member-selection';
import { SectorShiftPicker } from '@/features/team-whatsapp/components/sector-shift-picker';
import { buildSectorTarget, markableIds, toggleAllMarkable } from '@/features/team-whatsapp/member-filter';
import { useMessageDraft, type MessageDraft } from '@/features/team-whatsapp/message-draft';
import { apiErrorCode, teamErrorMessage } from '@/features/team-whatsapp/error-messages';
import type { SendTarget, TeamAudiencePreview, TeamRoster, TeamTargets } from '@/features/team-whatsapp/schemas';
import { initialSendFilters, validateSendSearch } from '@/features/team-whatsapp/send-search';
import { useBackToLastPage } from '@/features/team-whatsapp/use-back-to-last-page';
import { useDebouncedAudience } from '@/features/team-whatsapp/use-audience-preview';
import {
  NOW_MOMENT, referenceDate, showsScreenDate, useSendFilters, usesScreenDate,
} from '@/features/team-whatsapp/use-send-filters';

const route = createFileRoute('/_authenticated/whatsapp-equipe/')({
  validateSearch: validateSendSearch,
  component: TeamWhatsappPage,
});
export { route as Route };

const FORBIDDEN_TEXT = 'Só o administrador e o gestor do setor enviam mensagens para a equipe.';
const NO_SEND_PERMISSION_TEXT = 'Você não tem permissão para enviar WhatsApp à equipe.';

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
  const canSend = usePermission('equipe.enviar');
  return (
    <div className="space-y-6">
      <PageHeader />
      {targets.isLoading && <Skeleton className="h-40 w-full" />}
      {targets.isError && <TargetsError error={targets.error} onRetry={targets.refetch} />}
      {targets.data && (
        <>
          {canSend ? (
            <SendSection targets={targets.data} />
          ) : (
            <p className="rounded-md border p-6 text-sm text-muted-foreground">{NO_SEND_PERMISSION_TEXT}</p>
          )}
          <ScheduledSection />
          <RecentSection />
        </>
      )}
    </div>
  );
}

const TOO_MANY_PEOPLE = 'team_whatsapp.too_many_people';
const INVALID_SELECTION = 'team_whatsapp.invalid_selection';
const NO_SECTORS_TEXT = 'Nenhum setor ativo para envio. Cadastre setores em Setores.';
const NEEDS_CHOICE_TEXT = 'Escolha o setor, a data e o turno';
const NEEDS_ACTIVITY_DATE_TEXT = 'Escolha o setor e o turno e informe a data da atividade';
const LIST_CHANGED_TEXT = 'A lista mudou. Marque as pessoas de novo.';

type Filters = ReturnType<typeof useSendFilters>;

function SendSection({ targets }: { targets: TeamTargets }) {
  const filters = useSendFilters(targets.today, targets.sectors, initialSendFilters(route.useSearch(), targets.sectors));
  // O texto mora aqui (DG12): fechar o diálogo não o perde; sair da página perde.
  const draft = useMessageDraft(filters.purpose, filters.activity);
  if (targets.sectors.length === 0) {
    return <p className="rounded-md border p-6 text-sm text-muted-foreground">{NO_SECTORS_TEXT}</p>;
  }
  const { sectorIds, shiftIds, date, purpose } = filters;
  const { inProgress } = targets;
  // A data de referência (GF4) é a que a prévia e o envio usam; a da tela só vale sem atividade.
  const reference = referenceDate(filters);
  const ready = sectorIds.length > 0 && filters.shiftsPicked && reference !== '';
  return (
    <section className="space-y-4">
      <PurposeFields filters={filters} />
      {inProgress && usesScreenDate(purpose) && (
        <InProgressNotice
          inProgress={inProgress}
          current={{ date, shiftIds }}
          onView={() => filters.viewShift(inProgress.date, inProgress.shift.id)}
        />
      )}
      <SectorShiftPicker
        sectors={targets.sectors} levels={targets.levels} shifts={targets.shifts}
        sectorIds={sectorIds} levelIds={filters.levelIds} withoutLevel={filters.withoutLevel}
        date={date} showDate={showsScreenDate(filters)} shiftIds={shiftIds} shiftsPicked={filters.shiftsPicked}
        onSectorsChange={filters.pickSectors} onLevelsChange={filters.pickLevels}
        onDateChange={filters.pickDate} onShiftsChange={filters.pickShifts}
      />
      {ready ? (
        <AudienceSection targets={targets} filters={filters} reference={reference} draft={draft} />
      ) : (
        <p className="rounded-md border p-6 text-sm text-muted-foreground">
          {reference === '' && !usesScreenDate(purpose) ? NEEDS_ACTIVITY_DATE_TEXT : NEEDS_CHOICE_TEXT}
        </p>
      )}
    </section>
  );
}

/**
 * `code` do corpo do erro da API, lido de forma assíncrona; vazio enquanto não lê ou sem erro. `onCode` (estável)
 * recebe o código assim que ele é lido.
 */
function useErrorCode(error: unknown, onCode: (code: string | undefined) => void): string | undefined {
  const [read, setRead] = useState<{ error: unknown; code: string | undefined } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (error) {
      void apiErrorCode(error).then((code) => {
        if (cancelled) return;
        setRead({ error, code });
        onCode(code);
      });
    }
    return () => { cancelled = true; };
  }, [error, onCode]);
  return error && read?.error === error ? read.code : undefined;
}

/**
 * Erro da prévia: o 422 `too_many_people` diz para escolher menos setores (GC11); os demais ficam com
 * o texto do servidor (o 403 também, como hoje). Sempre com `Tentar novamente` (D14).
 */
function PreviewError({ error, code, onRetry }: { error: unknown; code: string | undefined; onRetry: () => void }) {
  const shown = useMemo(() => (code === TOO_MANY_PEOPLE ? new Error(teamErrorMessage(code)) : error), [code, error]);
  return <QueryErrorFallback error={shown} onRetry={onRetry} />;
}

type AudienceProps = {
  targets: TeamTargets;
  filters: Filters;
  /** Data de referência: a da escala que o GET roster lê. */
  reference: string;
  draft: MessageDraft;
};

/**
 * O público vem da prévia do servidor (F1): "Vão receber" e "Ficam de fora" mudam quando os filtros ou a seleção
 * mudam. O GET roster fica só para o número da área, o estado do número e o início dos turnos (`shiftStarts`).
 * Marcado que perdeu a relação com o setor (422 `invalid_selection`): limpa a seleção, avisa e pede a prévia de novo.
 */
function AudienceSection({ targets, filters, reference, draft }: AudienceProps) {
  const audience = useDebouncedAudience(filters);
  const roster = useTeamRoster(filters.sectorIds, reference);
  const [listChanged, setListChanged] = useState(false);
  const { setSelected } = filters;
  const clearIfInvalid = useCallback((errorCode: string | undefined) => {
    if (errorCode !== INVALID_SELECTION) return;
    setSelected(new Set());
    setListChanged(true);
  }, [setSelected]);
  const code = useErrorCode(audience.error, clearIfInvalid);
  const { preview, error } = audience;
  return (
    <div className="space-y-3">
      {listChanged && (
        <Alert><AlertDescription>{LIST_CHANGED_TEXT}</AlertDescription></Alert>
      )}
      {preview && (
        <AudienceList
          preview={preview} isFresh={audience.isFresh} filters={filters} shiftStarts={roster.data?.shiftStarts ?? []}
          targets={targets} draft={draft} onMarked={() => setListChanged(false)}
        />
      )}
      {!preview && error && code !== INVALID_SELECTION && (
        <PreviewError error={error} code={code} onRetry={() => audience.refetch()} />
      )}
      {!preview && !error && <Skeleton className="h-40 w-full" />}
    </div>
  );
}

type ListProps = {
  preview: TeamAudiencePreview;
  isFresh: boolean;
  filters: Filters;
  shiftStarts: TeamRoster['shiftStarts'];
  targets: TeamTargets;
  draft: MessageDraft;
  onMarked: () => void;
};

/** Anexa o início do turno (ISO do servidor + hora gravada) para o diálogo habilitar o agendamento. */
function withShiftStart(shiftStarts: TeamRoster['shiftStarts'], targets: TeamTargets, target: SendTarget): SendTarget {
  if (target.type !== 'sector' || target.shiftIds.length !== 1) return target;
  const [shiftId] = target.shiftIds;
  const startsAt = shiftStarts.find((s) => s.shiftId === shiftId)?.startsAt;
  const startTime = targets.shifts.find((s) => s.id === shiftId)?.startTime;
  return startsAt && startTime ? { ...target, shiftStart: { startsAt, startTime } } : target;
}

/**
 * A lista e o diálogo de envio. O diálogo recebe a prévia que a tela mostra (a viva) e `isFresh`: só libera o envio
 * com a prévia do corpo atual e manda o `audienceKey` dela (F1, C4). O 409 fecha o diálogo e relê a prévia.
 */
function AudienceList({ preview, isFresh, filters, shiftStarts, targets, draft, onMarked }: ListProps) {
  const { selected } = filters;
  // O estado guarda o alvo do clique, sem `shiftStart`: o roster pode chegar depois de o diálogo abrir.
  const [clicked, setTarget] = useState<SendTarget | null>(null);
  const target = clicked && withShiftStart(shiftStarts, targets, clicked);
  // Os ids marcados são os mesmos que foram na prévia: o que o operador confere é o que o diálogo leva.
  const build = (selectedIds: string[]) => buildSectorTarget({ preview, sectorIds: filters.sectorIds, selectedIds });
  return (
    <>
      <MemberSelection
        preview={preview}
        isFresh={isFresh}
        selected={selected}
        onToggle={(id) => { onMarked(); filters.toggle(id); }}
        onToggleAll={() => { onMarked(); filters.setSelected(toggleAllMarkable(markableIds(preview), selected)); }}
        onSendAll={() => setTarget(build([]))}
        onSendSelected={() => setTarget(build([...selected].sort()))}
      />
      {target?.type === 'sector' && (
        <SendWhatsappDialog
          open target={target} audience={{ preview, isFresh }} draft={draft}
          moment={{ value: filters.moment, onChange: filters.setMoment, today: targets.today }}
          onOpenChange={(open) => { if (!open) { setTarget(null); filters.setMoment(NOW_MOMENT); } }}
        />
      )}
    </>
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
  return <RecentHistory />;
}
