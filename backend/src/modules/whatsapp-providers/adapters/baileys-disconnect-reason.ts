/**
 * Maps a numeric Baileys `DisconnectReason` (the `disconnectionReasonCode`
 * Evolution exposes on `/instance/fetchInstances`, and the `statusReason` on a
 * CONNECTION_UPDATE) to an operator-facing PT-BR explanation + guidance.
 *
 * Why: the connection panel used to show only "desconectado" with no reason,
 * so an operator whose number was logged out (e.g. WhatsApp anti-spam
 * enforcement after a cold bulk) had no idea WHY or what to do. This turns the
 * raw code into "what happened" + "what to do next".
 *
 * Data-driven on purpose: the table below is the single source of truth — add
 * or edit a row to change a message, no branching to touch. Codes not in the
 * table fall back to a generic (still actionable) message that echoes the code.
 */
export type DisconnectReasonInfo = {
  /** The numeric Baileys reason code this describes. */
  code: number;
  /** One-line "what happened", operator-facing PT-BR. */
  message: string;
  /** "What to do next", operator-facing PT-BR. */
  guidance: string;
};

/**
 * Numeric Baileys DisconnectReason → { message, guidance }. Values mirror the
 * Baileys enum: loggedOut=401, forbidden=403, connectionLost=408,
 * multideviceMismatch=411, connectionClosed=428, connectionReplaced=440,
 * badSession=500, unavailableService=503, restartRequired=515.
 */
const REASONS: Record<number, Omit<DisconnectReasonInfo, 'code'>> = {
  401: {
    message: 'Sessão deslogada — o WhatsApp removeu este dispositivo conectado.',
    guidance:
      'Costuma ser enforcement anti-spam por envio frio/em massa de um número novo. Reconecte apenas para uso morno (responder quem já te respondeu); para outreach frio use um provedor oficial (Twilio) com template aprovado e opt-in.',
  },
  403: {
    message: 'Conexão bloqueada pelo WhatsApp (forbidden).',
    guidance:
      'Forte sinal de banimento/enforcement. Não reconecte para enviar em massa — risco de ban permanente. Investigue antes de continuar.',
  },
  408: {
    message: 'Conexão perdida (timeout de rede).',
    guidance: 'Costuma reconectar sozinho. Se persistir, reconecte escaneando o QR.',
  },
  411: {
    message: 'Incompatibilidade multi-dispositivo.',
    guidance: 'Repareie escaneando o QR novamente.',
  },
  428: {
    message: 'Conexão fechada (instabilidade momentânea).',
    guidance: 'O sistema tenta reconectar automaticamente; normalmente nenhuma ação é necessária.',
  },
  440: {
    message: 'Outra sessão do WhatsApp Web assumiu esta conexão.',
    guidance:
      'Evite abrir o WhatsApp Web (ou outro pareamento) em paralelo com este número e reconecte pelo QR.',
  },
  500: {
    message: 'Sessão corrompida.',
    guidance: 'Use "Reiniciar" e pareie o QR novamente.',
  },
  503: {
    message: 'Serviço do WhatsApp temporariamente indisponível.',
    guidance: 'Tente reconectar em alguns minutos.',
  },
  515: {
    message: 'Reinício necessário (normal logo após parear).',
    guidance: 'Reconecta automaticamente; nenhuma ação necessária.',
  },
};

/**
 * Describe a Baileys disconnect reason code. Returns null when there is no code
 * (null/undefined) — i.e. nothing to explain — so callers can render the
 * callout only when a reason actually exists. Unknown non-null codes get a
 * generic-but-actionable fallback that echoes the raw code.
 */
export function describeDisconnectReason(
  code: number | null | undefined,
): DisconnectReasonInfo | null {
  if (code == null) return null;
  const known = REASONS[code];
  if (known) return { code, ...known };
  return {
    code,
    message: `Desconectado (motivo ${code}).`,
    guidance: 'Reconecte escaneando o QR. Se o problema repetir, verifique os logs da conexão.',
  };
}
