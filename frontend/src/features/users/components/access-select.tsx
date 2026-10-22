import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** "Acesso ao sistema" do cadastro: Com acesso (e-mail + perfil + senha temporária) ou Sem acesso. */
export function AccessSelect({ value, onChange }: { value: boolean; onChange: (hasAccess: boolean) => void }) {
  return (
    <div className="space-y-1">
      <Label>Acesso ao sistema</Label>
      <Select value={value ? "with" : "without"} onValueChange={(next) => onChange(next === "with")}>
        <SelectTrigger aria-label="Acesso ao sistema"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="with">Com acesso</SelectItem>
          <SelectItem value="without">Sem acesso</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
