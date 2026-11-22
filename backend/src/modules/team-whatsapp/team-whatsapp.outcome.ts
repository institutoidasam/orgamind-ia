import type { TeamWhatsappRecipientStatus } from '@prisma/client';

/** Código de "pode ter saído": a Message ficou SENDING ou o provedor não respondeu. */
export const INDETERMINATE_CODE = 'team_whatsapp.indeterminate';

/**
 * Falhas que repetir não resolve: o número da pessoa não está no WhatsApp ou é
 * inválido, ou a Message sumiu. As demais (número desconectado, canal
 * indisponível, erro do provedor que prova que nada saiu) podem ser repetidas.
 */
export const NOT_REPEATABLE_CODES: ReadonlySet<string> = new Set([
  'evolution.number_not_on_whatsapp',
  'gozap.not_on_whatsapp',
  'gozap.invalid_recipient',
  'team_whatsapp.message_missing',
]);

/**
 * Status final de um envio que não saiu (D5): "situação incerta" quando pode
 * ter saído (código indeterminado ou que o chat nunca reenvia), "falha" quando
 * nada saiu. `redispatchable` é o `ChatService.isRedispatchableFailure`.
 */
export function failureStatus(
  code: string,
  redispatchable: (code: string) => boolean,
): 'FAILED' | 'UNCERTAIN' {
  return code === INDETERMINATE_CODE || !redispatchable(code)
    ? 'UNCERTAIN'
    : 'FAILED';
}

/** "Repetir" só vale para falha com código que não seja de timeout nem de número inválido (C4). */
export function isRepeatable(
  status: TeamWhatsappRecipientStatus,
  errorCode: string | null,
): boolean {
  return (
    status === 'FAILED' &&
    errorCode !== null &&
    !NOT_REPEATABLE_CODES.has(errorCode) &&
    !errorCode.endsWith('.timeout')
  );
}
