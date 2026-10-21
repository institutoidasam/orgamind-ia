import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SHIFT_LABEL } from '@/lib/work-shift';
import type { ShiftChoice } from '../member-filter';
import type { TeamSector } from '../schemas';

const CHOICES: { value: ShiftChoice; label: string }[] = [
  { value: 'FIRST', label: SHIFT_LABEL.FIRST },
  { value: 'SECOND', label: SHIFT_LABEL.SECOND },
  { value: 'ALL', label: 'Todos os turnos' },
];

type Props = {
  sectors: TeamSector[];
  sectorId: string | null;
  choice: ShiftChoice | null;
  onSectorChange: (id: string) => void;
  onChoiceChange: (choice: ShiftChoice) => void;
};

export function SectorShiftPicker({ sectors, sectorId, choice, onSectorChange, onChoiceChange }: Props) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label>Setor</Label>
        <Select value={sectorId ?? ''} onValueChange={onSectorChange}>
          <SelectTrigger aria-label="Setor"><SelectValue placeholder="Escolha o setor" /></SelectTrigger>
          <SelectContent>
            {sectors.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Turno</Label>
        <Select value={choice ?? ''} onValueChange={(v) => onChoiceChange(v as ShiftChoice)}>
          <SelectTrigger aria-label="Turno"><SelectValue placeholder="Escolha o turno" /></SelectTrigger>
          <SelectContent>
            {CHOICES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
