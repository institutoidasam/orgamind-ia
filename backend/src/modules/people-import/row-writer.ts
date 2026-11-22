import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canEditContactAuthorization } from '../../shared/authz/person-actions.policy';
import { DomainError, NotFoundError } from '../../shared/errors/domain.error';
import { brazilianPhoneVariants } from '../contacts/phone.util';
import {
  type PersonWithoutAccessInput,
  type UserPatch,
  UsersService,
} from '../users/users.service';
import { type ImportActor, phoneFullFor } from './import-actor';
import type {
  CreatePlan,
  ImportPatch,
  ImportPerson,
  RowKeys,
  RowOutcome,
  RowPlan,
} from './import-person';
import { PeopleImportRepository } from './people-import.repository';
import { patchSatisfied, personFingerprint, samePhone } from './person-diff';
import { ROW_TEXT } from './row-texts';
import { type StructureCatalog, structureName } from './structure-match';

export type RowWriteInput = {
  plan: RowPlan;
  /** `ReservedRow.personId` (T13a): na criação, o id da pessoa a criar e a procurar antes. */
  personId: string | null;
  actor: ImportActor;
  /** `importReason(fileName)` (EX21): vai para a trilha da pessoa. */
  reason: string;
  catalog: StructureCatalog;
};

type CreateRow = Extract<RowPlan, { kind: 'create' }>;
type UpdateRow = Extract<RowPlan, { kind: 'update' }>;
/** Chaves procuradas de novo: o telefone só para quem tem a chave (EX17.4 b). */
type SearchKeys = { registrationKey: string | null; phone: string | null };
/** Quem cada chave da linha acha hoje. */
type KeyMatch = {
  byRegistration: ImportPerson | null;
  byPhone: ImportPerson | null;
};

/** Os únicos campos que a gravação aplica (E6: nunca mais do que a prévia mostrou). */
const PATCH_FIELDS = [
  'name',
  'phone',
  'jobTitle',
  'registration',
  'sectorId',
  'shiftId',
  'levelId',
  'contactAuthorization',
] as const satisfies readonly (keyof ImportPatch)[];

/** EX20: código do cadastro → motivo da linha. */
const CODE_REASON: ReadonlyMap<string, string> = new Map([
  ['user.phone_taken', ROW_TEXT.phoneTaken],
  ['user.registration_taken', ROW_TEXT.registrationTaken],
  ['user.sector_invalid', ROW_TEXT.structureInactive],
  ['users.invalid_shift', ROW_TEXT.structureInactive],
  ['users.invalid_level', ROW_TEXT.structureInactive],
  ['user.invalid_phone', ROW_TEXT.invalidPhone],
  ['user.authorization_future_date', ROW_TEXT.futureDate],
]);

/** Lançado pelo `UsersRepository` quando a pessoa some dentro da transação. */
const USER_NOT_FOUND = 'USER_NOT_FOUND';

const failed = (reason: string): RowOutcome => ({
  outcome: 'FAILED',
  reason,
  personId: null,
});

const settled = (
  outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED',
  personId: string,
): RowOutcome => ({ outcome, reason: null, personId });

/**
 * Grava uma linha confirmada (spec E6) pelo caminho do cadastro manual
 * (GX3): só `createPersonWithoutAccess` e `updateUser`. Cada linha é
 * conferida de novo com as permissões de agora (GX6, EX19); erro do cadastro
 * vira o motivo da linha (EX20), sem impedir as outras.
 */
@Injectable()
export class RowWriter {
  private readonly logger = new Logger(RowWriter.name);

  constructor(
    private readonly people: PeopleImportRepository,
    private readonly users: UsersService,
  ) {}

  write(input: RowWriteInput): Promise<RowOutcome> {
    const { plan } = input;
    return plan.kind === 'create'
      ? this.writeCreate(input, plan)
      : this.writeUpdate(input, plan);
  }

  /**
   * EX17.4: a pessoa criada por esta mesma linha vem antes de tudo; depois a
   * trava do setor (EX19 a), a procura pelas chaves e só então a criação.
   */
  private async writeCreate(
    input: RowWriteInput,
    plan: CreateRow,
  ): Promise<RowOutcome> {
    const { personId, actor } = input;
    if (personId === null) return this.unexpected('linha_sem_pessoa');
    if (await this.exists(personId)) return settled('UNCHANGED', personId);
    const blocked = createBlock(actor, plan.input.sectorId, input.catalog);
    if (blocked) return failed(blocked);
    const search = searchKeys(plan.keys, actor);
    const match = keyMatch(await this.find(search), search);
    if (match.byRegistration || match.byPhone) {
      return foundAgain(match, plan.input, actor);
    }
    return this.create(input, plan.input, personId);
  }

