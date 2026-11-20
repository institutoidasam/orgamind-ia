import {
  ConflictError,
  DomainError,
  ForbiddenError,
} from '../../shared/errors/domain.error';
import type { TeamAudiencePreview } from '../../schemas/contracts/team-whatsapp.schema';

/** Fora da política (remetente, alvo ou setor): 403 único, sem detalhar o motivo. */
export function teamForbidden(): ForbiddenError {
  return new ForbiddenError(
    'Fora da política de envio da equipe',
    'team_whatsapp.forbidden',
  );
}

/** Disparo amplo (B4) sem `equipe.disparo_amplo`: nada é criado, imediato ou agendado. */
export function broadSendDenied(): ForbiddenError {
  return new ForbiddenError(
    'Você não tem permissão para enviar a todos os setores de uma vez. Desmarque um setor ou peça ao administrador.',
    'team_whatsapp.broad_send_denied',
  );
}

/** Público vazio: ninguém para receber (trava `no_recipients`). */
export function noRecipients(): DomainError {
  return blocked(audienceBlock('no_recipients'));
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
  return blocked(audienceBlock('sector_without_number'));
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

/**
 * "No início do turno" com o início (data + turno, em Manaus) agora ou no
 * passado; em "data e hora" o texto é `SCHEDULE_AT_IN_PAST_TEXT` (CG4).
 */
export function scheduleInPast(): DomainError {
  return blocked(audienceBlock('schedule_in_past'));
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

/**
 * CF4: a impressão do público calculada no envio não bate com a da prévia
 * (outra pessoa, outro motivo ou outro telefone): nada é criado.
 */
export function audienceChanged(): ConflictError {
  return new ConflictError(
    'O público mudou depois da prévia. Confira de novo antes de enviar.',
    'team_whatsapp.audience_changed',
  );
}

/** Erro de regra da finalidade (DF8): 422 na prévia e no envio, antes do alcance. */
function ruleError(code: string, message: string): DomainError {
  return new DomainError({
    code: `team_whatsapp.${code}`,
    message,
    status: 422,
  });
}

/** Base diferente da fixada pela finalidade (só o Alinhamento escolhe). */
export function invalidBase(): DomainError {
  return ruleError(
    'invalid_base',
    'A base do público desta finalidade é fixa.',
  );
}

/** "Incluir folga" pedido na base em serviço. */
export function invalidOffOption(): DomainError {
  return ruleError(
    'invalid_off_option',
    'A equipe em serviço não tem a opção de incluir quem está de folga.',
  );
}

/** Momento do disparo fora dos permitidos pela finalidade. */
export function whenNotAllowed(): DomainError {
  return ruleError(
    'when_not_allowed',
    'Esta finalidade não pode ser enviada nesse momento.',
  );
}

/** Data de referência (`target.date`) diferente da data da atividade. */
export function invalidReferenceDate(): DomainError {
  return ruleError(
    'invalid_reference_date',
    'A data de referência precisa ser a data da atividade.',
  );
}

/**
 * CF4: texto de cada trava do botão, na ordem fixa em que saem (prévia: lista;
 * envio: 422 com a primeira). As chaves são os códigos sem o prefixo.
 */
export const BLOCK_TEXT = {
  empty_text: 'Escreva a mensagem.',
  // Reunião, Palestra e Hora extra; o Alinhamento usa MISSING_ACTIVITY_DATE_TIME_TEXT.
  missing_activity: 'Informe a data, a hora e o local da atividade.',
  missing_urgency_reason: 'Informe o motivo da urgência.',
  overtime_without_selection: 'Marque pelo menos uma pessoa para a hora extra.',
  // "No início do turno"; "data e hora" usa SCHEDULE_AT_IN_PAST_TEXT.
  schedule_in_past: 'O início deste turno já passou',
  // DG8: "data e hora" além de hoje (Manaus) + 30 dias.
  schedule_too_far: 'O envio pode ser agendado para até 30 dias à frente.',
  // Vale no "agora", no início do turno e em "data e hora".
  after_activity_start: 'A mensagem precisa sair antes do início da atividade.',
  // Público vazio.
  no_recipients: 'Nenhum destinatário válido',
  sector_without_number: 'Há área sem número neste envio',
} as const;

/** Alinhamento com atividade incompleta: mesmo código `missing_activity`, sem exigir o local. */
export const MISSING_ACTIVITY_DATE_TIME_TEXT =
  'Informe a data e a hora da atividade.';

/** "Data e hora" (`when: 'at'`) agora ou no passado: mesmo código `schedule_in_past` (CG4). */
export const SCHEDULE_AT_IN_PAST_TEXT = 'A data e a hora do envio já passaram.';

export type BlockCode = keyof typeof BLOCK_TEXT;

/** Trava como sai na prévia: código com o prefixo e texto (o de CF4, salvo o dado). */
export type AudienceBlock = TeamAudiencePreview['blocks'][number];

export function audienceBlock(
  code: BlockCode,
  message: string = BLOCK_TEXT[code],
): AudienceBlock {
  return { code: `team_whatsapp.${code}`, message };
}

/** Envio com trava: 422 com o código e o texto da primeira trava da lista. */
export function blocked(block: AudienceBlock): DomainError {
  return new DomainError({ ...block, status: 422 });
}
