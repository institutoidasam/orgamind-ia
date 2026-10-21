import { Button } from '@/components/ui/button';
import { formatDayMonth } from '@/lib/civil-date';
import type { TeamTargets } from '../schemas';

type Props = {
  inProgress: NonNullable<TeamTargets['inProgress']>;
  /** O que a tela está mostrando agora; o aviso some quando já é o turno em andamento. */
  current: { date: string; choice: string | null };
  onView: () => void;
};

/** Turno da véspera ainda em andamento: atalho que troca a data e o turno (sem regra escondida). */
export function InProgressNotice({ inProgress, current, onView }: Props) {
  const { date, shift } = inProgress;
  if (current.date === date && current.choice === shift.id) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
      <p>{`A ${shift.name} de ${formatDayMonth(date)} ainda está em andamento`}</p>
      <Button size="sm" variant="outline" onClick={onView}>Ver esse turno</Button>
    </div>
  );
}