  /** Ordem de E6/EX19: identificar, travas, "Sem alteração", versão, situação. */
  private async writeUpdate(
    input: RowWriteInput,
    plan: UpdateRow,
  ): Promise<RowOutcome> {
    const { actor } = input;
    const blocked = reachBlock(actor, plan.patch.sectorId, input.catalog);
    if (blocked) return failed(blocked);
    const search = searchKeys(plan.keys, actor);
    const people = await this.find(search, [plan.personId]);
    const person = people.find((p) => p.id === plan.personId);
    if (!person) return failed(ROW_TEXT.removedAfterPreview);
    const others = people.filter((p) => p.id !== person.id);
    const stop =
      conflictOf(keyMatch(others, search)) ??
      updateBlock(actor, person, plan.patch);
    if (stop) return failed(stop);
    if (registrationMoved(person, plan.keys)) {
      return failed(ROW_TEXT.changedAfterPreview);
    }
    if (patchSatisfied(person, plan.patch)) {
      return settled('UNCHANGED', person.id);
    }
    if (personFingerprint(person) !== plan.fingerprint) {
      return failed(ROW_TEXT.changedAfterPreview);
    }
    if (!person.isActive) return failed(ROW_TEXT.inactivePerson);
    return this.update(input, person.id, plan.patch);
  }

  /** m1: qualquer erro da criação relê pelo id da linha antes de virar motivo. */
  private async create(
    input: RowWriteInput,
    plan: CreatePlan,
    personId: string,
  ): Promise<RowOutcome> {
    try {
      await this.users.createPersonWithoutAccess(
        input.actor.id,
        toPersonInput(plan),
        { reason: input.reason, personId },
      );
      return settled('CREATED', personId);
    } catch (error) {
      if (await this.exists(personId)) return settled('UNCHANGED', personId);
      return this.fail(error);
    }
  }

  private async update(
    input: RowWriteInput,
    personId: string,
    patch: ImportPatch,
  ): Promise<RowOutcome> {
    try {
      await this.users.updateUser(
        personId,
        toUserPatch(patch),
        input.actor.id,
        {
          reason: input.reason,
        },
      );
      return settled('UPDATED', personId);
    } catch (error) {
      return this.fail(error);
    }
  }

  private async exists(personId: string): Promise<boolean> {
    const found = await this.people.findPeopleByKeys({
      ids: [personId],
      registrationKeys: [],
      phones: [],
    });
    return found.length > 0;
  }

  /** Pelas duas grafias do 9º dígito (EX33). */
  private find(
    search: SearchKeys,
    ids: readonly string[] = [],
  ): Promise<ImportPerson[]> {
    const { registrationKey, phone } = search;
    return this.people.findPeopleByKeys({
      ids,
      registrationKeys: registrationKey === null ? [] : [registrationKey],
      phones: phone === null ? [] : brazilianPhoneVariants(phone),
    });
  }

  /** EX20: o motivo conhecido, ou o texto genérico com log sem dado pessoal. */
  private fail(error: unknown): RowOutcome {
    const reason = knownReason(error);
    return reason === null ? this.unexpected(errorCode(error)) : failed(reason);
  }

  private unexpected(code: string): RowOutcome {
    this.logger.error(`falha ao gravar linha da importação (código ${code})`);
    return failed(ROW_TEXT.writeFailed);
  }
}

function searchKeys(keys: RowKeys, actor: ImportActor): SearchKeys {
  return {
    registrationKey: keys.registrationKey,
    phone: phoneFullFor(actor) ? keys.phoneE164 : null,
  };
}

/**
 * A pessoa achada pelo id já tem matrícula e não é a da linha: ela mudou depois
 * da prévia. Vem antes de "Sem alteração", que não olha a chave. Pessoa sem
 * matrícula (a linha a acrescenta) e linha sem matrícula não entram.
 */
function registrationMoved(person: ImportPerson, keys: RowKeys): boolean {
  if (keys.registrationKey === null || person.registrationKey === null) {
    return false;
  }
  return person.registrationKey !== keys.registrationKey;
}

function keyMatch(
  people: readonly ImportPerson[],
  search: SearchKeys,
): KeyMatch {
  const { registrationKey, phone } = search;
  const byRegistration =
    registrationKey === null
      ? undefined
      : people.find((p) => p.registrationKey === registrationKey);
  const byPhone =
    phone === null
      ? undefined
      : people.find((p) => samePhone(p.phoneE164, phone));
  return { byRegistration: byRegistration ?? null, byPhone: byPhone ?? null };
}

