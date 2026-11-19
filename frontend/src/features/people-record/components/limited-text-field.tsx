import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type LimitedTextFieldProps = { value: string; onChange: (value: string) => void; error?: string };

/** Campo de texto com rótulo, limite de caracteres e erro acessível; base de Matrícula e Motivo. */
export function LimitedTextField({ label, maxLength, value, onChange, error }: LimitedTextFieldProps & { label: string; maxLength: number }) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
