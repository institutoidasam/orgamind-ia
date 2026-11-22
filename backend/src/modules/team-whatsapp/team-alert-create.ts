import type { TeamPurpose } from '../../schemas/contracts/team-whatsapp.schema';
import { ALERT_ACK_DEADLINE_MINUTES, alertText } from './team-alert.rules';

/**
 * Criação do alerta urgente (I2, I3; DI3, DI4): o que a Urgência grava a mais
 * que as outras finalidades. As regras puras ficam em `team-alert.rules.ts`.
 */

const isAlert = (purpose: TeamPurpose | undefined): boolean =>
  purpose === 'urgency';

/**
 * Texto gravado do envio para setor: na Urgência, o do usuário (sem aparar)
 * mais a linha em branco e a linha fixa; nas demais finalidades, o enviado.
 */
export function dispatchTextOf(input: {
  purpose?: TeamPurpose;
  text: string;
}): string {
  return isAlert(input.purpose) ? alertText(input.text) : input.text;
}

/** Prazo de ciência gravado só no alerta; as outras finalidades gravam `null`. */
export function alertFieldsOf(purpose: TeamPurpose | undefined): {
  ackDeadlineMinutes: number | null;
} {
  return {
    ackDeadlineMinutes: isAlert(purpose) ? ALERT_ACK_DEADLINE_MINUTES : null,
  };
}
