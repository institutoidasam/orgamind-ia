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

/** `shiftId` do alvo setor inexistente ou inativo: nada é criado. */
export function invalidShift(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.invalid_shift',
    message: 'Turno inválido',
    status: 422,
  });
}

/** Algum `userIds` fora do setor/turno atual, inativo ou inexistente: nada é criado. */
export function invalidSelection(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.invalid_selection',
    message: 'Seleção de destinatários inválida',
    status: 422,
  });
}

/** Algum `levelIds` do alvo setor inexistente ou inativo (C5): nada é criado. */
export function invalidLevel(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.invalid_level',
    message: 'Nível inválido',
    status: 422,
  });
}

/** "No início do turno" com o início (data + turno, em Manaus) agora ou no passado. */
export function scheduleInPast(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.schedule_in_past',
    message: 'O início deste turno já passou',
    status: 422,
  });
}

export function dispatchNotFound(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.dispatch_not_found',
    message: 'Envio não encontrado',
    status: 404,
  });
}

/** Cancelar envio que não está mais agendado (já disparado ou cancelado). */
export function notCancellable(): ConflictError {
  return new ConflictError(
    'Envio não está mais agendado',
    'team_whatsapp.not_cancellable',
  );
}
