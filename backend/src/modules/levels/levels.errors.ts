import { DomainError } from '../../shared/errors/domain.error';
import { usageDetail } from '../../shared/errors/usage-detail';

export function levelNotFound(): DomainError {
  return new DomainError({
    code: 'levels.not_found',
    message: 'Nível não encontrado',
    status: 404,
  });
}

/** Nome já usado por outro nível (comparação sem caixa, após trim). */
export function levelNameTaken(): DomainError {
  return new DomainError({
    code: 'levels.name_taken',
    message: 'Já existe um nível com esse nome',
    status: 409,
  });
}

/** Ids repetidos ou diferentes do conjunto de todos os níveis. */
export function invalidLevelOrder(): DomainError {
  return new DomainError({
    code: 'levels.invalid_order',
    message: 'A ordem deve conter cada nível exatamente uma vez',
    status: 422,
  });
}

/**
 * Nível com pessoas ativas não é desativado (E3): 409 com o `detail` só de
 * contagem (`people=2`), sem dado pessoal. Pessoa inativa não conta.
 */
export function levelInUse(activePeople: number): DomainError {
  return new DomainError({
    code: 'levels.in_use',
    message: 'Nível em uso não pode ser desativado',
    status: 409,
    detail: usageDetail({ people: activePeople }),
  });
}
