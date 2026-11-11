import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { numberLabel, type SectorMove } from '../sector-moves';

type PickerProps = {
  sectors: readonly { id: string; name: string }[];
  value: readonly string[];
  loading?: boolean;
  onChange: (ids: string[]) => void;
};

/** Campo `Áreas`: um checkbox por setor ativo (padrão do `sector-shift-picker`). */
export function SectorPicker({ sectors, value, loading = false, onChange }: PickerProps) {
  const uid = useId();
  const toggle = (id: string, on: boolean) =>
    onChange(sectors.filter((s) => (s.id === id ? on : value.includes(s.id))).map((s) => s.id));
  return (
    <div role="group" aria-label="Áreas" className="space-y-1">
      <p className="text-sm font-medium">Áreas</p>
      {sectors.length === 0 ? (
        <p className="text-xs text-[var(--foreground-muted)]">
          {loading ? 'Carregando áreas…' : 'Nenhuma área ativa cadastrada.'}
        </p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {sectors.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <Checkbox
                id={`${uid}-${s.id}`}
                checked={value.includes(s.id)}
                onCheckedChange={(on) => toggle(s.id, on === true)}
              />
              <Label htmlFor={`${uid}-${s.id}`}>{s.name}</Label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type ConfirmProps = {
  moves: readonly SectorMove[];
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Área que já tem outro número: o ADMIN confirma antes de mover. `Cancelar` volta ao formulário. */
export function MoveConfirmation({ moves, pending = false, onConfirm, onCancel }: ConfirmProps) {
  return (
    <div className="space-y-3">
      <ul className="space-y-1 text-sm">
        {moves.map((m) => (
          <li key={m.sectorName}>{`${m.sectorName} sai do número ${numberLabel(m.from)} e passa para este.`}</li>
        ))}
      </ul>
      <p className="text-xs text-[var(--foreground-muted)]">Envios já agendados continuam pelo número antigo.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button type="button" onClick={onConfirm} disabled={pending}>Mover</Button>
      </div>
    </div>
  );
}
