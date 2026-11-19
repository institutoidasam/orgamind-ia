import type {
  ContactAuthorizationSource,
  ContactAuthorizationStatus,
  Prisma,
} from '@prisma/client';
import { escapeLike } from '../../shared/prisma/escape-like';

/** Filtro da listagem de `GET /users`; tudo ausente (ou `status: 'all'`) = todos. */
export type UserListFilters = {
  hasAccess?: boolean;
  /** Nome ou matrícula; aparado. */
  q?: string;
  status?: 'active' | 'inactive' | 'all';
  authorization?: 'UNVERIFIED' | 'NOT_AUTHORIZED';
};

/**
 * "Origem não verificada" = autorizada só pelo cadastro anterior à ficha;
 * "Sem autorização" = não autorizada, de qualquer origem. A mesma definição
 * alimenta o filtro e os contadores.
 */
const AUTHORIZATION_WHERE = {
  UNVERIFIED: {
    contactAuthorization: 'AUTORIZADO',
    authorizationSource: 'CADASTRO_ANTERIOR',
  },
  NOT_AUTHORIZED: { contactAuthorization: 'NAO_AUTORIZADO' },
} as const satisfies Record<
  NonNullable<UserListFilters['authorization']>,
  Prisma.UserWhereInput
>;

/**
 * `where` da lista: pura, só combina as condições presentes. A matrícula é
 * procurada pela chave em minúsculas (`registrationKey`), então a busca não
 * diferencia caixa.
 */
export function userListWhere(filters: UserListFilters): Prisma.UserWhereInput {
  const q = filters.q?.trim();
  const text = q ? escapeLike(q) : '';
  return {
    ...(filters.hasAccess === undefined
      ? {}
      : { hasAccess: filters.hasAccess }),
    ...(filters.status === 'active' ? { isActive: true } : {}),
    ...(filters.status === 'inactive' ? { isActive: false } : {}),
    ...(filters.authorization
      ? AUTHORIZATION_WHERE[filters.authorization]
      : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: text, mode: 'insensitive' } },
            { registrationKey: { contains: text.toLowerCase() } },
          ],
        }
      : {}),
  };
}

export type AuthorizationGroup = {
  contactAuthorization: ContactAuthorizationStatus;
  authorizationSource: ContactAuthorizationSource | null;
  _count: { _all: number };
};

/** Dobra os grupos (autorização × origem) nos dois contadores da lista. */
export function foldAuthorizationCounts(groups: AuthorizationGroup[]): {
  unverified: number;
  notAuthorized: number;
} {
  const counts = { unverified: 0, notAuthorized: 0 };
  for (const group of groups) {
    const n = group._count._all;
    if (group.contactAuthorization === 'NAO_AUTORIZADO') {
      counts.notAuthorized += n;
    } else if (group.authorizationSource === 'CADASTRO_ANTERIOR') {
      counts.unverified += n;
    }
  }
  return counts;
}
