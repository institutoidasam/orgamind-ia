import { DomainError } from '../../shared/errors/domain.error';

const TOO_LARGE_CODE = 'export.too_large';
const OUT_OF_REACH_CODE = 'export.out_of_reach';
const FORBIDDEN_MESSAGE = 'Ação não permitida';

function tooLarge(detail: string): DomainError {
  return new DomainError({
    code: TOO_LARGE_CODE,
    status: 422,
    message: 'Exportação grande demais',
    detail,
  });
}

function outOfReach(detail: string): DomainError {
  return new DomainError({
    code: OUT_OF_REACH_CODE,
    status: 403,
    message: FORBIDDEN_MESSAGE,
    detail,
  });
}

function notFound(code: string, message: string): DomainError {
  return new DomainError({ code, status: 404, message, detail: `${message}.` });
}

/** D1: mais de `PEOPLE_EXPORT_ROW_CAP` linhas de pessoas. */
export function peopleTooLarge(): DomainError {
  return tooLarge(
    'Há pessoas demais para um arquivo só. Filtre por setor ou turno.',
  );
}

/**
 * D2: quadro da escala cortado (`truncated`), ou seja, mais pessoas que o
 * `BOARD_PEOPLE_LIMIT` do quadro em `staff-schedule`; não é o teto de
 * `PEOPLE_EXPORT_ROW_CAP` das pessoas.
 */
export function scheduleTooLarge(): DomainError {
  return tooLarge('Há pessoas demais neste setor para um arquivo só.');
}

/** DX12: setor pedido fora do alcance (ou inexistente) por quem não é ADMIN. */
export function sectorOutOfReach(): DomainError {
  return outOfReach('Você só pode exportar pessoas dos setores que gerencia.');
}

/** DX12: gestor sem nenhum setor. */
export function noManagedSector(): DomainError {
  return outOfReach('Você não gerencia nenhum setor.');
}

export function exportSectorNotFound(): DomainError {
  return notFound('export.sector_not_found', 'Setor não encontrado');
}

export function exportShiftNotFound(): DomainError {
  return notFound('export.shift_not_found', 'Turno não encontrado');
}
