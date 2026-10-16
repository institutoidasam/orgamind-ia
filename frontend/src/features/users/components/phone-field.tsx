import type { UseFormRegisterReturn } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = { id: string; registration: UseFormRegisterReturn; error?: string };

export function PhoneField({ id, registration, error }: Props) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Telefone (WhatsApp)</Label>
      <Input
        id={id}
        type="tel"
        autoComplete="tel"
        placeholder="(92) 99999-9999"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...registration}
      />
      {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
