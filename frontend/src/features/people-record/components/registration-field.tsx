import { LimitedTextField, type LimitedTextFieldProps } from './limited-text-field';

/** Matrícula da pessoa: opcional, até 30 caracteres (spec A1). */
export function RegistrationField(props: LimitedTextFieldProps) {
  return <LimitedTextField label="Matrícula" maxLength={30} {...props} />;
}
