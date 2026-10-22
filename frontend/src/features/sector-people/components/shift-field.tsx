import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Props = {
  /** '' = nenhum turno escolhido (Q3: sem pré-seleção). */
  value: string;
  onChange: (shiftId: string) => void;
  shifts: readonly { id: string; name: string }[];
};

/** Turno sem "Sem turno": obrigatório ao adicionar (sem valor inicial) e ao editar quem já tem turno. */
export function RequiredShiftSelect({ value, onChange, shifts }: Props) {
  return (
    <div className="space-y-1">
      <Label>Turno</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label="Turno"><SelectValue placeholder="Escolha o turno" /></SelectTrigger>
        <SelectContent>
          {shifts.map((shift) => (
            <SelectItem key={shift.id} value={shift.id}>{shift.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
