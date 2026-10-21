import {
  ConflictError,
  DomainError,
  ForbiddenError,
} from '../../shared/errors/domain.error';

/** Fora da política (remetente, alvo ou setor): 403 único, sem detalhar o motivo. */
export function teamForbidden(): ForbiddenError {
  return new ForbiddenError(
    'Fora da política de envio da equipe',
    'team_whatsapp.forbidden',
  );
}

export function noRecipients(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.no_recipients',
    message: 'Nenhum destinatário válido',
    status: 422,
  });
}

export function channelInvalid(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.channel_invalid',
    message: 'Canal inválido para recado da equipe',
    status: 422,
  });
}

export function channelDisconnected(): ConflictError {
  return new ConflictError(
    'Canal desconectado',
    'team_whatsapp.channel_disconnected',
  );
}

/** Algum `userIds` fora do setor/turno atual, inativo ou inexistente: nada é criado. */
export function invalidSelection(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.invalid_selection',
    message: 'Seleção de destinatários inválida',
    status: 422,
  });
}
