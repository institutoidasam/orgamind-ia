import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ALL_SHIFTS, type ShiftChoice } from '../member-filter';
import type { TeamSector, TeamTargets } from '../schemas';

type Props = {
  sectors: TeamSector[];
  shifts: TeamTargets['shifts'];
  sectorId: string | null;
  date: string;
  choice: ShiftChoice | null;
  onSectorChange: (id: string) => void;
  onDateChange: (date: string) => void;
  onChoiceChange: (choice: ShiftChoice) => void;
};

export function SectorShiftPicker(props: Props) {
  const { sectors, shifts, sectorId, date, choice, onSectorChange, onDateChange, onChoiceChange } = props;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
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
        <Label htmlFor="team-whatsapp-date">Data</Label>
        <Input id="team-whatsapp-date" type="date" value={date} onChange={(e) => onDateChange(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label>Turno</Label>
        <Select value={choice ?? ''} onValueChange={onChoiceChange}>
          <SelectTrigger aria-label="Turno"><SelectValue placeholder="Escolha o turno" /></SelectTrigger>
          <SelectContent>
            {shifts.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            <SelectItem value={ALL_SHIFTS}>Todos os turnos</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