/** Chave da linha que hoje é de outra pessoa (E6): o motivo do conflito. */
function conflictOf(others: KeyMatch): string | null {
  if (others.byPhone) return ROW_TEXT.phoneTaken;
  if (others.byRegistration) return ROW_TEXT.registrationTaken;
  return null;
}

/** EX19 (a): setor de destino fora do alcance de agora; ADMIN alcança tudo. */
function reachBlock(
  actor: ImportActor,
  sectorId: string | undefined,
  catalog: StructureCatalog,
): string | null {
  if (actor.reach === null || sectorId === undefined) return null;
  if (actor.reach.includes(sectorId)) return null;
  const name = structureName(catalog, 'sector', sectorId) ?? sectorId;
  return ROW_TEXT.notInReach(name);
}

/** Quem não é ADMIN informa o setor (GX6): nunca cria pessoa fora do alcance. */
function createBlock(
  actor: ImportActor,
  sectorId: string | undefined,
  catalog: StructureCatalog,
): string | null {
  if (actor.reach !== null && sectorId === undefined) {
    return ROW_TEXT.sectorRequired;
  }
  return reachBlock(actor, sectorId, catalog);
}

/** GX6: quem não é ADMIN só mexe em pessoa sem login, hoje num setor do alcance. */
function editableHere(actor: ImportActor, person: ImportPerson): boolean {
  if (actor.reach === null) return true;
  if (person.hasAccess || person.sectorId === null) return false;
  return actor.reach.includes(person.sectorId);
}

/** EX19 (b)–(d), com as permissões de agora e antes de "Sem alteração". */
function updateBlock(
  actor: ImportActor,
  person: ImportPerson,
  patch: ImportPatch,
): string | null {
  if (!editableHere(actor, person)) return ROW_TEXT.cannotEditPerson;
  // EX17.1/DB8: sem a chave, telefone gravado não se troca nem se compara.
  const hidesPhone = !phoneFullFor(actor) && person.phoneE164 !== null;
  if (patch.phone !== undefined && hidesPhone) return ROW_TEXT.cannotEditPhone;
  const authorization = patch.contactAuthorization !== undefined;
  if (authorization && !canEditContactAuthorization(actor.policy, person)) {
    return ROW_TEXT.cannotEditAuthorization;
  }
  return null;
}

/**
 * EX17.4 b/c e m2: criação cuja chave já é de alguém. Só confirma "Sem
 * alteração" quem tem a chave e pode mexer na pessoa achada (ADMIN, ou quem a
 * alcança sem login); os demais falham sem comparar valores.
 */
function foundAgain(
  match: KeyMatch,
  input: CreatePlan,
  actor: ImportActor,
): RowOutcome {
  const reason = match.byPhone
    ? ROW_TEXT.phoneTaken
    : ROW_TEXT.registrationTaken;
  const person = samePerson(match);
  if (!person || !phoneFullFor(actor) || !editableHere(actor, person)) {
    return failed(reason);
  }
  return patchSatisfied(person, input)
    ? settled('UNCHANGED', person.id)
    : failed(reason);
}

/** As chaves da linha numa pessoa só; em pessoas diferentes, nenhuma. */
function samePerson(match: KeyMatch): ImportPerson | null {
  const { byRegistration, byPhone } = match;
  if (byRegistration && byPhone && byRegistration.id !== byPhone.id) {
    return null;
  }
  return byRegistration ?? byPhone;
}

/** M3: na criação o setor é obrigatório e anulável. */
function toPersonInput(plan: CreatePlan): PersonWithoutAccessInput {
  return {
    name: plan.name,
    phone: plan.phone,
    sectorId: plan.sectorId ?? null,
    shiftId: plan.shiftId,
    levelId: plan.levelId,
    jobTitle: plan.jobTitle,
    registration: plan.registration,
    contactAuthorization: plan.contactAuthorization,
  };
}

function toUserPatch(patch: ImportPatch): UserPatch {
  const picked: UserPatch = {};
  for (const field of PATCH_FIELDS) {
    if (patch[field] !== undefined) {
      Object.assign(picked, { [field]: patch[field] });
    }
  }
  return picked;
}

function knownReason(error: unknown): string | null {
  if (error instanceof NotFoundError) return ROW_TEXT.removedAfterPreview;
  if (error instanceof DomainError) return CODE_REASON.get(error.code) ?? null;
  if (error instanceof Error && error.message === USER_NOT_FOUND) {
    return ROW_TEXT.removedAfterPreview;
  }
  return null;
}

/** Só o código (ou o nome do erro): a mensagem pode trazer telefone ou nome. */
function errorCode(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
  return error instanceof Error ? error.name : 'desconhecido';
}
