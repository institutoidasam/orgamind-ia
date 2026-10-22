import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { HTTPError } from 'ky';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useScheduleBoard, useScheduleOptions } from '@/features/staff-schedule/api';
import { ExceptionDialog, type ExceptionTarget } from '@/features/staff-schedule/components/exception-dialog';
import { ScheduleBoardTable } from '@/features/staff-schedule/components/schedule-board';
import { ScheduleEditorDialog, type ScheduleTarget } from '@/features/staff-schedule/components/schedule-editor-dialog';
import { periodRange, stepAnchor, type PeriodMode } from '@/features/staff-schedule/period';
import type { ScheduleBoard, ScheduleOptions, SectorRef } from '@/features/staff-schedule/schemas';
import { formatDayMonth } from '@/lib/civil-date';

const route = createFileRoute('/_authenticated/escala/')({
  component: SchedulePage,
});
export { route as Route };

const FORBIDDEN_TEXT = 'Só o administrador e o gestor do setor veem a escala.';
const NO_SECTORS_TEXT = 'Nenhum setor disponível para a escala.';
const PICK_SECTOR_TEXT = 'Escolha o setor para ver a escala.';
const NO_PEOPLE_TEXT = 'Nenhuma pessoa ativa neste setor.';

function SchedulePage() {
  const options = useScheduleOptions();
  return (
    <div className="space-y-6">
      <header>
        <p className="ds-eyebrow">pessoas · equipe</p>
        <h1 className="text-2xl font-bold">Escala</h1>
        <p className="text-sm text-muted-foreground">
          Quem trabalha em cada turno, dia a dia. Clique em um dia para marcar folga, férias, troca de turno ou outro setor.
        </p>
      </header>
      {options.isLoading && <Skeleton className="h-40 w-full" />}
      {options.isError && <ScheduleError error={options.error} onRetry={options.refetch} />}
      {options.data && <ScheduleContent options={options.data} />}
    </div>
  );
}

function ScheduleError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof HTTPError && error.response.status === 403) {
    return <p className="rounded-md border p-6 text-sm text-muted-foreground">{FORBIDDEN_TEXT}</p>;
  }
  return <QueryErrorFallback error={error} onRetry={onRetry} />;
}

function ScheduleContent({ options }: { options: ScheduleOptions }) {
  const [pickedSectorId, setPickedSectorId] = useState<string | null>(null);
  const [mode, setMode] = useState<PeriodMode>('week');
  const [anchor, setAnchor] = useState(options.today);
  const [target, setTarget] = useState<ExceptionTarget | null>(null);
  const [editing, setEditing] = useState<ScheduleTarget | null>(null);
  const sectorId = pickedSectorId ?? (options.sectors.length === 1 ? options.sectors[0].id : null);
  const range = periodRange(mode, anchor);
  const board = useScheduleBoard(sectorId ? { sectorId, ...range } : null);
  if (options.sectors.length === 0) return <p className="rounded-md border p-6 text-sm text-muted-foreground">{NO_SECTORS_TEXT}</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectorField sectors={options.sectors} sectorId={sectorId} onChange={setPickedSectorId} />
        <PeriodControls
          mode={mode}
          range={range}
          onModeChange={setMode}
          onStep={(direction) => setAnchor(stepAnchor(mode, anchor, direction))}
        />
      </div>
      {sectorId === null && <p className="rounded-md border p-6 text-sm text-muted-foreground">{PICK_SECTOR_TEXT}</p>}
      {board.isLoading && <Skeleton className="h-40 w-full" />}
      {board.isError && <ScheduleError error={board.error} onRetry={board.refetch} />}
      {board.data && <BoardSection board={board.data} onSelect={setTarget} onEditSchedule={setEditing} />}
      {target && <ExceptionDialog target={target} options={options} onClose={() => setTarget(null)} />}
      <ScheduleEditorHost target={editing} options={options} onClose={() => setEditing(null)} />
    </div>
  );
}

type EditorHostProps = { target: ScheduleTarget | null; options: ScheduleOptions; onClose: () => void };

function ScheduleEditorHost({ target, options, onClose }: EditorHostProps) {
  if (!target) return null;
  return <ScheduleEditorDialog target={target} options={options} onClose={onClose} />;
}

type BoardSectionProps = {
  board: ScheduleBoard;
  onSelect: (target: ExceptionTarget) => void;
  onEditSchedule: (target: ScheduleTarget) => void;
};

function BoardSection({ board, onSelect, onEditSchedule }: BoardSectionProps) {
  if (board.rows.length === 0) {
    return <p className="rounded-md border p-6 text-sm text-muted-foreground">{NO_PEOPLE_TEXT}</p>;
  }
  return <ScheduleBoardTable board={board} onSelect={onSelect} onEditSchedule={onEditSchedule} />;
}

type SectorFieldProps = { sectors: SectorRef[]; sectorId: string | null; onChange: (id: string) => void };

function SectorField({ sectors, sectorId, onChange }: SectorFieldProps) {
  if (sectors.length === 1) {
    return <p className="text-sm font-medium">{sectors[0].name}</p>;
  }
  return (
    <div className="space-y-1">
      <Label>Setor</Label>
      <Select value={sectorId ?? ''} onValueChange={onChange}>
        <SelectTrigger aria-label="Setor" className="w-56"><SelectValue placeholder="Escolha o setor" /></SelectTrigger>
        <SelectContent>
          {sectors.map((sector) => <SelectItem key={sector.id} value={sector.id}>{sector.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

type PeriodControlsProps = {
  mode: PeriodMode;
  range: { from: string; to: string };
  onModeChange: (mode: PeriodMode) => void;
  onStep: (direction: -1 | 1) => void;
};

function PeriodControls({ mode, range, onModeChange, onStep }: PeriodControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Tabs value={mode} onValueChange={(value) => onModeChange(value as PeriodMode)}>
        <TabsList>
          <TabsTrigger value="week">Semana</TabsTrigger>
          <TabsTrigger value="month">Mês</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex items-center gap-1">
        <Button type="button" size="icon-sm" variant="outline" aria-label="Período anterior" onClick={() => onStep(-1)}>
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <span className="min-w-36 text-center text-sm">
          {`${formatDayMonth(range.from)} a ${formatDayMonth(range.to)} de ${range.to.slice(0, 4)}`}
        </span>
        <Button type="button" size="icon-sm" variant="outline" aria-label="Próximo período" onClick={() => onStep(1)}>
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
