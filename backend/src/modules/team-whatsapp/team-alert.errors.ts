import { ConflictError, DomainError } from '../../shared/errors/domain.error';

/** Erros de regra do alerta urgente (Lote I, DI14); sem dado pessoal na mensagem. */
function alertRuleError(code: string, message: string): DomainError {
  return new DomainError({
    code: `team_whatsapp.${code}`,
    message,
    status: 422,
  });
}

/** O envio não é um alerta (outra finalidade, urgência antiga ou lembrete). */
export function notAnAlert(): DomainError {
  return alertRuleError('not_an_alert', 'Este envio não é um alerta urgente.');
}

/** A pessoa já tem ciência registrada. */
export function ackExists(): DomainError {
  return alertRuleError('ack_exists', 'Esta pessoa já tem ciência registrada.');
}

/** Desfazer vale só para a ciência manual. */
export function ackNotManual(): DomainError {
  return alertRuleError(
    'ack_not_manual',
    'Só a ciência manual pode ser desfeita.',
  );
}

/** Nenhuma das pessoas pedidas está elegível ao lembrete. */
export function reminderEmpty(): DomainError {
  return alertRuleError(
    'reminder_empty',
    'Nenhuma das pessoas escolhidas está pendente. Atualize a lista.',
  );
}

/** O alerta já teve o máximo de lembretes. */
export function reminderLimit(): ConflictError {
  return new ConflictError(
    'Este alerta já teve 3 lembretes, o máximo.',
    'team_whatsapp.reminder_limit',
  );
}

/** Intervalo mínimo entre o alerta (ou o último lembrete) e o próximo lembrete. */
export function reminderTooSoon(): ConflictError {
  return new ConflictError(
    'Espere 5 minutos desde o alerta ou o último lembrete.',
    'team_whatsapp.reminder_too_soon',
  );
}
