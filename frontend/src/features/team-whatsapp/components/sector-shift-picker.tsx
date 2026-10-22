import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ALL_SHIFTS, type ShiftChoice } from '../member-filter';
import type { TeamLevel, TeamSector, TeamTargets } from '../schemas';

type Props = {
  sectors: TeamSector[];
  levels: TeamLevel[];
  shifts: TeamTargets['shifts'];
  sectorIds: string[];
  levelIds: string[];
  withoutLevel: boolean;
  date: string;
  choice: ShiftChoice | null;
  onSectorsChange: (ids: string[]) => void;
  onLevelsChange: (levelIds: string[], withoutLevel: boolean) => void;
  onDateChange: (date: string) => void;
  onChoiceChange: (choice: ShiftChoice) => void;
};

type OptionProps = { id: string; label: string; checked: boolean; onChange: (on: boolean) => void };

function CheckOption({ id, label, checked, onChange }: OptionProps) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

function SectorChoice({ sectors, sectorIds, onChange }: Pick<Props, 'sectors' | 'sectorIds'> & { onChange: Props['onSectorsChange'] }) {
  const allOn = sectors.every((s) => sectorIds.includes(s.id));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(sectorIds);
    if (on) next.add(id);
    else next.delete(id);
    onChange(sectors.filter((s) => next.has(s.id)).map((s) => s.id));
  };
  return (
    <div role="group" aria-label="Setores" className="space-y-1">
      <p className="text-sm font-medium">Setores</p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {sectors.length > 1 && (
          <CheckOption
            id="team-whatsapp-sector-all" label="Todos os setores" checked={allOn}
            onChange={(on) => onChange(on ? sectors.map((s) => s.id) : [])}
          />
        )}
        {sectors.map((s) => (
          <CheckOption
            key={s.id} id={`team-whatsapp-sector-${s.id}`} label={s.name} checked={sectorIds.includes(s.id)}
            onChange={(on) => toggle(s.id, on)}
          />
        ))}
      </div>
    </div>
  );
}

type LevelChoiceProps = Pick<Props, 'levels' | 'levelIds' | 'withoutLevel' | 'onLevelsChange'>;

/** Sem nível cadastrado não há o que filtrar: a tela fica como era. Nada marcado = todos. */
function LevelChoice({ levels, levelIds, withoutLevel, onLevelsChange }: LevelChoiceProps) {
  if (levels.length === 0) return null;
  const toggle = (id: string, on: boolean) =>
    onLevelsChange(on ? [...levelIds, id] : levelIds.filter((l) => l !== id), withoutLevel);
  return (
    <div role="group" aria-label="Níveis" className="space-y-1">
      <p className="text-sm font-medium">Níveis</p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {levels.map((l) => (
          <CheckOption
            key={l.id} id={`team-whatsapp-level-${l.id}`} label={l.name} checked={levelIds.includes(l.id)}
            onChange={(on) => toggle(l.id, on)}
          />
        ))}
        <CheckOption
          id="team-whatsapp-level-none" label="Sem nível" checked={withoutLevel}
          onChange={(on) => onLevelsChange(levelIds, on)}
        />
      </div>
    </div>
  );
}

export function SectorShiftPicker(props: Props) {
  const { sectors, shifts, date, choice, onDateChange, onChoiceChange } = props;
  return (
    <div className="space-y-3">
      <SectorChoice sectors={sectors} sectorIds={props.sectorIds} onChange={props.onSectorsChange} />
      <LevelChoice
        levels={props.levels} levelIds={props.levelIds} withoutLevel={props.withoutLevel}
        onLevelsChange={props.onLevelsChange}
      />
      <div className="grid gap-3 sm:grid-cols-2">
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
    </div>
  );
}
