import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { daysBetween, formatDayMonth, isoWeekday } from '@/lib/civil-date';
import { cn } from '@/lib/utils';
import { cellLabel } from '../board-cells';
import type { BoardRow, ScheduleBoard } from '../schemas';
import type { ExceptionTarget } from './exception-dialog';
import type { ScheduleTarget } from './schedule-editor-dialog';

type Props = {
  board: ScheduleBoard;
  onSelect: (target: ExceptionTarget) => void;
  onEditSchedule: (target: ScheduleTarget) => void;
};

const WEEKDAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];

export function ScheduleBoardTable({ board, onSelect, onEditSchedule }: Props) {
  const lookups = {
    shiftNames: new Map(board.shifts.map((shift) => [shift.id, shift.name])),
    sectorNames: new Map(board.sectors.map((sector) => [sector.id, sector.name])),
  };
  const firstOutside = board.rows.findIndex((row) => row.fromOtherSector);
  return (
    <div className="rounded-lg border">
      <Table>
        <BoardHeader board={board} />
        <TableBody>
          {board.rows.map((row, index) => (
            <PersonRow
              key={row.userId}
              row={row}
              board={board}
              lookups={lookups}
              separated={index === firstOutside && index > 0}
              onSelect={onSelect}
              onEditSchedule={onEditSchedule}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BoardHeader({ board }: { board: ScheduleBoard }) {
  const dates = daysBetween(board.from, board.to);
  return (
    <TableHeader>
      <TableRow>
        <TableHead>Pessoa</TableHead>
        {dates.map((date) => (
          <TableHead key={date} className={cn('text-center', date === board.today && 'text-primary')}>
            <span className="block text-xs font-normal uppercase">{WEEKDAYS[isoWeekday(date) - 1]}</span>
            {formatDayMonth(date)}
          </TableHead>
        ))}
        <TableHead><span className="sr-only">Ações</span></TableHead>
      </TableRow>
    </TableHeader>
  );
}

type Lookups = { shiftNames: ReadonlyMap<string, string>; sectorNames: ReadonlyMap<string, string> };
type RowProps = {
  row: BoardRow;
  board: ScheduleBoard;
  lookups: Lookups;
  separated: boolean;
  onSelect: Props['onSelect'];
  onEditSchedule: Props['onEditSchedule'];
};

function PersonRow({ row, board, lookups, separated, onSelect, onEditSchedule }: RowProps) {
  return (
    <TableRow className={cn(separated && 'border-t-2')}>
      <TableCell>
        <span className="font-medium">{row.name}</span>
        {row.jobTitle && <p className="text-xs text-muted-foreground">{row.jobTitle}</p>}
        {row.fromOtherSector && <Badge variant="outline">de outro setor</Badge>}
      </TableCell>
      {row.days.map((day) => {
        const label = cellLabel({ situation: day.situation, sectorId: board.sectorId, ...lookups });
        return (
          <TableCell key={day.date} className={cn('p-1 text-center', day.exceptionId && 'bg-muted')}>
            <DayCell
              label={label}
              editable={row.canEdit}
              ariaLabel={`${row.name}, ${formatDayMonth(day.date)}: ${label || 'sem escala'}`}
              onClick={() =>
                onSelect({ userId: row.userId, name: row.name, date: day.date, exceptionId: day.exceptionId })
              }
            />
          </TableCell>
        );
      })}
      <TableCell className="text-right">
        {row.canEdit && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onEditSchedule({ userId: row.userId, name: row.name, schedule: row.schedule })}
          >
            Editar escala
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

type CellProps = { label: string; editable: boolean; ariaLabel: string; onClick: () => void };

/** Célula: botão só para quem pode editar (o servidor decide de verdade, GC8). */
function DayCell({ label, editable, ariaLabel, onClick }: CellProps) {
  const classes = 'block h-8 w-full max-w-24 min-w-14 truncate rounded px-1 text-xs leading-8';
  if (!editable) {
    return <span title={label} className={classes}>{label}</span>;
  }
  return (
    <button
      type="button"
      title={label}
      aria-label={ariaLabel}
      className={cn(classes, 'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring')}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
