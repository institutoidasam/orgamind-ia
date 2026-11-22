import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TeamLevel, TeamSector, TeamTargets } from '../schemas';

type Props = {
  sectors: TeamSector[];
  levels: TeamLevel[];
  shifts: TeamTargets['shifts'];
  sectorIds: string[];
  levelIds: string[];
  withoutLevel: boolean;
  date: string;
  /** Turnos marcados; vazio = "Todos os turnos" (se `shiftsPicked`). */
  shiftIds: string[];
  /** Falso até o primeiro clique: nada marcado, nem "Todos os turnos". */
  shiftsPicked: boolean;
  onSectorsChange: (ids: string[]) => void;
  onLevelsChange: (levelIds: string[], withoutLevel: boolean) => void;
  onDateChange: (date: string) => void;
  /** `null` = desmarcou tudo (volta a não escolhido); `[]` = "Todos os turnos". */
  onShiftsChange: (shiftIds: string[] | null) => void;
};

const BOARD_FILTER_HINT = 'Os filtros do quadro da escala não mudam quem recebe: o envio usa só as escolhas abaixo.';

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

type ShiftChoiceProps = Pick<Props, 'shifts' | 'shiftIds' | 'shiftsPicked'> & { onChange: Props['onShiftsChange'] };

/** Vários turnos ou "Todos os turnos" (lista vazia); folga só vale com todos (D9). */
function ShiftChoice({ shifts, shiftIds, shiftsPicked, onChange }: ShiftChoiceProps) {
  const toggle = (id: string, on: boolean) => {
    const next = shifts.filter((s) => (s.id === id ? on : shiftIds.includes(s.id))).map((s) => s.id);
    onChange(next.length > 0 ? next : null);
  };
  return (
    <div role="group" aria-label="Turnos" className="space-y-1">
      <p className="text-sm font-medium">Turnos</p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <CheckOption
          id="team-whatsapp-shift-all" label="Todos os turnos" checked={shiftsPicked && shiftIds.length === 0}
          onChange={(on) => onChange(on ? [] : null)}
        />
        {shifts.map((s) => (
          <CheckOption
            key={s.id} id={`team-whatsapp-shift-${s.id}`} label={s.name} checked={shiftIds.includes(s.id)}
            onChange={(on) => toggle(s.id, on)}
          />
        ))}
      </div>
    </div>
  );
}

export function SectorShiftPicker(props: Props) {
  const { sectors, date, onDateChange } = props;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{BOARD_FILTER_HINT}</p>
      <SectorChoice sectors={sectors} sectorIds={props.sectorIds} onChange={props.onSectorsChange} />
      <LevelChoice
        levels={props.levels} levelIds={props.levelIds} withoutLevel={props.withoutLevel}
        onLevelsChange={props.onLevelsChange}
      />
      <div className="space-y-1">
        <Label htmlFor="team-whatsapp-date">Data</Label>
        <Input id="team-whatsapp-date" type="date" value={date} onChange={(e) => onDateChange(e.target.value)} />
      </div>
      <ShiftChoice
        shifts={props.shifts} shiftIds={props.shiftIds} shiftsPicked={props.shiftsPicked}
        onChange={props.onShiftsChange}
      />
    </div>
  );
}
