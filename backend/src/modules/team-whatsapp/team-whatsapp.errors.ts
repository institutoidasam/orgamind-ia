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

/** Número da área fechado (`close`/`connecting`) na hora do envio imediato (D7): nada é criado. */
export function channelDisconnected(): ConflictError {
  return new ConflictError(
    'Canal desconectado',
    'team_whatsapp.channel_disconnected',
  );
}

/** A porta não soube dizer o estado do número (D7): só `open` libera, então nada é criado. */
export function channelUnverified(): ConflictError {
  return new ConflictError(
    'Não foi possível conferir o número. Tente de novo',
    'team_whatsapp.channel_unverified',
  );
}

/** Área do envio sem número efetivo (D2): trava o envio inteiro (GC7); nada é criado. */
export function sectorWithoutNumber(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.sector_without_number',
    message: 'Há área sem número neste envio',
    status: 422,
  });
}

/** Alvo pessoa sem área na data (D8): sem área não há número; nada é criado. */
export function noSector(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.no_sector',
    message: 'Esta pessoa não tem área',
    status: 422,
  });
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

/** Lista do dia com mais de `DAY_PEOPLE_LIMIT` pessoas: nunca corta em silêncio (D13). */
export function tooManyPeople(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.too_many_people',
    message: 'Os setores escolhidos têm pessoas demais',
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
