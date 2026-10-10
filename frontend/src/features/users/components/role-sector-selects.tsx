import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLE_LABEL, type UserRole } from "../role";

type Sector = { id: string; name: string };

export function RoleSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: UserRole;
  onChange: (role: UserRole) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>Perfil</Label>
      <Select value={value} onValueChange={(role) => onChange(role as UserRole)} disabled={disabled}>
        <SelectTrigger aria-label="Perfil"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Object.entries(ROLE_LABEL).map(([role, label]) => (
            <SelectItem key={role} value={role}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function SectorSelect({
  value,
  onChange,
  sectors,
  disabled = false,
}: {
  value: string | null;
  onChange: (sectorId: string | null) => void;
  sectors: Sector[];
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>Setor principal</Label>
      <Select value={value ?? "none"} onValueChange={(id) => onChange(id === "none" ? null : id)} disabled={disabled}>
        <SelectTrigger aria-label="Setor principal"><SelectValue placeholder="Selecione o setor" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Sem setor</SelectItem>
          {sectors.map((sector) => <SelectItem key={sector.id} value={sector.id}>{sector.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
