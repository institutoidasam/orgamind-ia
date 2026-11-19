import { LimitedTextField, type LimitedTextFieldProps } from './limited-text-field';

/** Motivo da alteração: obrigatório, de 3 a 200 caracteres (spec A4); a validação fica em `reasonSchema`. */
export function ReasonField(props: LimitedTextFieldProps) {
  return <LimitedTextField label="Motivo da alteração" maxLength={200} {...props} />;
}
