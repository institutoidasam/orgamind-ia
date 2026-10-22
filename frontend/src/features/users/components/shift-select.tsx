import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NO_SHIFT_LABEL } from "@/features/shifts/labels";
import type { ShiftRef } from "@/features/shifts/schemas";

type ShiftOption = ShiftRef & { isActive?: boolean };

// Radix não aceita value="": "Sem turno" usa o sentinela "none" (como o SectorSelect).
export function ShiftSelect({
  value,
  onChange,
  shifts,
  disabled = false,
}: {
  value: string | null;
  onChange: (shiftId: string | null) => void;
  shifts: readonly ShiftOption[];
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>Turno</Label>
      <Select value={value ?? "none"} onValueChange={(shiftId) => onChange(shiftId === "none" ? null : shiftId)} disabled={disabled}>
        <SelectTrigger aria-label="Turno"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{NO_SHIFT_LABEL}</SelectItem>
          {shifts.filter((shift) => shift.isActive !== false || shift.id === value).map((shift) => (
            <SelectItem key={shift.id} value={shift.id}>{shift.isActive === false ? `${shift.name} (inativo)` : shift.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
