import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type LevelOption = { id: string; name: string; isActive?: boolean };

const NO_LEVEL_LABEL = "Sem nível";

/** Níveis ativos, mais o nível atual da pessoa quando ele foi desativado (marcado "(inativo)"). */
function levelOptions(levels: readonly LevelOption[], current: LevelOption | null | undefined) {
  if (!current || levels.some((level) => level.id === current.id)) return levels;
  return [...levels, current];
}

// Radix não aceita value="": "Sem nível" usa o sentinela "none" (como o ShiftSelect).
export function LevelSelect({
  value,
  onChange,
  levels,
  current = null,
  disabled = false,
}: {
  value: string | null;
  onChange: (levelId: string | null) => void;
  /** Só os ativos (useActiveLevels). */
  levels: readonly LevelOption[];
  /** Nível que a pessoa já tem; aparece mesmo inativo. */
  current?: LevelOption | null;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>Nível</Label>
      <Select value={value ?? "none"} onValueChange={(levelId) => onChange(levelId === "none" ? null : levelId)} disabled={disabled}>
        <SelectTrigger aria-label="Nível"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{NO_LEVEL_LABEL}</SelectItem>
          {levelOptions(levels, current).map((level) => (
            <SelectItem key={level.id} value={level.id}>{level.isActive === false ? `${level.name} (inativo)` : level.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
