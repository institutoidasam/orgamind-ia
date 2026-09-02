import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../shared/errors/domain.error';

export class ContactNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('Contact', id);
  }
}

export class ContactPhoneConflictError extends ConflictError {
  constructor(phoneE164: string) {
    super(
      `Contact with phone ${phoneE164} already exists`,
      'contact.phone_conflict',
    );
  }
}

export class InvalidPhoneError extends ValidationError {
  constructor(raw: string) {
    super(
      'Telefone inválido',
      `"${raw}" não é um telefone válido (use formato E.164 ou DDD brasileiro)`,
      'contact.invalid_phone',
    );
  }
}

/**
 * Round 1 (pré-revisão, B.3) — a confirmação "digite N para apagar" só vale
 * alguma coisa se o servidor recusa quando N não bate mais com a contagem
 * viva no banco: sinal de que a lista mudou (outra sincronização, outro
 * operador) entre a tela e o clique. Sem esta checagem, uma tela desatualizada
 * apagaria mais — ou menos — do que o operador viu e confirmou.
 */
export class ContactBulkDeleteCountMismatchError extends ConflictError {
  constructor(liveCount: number, expectedCount: number) {
    super(
      `A lista mudou: agora são ${liveCount} contatos inválidos, e você confirmou ${expectedCount}. ` +
        'Atualize a página e confirme de novo.',
      'contact.bulk_delete_count_mismatch',
    );
  }
}

/**
 * Os três motivos pelos quais a VALIDAÇÃO ATIVA (B.5) se recusa a rodar. Cada
 * um vira uma frase que o operador entende — e não um job que morre em
 * silêncio, que é o que acontecia com a trava "só EVOLUTION".
 */
export class SyncNotSupportedError extends DomainError {
  constructor(detail: string) {
    super({
      code: 'contact.sync_not_supported',
      // Fix round 1 (revisão pós-commit): 409, não 501 — a ausência de canal
      // capaz é um estado da CONFIGURAÇÃO atual (o operador pode corrigi-la
      // agora, ativando/conectando um canal), não uma funcionalidade que o
      // servidor nunca terá. E a mensagem não nomeia mais um provedor
      // específico (Evolution/GoZap): a capacidade é de QUALQUER adapter que
      // implemente checkNumbersOnWhatsapp, hoje ou no futuro.
      message: 'Nenhum canal ativo consegue verificar números no WhatsApp.',
      status: 409,
      detail,
    });
  }
}

export class ChannelOfflineForSyncError extends DomainError {
  constructor(channelId: string) {
    super({
      code: 'contact.sync_channel_offline',
      // Fix round 2 (revisão pós-commit, minor) — ANTES interpolava
      // `channel.name`, que é um rótulo digitado LIVREMENTE pelo operador ao
      // criar o canal (sem validação): em produção alguns operadores digitam
      // o próprio número de telefone ali — é o jeito mais natural de
      // identificar "qual número é esse". Essa mensagem volta para a tela e
      // pode acabar em log/Sentry ([[picoa-pii-em-log-e-sentry]]), então PII
      // não pode passar por ela. O id do canal é opaco (cuid) — nunca um
      // telefone.
      message: `O canal (id ${channelId}) está desconectado. A validação de números só roda com o canal online — reconecte o QR e peça de novo.`,
      status: 409,
    });
  }
}

export class SyncOutsideSendWindowError extends DomainError {
  constructor(startHour: number, endHour: number) {
    const pad = (h: number) => String(h).padStart(2, '0');
    super({
      code: 'contact.sync_outside_window',
      message: `Fora da janela de envio do canal (${pad(startHour)}h–${pad(endHour)}h). A validação de números respeita o mesmo horário do disparo: consulta em massa fora do expediente é um sinal de robô.`,
      status: 409,
    });
  }
}
