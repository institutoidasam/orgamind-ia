import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NO_SHIFT_LABEL, SHIFT_LABEL, type WorkShift } from "@/lib/work-shift";

// Radix não aceita value="": "Sem turno" usa o sentinela "none" (como o SectorSelect).
export function ShiftSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: WorkShift | null;
  onChange: (shift: WorkShift | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>Turno</Label>
      <Select value={value ?? "none"} onValueChange={(shift) => onChange(shift === "none" ? null : (shift as WorkShift))} disabled={disabled}>
        <SelectTrigger aria-label="Turno"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{NO_SHIFT_LABEL}</SelectItem>
          <SelectItem value="FIRST">{SHIFT_LABEL.FIRST}</SelectItem>
          <SelectItem value="SECOND">{SHIFT_LABEL.SECOND}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
