import { DomainError } from '../../shared/errors/domain.error';

/** Usuário do sistema envolvido num 409 (C3): só id e nome, nunca pessoa da equipe. */
export type HandlerRef = { id: string; name: string };

/**
 * `detail` dos 409 (DK15): `{ handler: { id, name } | null }`. Copia só `id` e
 * `name`, para que um objeto maior (ator, usuário) nunca vaze campo extra.
 * Nome vazio vira `handler: null` (o front mostra "Outra pessoa").
 */
export function handlerDetail(ref: HandlerRef | null): string {
  return JSON.stringify({
    handler: ref === null || !ref.name ? null : { id: ref.id, name: ref.name },
  });
}

export function pendencyNotFound(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.pendency_not_found',
    message: 'Pendência não encontrada.',
    status: 404,
  });
}

/** Transferir, Registrar contato, Encerrar e Reabrir: só o responsável ou o ADMIN. */
export function notHandler(): DomainError {
  return new DomainError({
    code: 'team_whatsapp.not_handler',
    message: 'Só o responsável ou um administrador pode fazer isso.',
    status: 403,
  });
}

/** Assumir sobre um responsável que já mudou: `current` é quem assumiu antes. */
export function pendencyTaken(current: HandlerRef): DomainError {
  return new DomainError({
    code: 'team_whatsapp.pendency_taken',
    message: 'Outra pessoa já assumiu esta pendência.',
    status: 409,
    detail: handlerDetail(current),
  });
}

/** A linha já não é a que a tela mostrava; `current` é o responsável de agora. */
export function pendencyChanged(current: HandlerRef | null): DomainError {
  return new DomainError({
    code: 'team_whatsapp.pendency_changed',
    message: 'Esta pendência mudou. Atualize a lista.',
    status: 409,
    detail: handlerDetail(current),
  });
}
