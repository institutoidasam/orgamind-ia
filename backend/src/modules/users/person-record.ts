import {
  Prisma,
  type ContactAuthorizationSource,
  type ContactAuthorizationStatus,
  type User,
} from '@prisma/client';
import type {
  ContactAuthorization,
  ContactAuthorizationInput,
} from '../../schemas/contracts/contact-authorization.schema';
import { fromDbDate, todayIn, toDbDate } from '../staff-schedule/civil-date';
import { authorizationFutureDate, registrationTaken } from './users.errors';

/**
 * Matrícula (D1): `registration` como digitada (aparada) e `registrationKey` em
 * minúsculas, só para unicidade e busca. Vazio grava nulo nos dois.
 */
export function normalizeRegistration(raw: string | null | undefined): {
  registration: string | null;
  registrationKey: string | null;
} {
  const registration = raw?.trim() || null;
  return { registration, registrationKey: registration?.toLowerCase() ?? null };
}

export type AuthorizationRow = Pick<
  User,
  | 'contactAuthorization'
  | 'authorizationSource'
  | 'authorizationNote'
  | 'authorizationDate'
  | 'authorizationRecordedAt'
>;

export type AuthorizationColumns = Pick<
  Prisma.UserUncheckedCreateInput,
  | 'contactAuthorization'
  | 'authorizationSource'
  | 'authorizationNote'
  | 'authorizationDate'
  | 'authorizationRecordedById'
  | 'authorizationRecordedAt'
>;

/** A autorização pedida já resolvida (data efetiva, sem enum cru de entrada). */
type RequestedAuthorization = {
  status: ContactAuthorizationStatus;
  source: ContactAuthorizationSource | null;
  note: string | null;
  date: string | null;
};

function requestedAuthorization(
  input: ContactAuthorizationInput | undefined,
  now: Date,
): RequestedAuthorization {
  if (!input || input.status === 'NAO_AUTORIZADO') {
    return { status: 'NAO_AUTORIZADO', source: null, note: null, date: null };
  }
  const today = todayIn(now);
  const date = input.date ?? today;
  if (date > today) throw authorizationFutureDate();
  return {
    status: 'AUTORIZADO',
    source: input.source,
    // Só a origem "Outro" tem texto: nas demais a nota enviada é descartada.
    note: input.source === 'OUTRO' ? input.note?.trim() || null : null,
    date,
  };
}

function sameAuthorization(
  current: AuthorizationRow,
  wanted: RequestedAuthorization,
): boolean {
  const currentDate = current.authorizationDate
    ? fromDbDate(current.authorizationDate)
    : null;
  return (
    current.contactAuthorization === wanted.status &&
    current.authorizationSource === wanted.source &&
    current.authorizationNote === wanted.note &&
    currentDate === wanted.date
  );
}

/**
 * Colunas de autorização a gravar (A2/R1). Criação (sem `current`): sem o
 * campo nasce `NAO_AUTORIZADO`; `AUTORIZADO` sem data usa hoje no fuso do app e
 * data futura é recusada. Edição (com `current`): sem o campo, ou com status,
 * origem, nota e data efetiva iguais aos atuais, devolve `{}` (D17): regravar
 * `RecordedAt`/`RecordedById` seria mudança sem trilha. `CADASTRO_ANTERIOR`
 * nunca sai daqui: só a migração o grava.
 */
export function authorizationColumns(
  input: ContactAuthorizationInput | undefined,
  actorId: string,
  now: Date,
  current?: AuthorizationRow,
): Partial<AuthorizationColumns> {
  if (current && !input) return {};
  const wanted = requestedAuthorization(input, now);
  if (current && sameAuthorization(current, wanted)) return {};
  return {
    contactAuthorization: wanted.status,
    authorizationSource: wanted.source,
    authorizationNote: wanted.note,
    authorizationDate: wanted.date ? toDbDate(wanted.date) : null,
    authorizationRecordedById: actorId,
    authorizationRecordedAt: now,
  };
}

export function toContactAuthorization(
  row: AuthorizationRow,
): ContactAuthorization {
  return {
    status: row.contactAuthorization,
    source: row.authorizationSource,
    note: row.authorizationNote,
    date: row.authorizationDate ? fromDbDate(row.authorizationDate) : null,
    recordedAt: row.authorizationRecordedAt?.toISOString() ?? null,
  };
}

/**
 * P2002 na chave da matrícula = outro cadastro ficou com ela entre a checagem e
 * a gravação → 422 `user.registration_taken`. Qualquer outro erro sobe como veio.
 */
export function rethrowRegistrationConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    /registrationKey/.test(JSON.stringify(error.meta?.target ?? null))
  ) {
    throw registrationTaken();
  }
  throw error;
}
