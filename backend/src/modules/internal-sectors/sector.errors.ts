import { DomainError } from '../../shared/errors/domain.error';
import { usageDetail } from '../../shared/errors/usage-detail';
import type { SectorUsage } from './sector-usage';

/**
 * Setor em uso não é inativado (E2): 409 com o `detail` só de tipo e contagem
 * (`people=3, exceptions=1, scheduled=2`), sem dado pessoal. `inactivePeople`
 * é só informação e fica de fora.
 */
export function sectorInUse({
  people,
  exceptions,
  scheduled,
}: SectorUsage): DomainError {
  return new DomainError({
    code: 'sector.in_use',
    message: 'Setor em uso não pode ser inativado',
    status: 409,
    detail: usageDetail({ people, exceptions, scheduled }),
  });
}
