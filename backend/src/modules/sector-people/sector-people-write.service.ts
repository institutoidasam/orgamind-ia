import { Injectable } from '@nestjs/common';
import type {
  AddFromContactsInput,
  AddFromContactsResponse,
  CreateSectorPersonInput,
  MovePeopleResponse,
  SectorPeopleFailureReason,
  SectorPerson,
  UpdateSectorPersonInput,
} from '../../schemas/contracts/sector-people.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { DomainError } from '../../shared/errors/domain.error';
import { invalidLevel } from '../users/users.errors';
import { UsersService } from '../users/users.service';
import {
  sectorPeopleForbidden,
  sectorPeopleHasAccess,
  sectorPeopleInvalidShift,
  sectorPeoplePersonNotFound,
} from './sector-people.errors';
import {
  canEditPerson,
  canPickExisting,
  canRemove,
  isSectorAdmin,
  type PeopleActor,
  type PeoplePerson,
  type PersonField,
} from './sector-people.policy';
import {
  type BatchContact,
  SectorPeopleRepository,
  toSectorPerson,
} from './sector-people.repository';
import { SectorPeopleService } from './sector-people.service';

type BatchOptions = { levelId?: string | null; shiftId: string };
type ItemOutcome = { userId: string } | { reason: SectorPeopleFailureReason };

/** Erros do `UserPhoneService` que viram motivo por item no lote. */
const PHONE_FAILURES: Readonly<Record<string, SectorPeopleFailureReason>> = {
  'user.invalid_phone': 'invalid_phone',
  'user.phone_taken': 'phone_taken',
};

/** Só os campos do contrato chegam ao `updateUser`: nunca setor, papel, acesso ou e-mail. */
function personPatch(patch: UpdateSectorPersonInput): UpdateSectorPersonInput {
  const { name, phone, levelId, jobTitle, shiftId } = patch;
  const picked = { name, phone, levelId, jobTitle, shiftId };
  return Object.fromEntries(
    Object.entries(picked).filter(([, value]) => value !== undefined),
  );
}

function phoneFailure(error: unknown): SectorPeopleFailureReason | undefined {
  return error instanceof DomainError ? PHONE_FAILURES[error.code] : undefined;
}

/**
 * Escrita da página do setor (C3/P1, D10–D12). Toda rota passa por
 * `requireManageable` e pela política antes de gravar; a gravação é a do
 * `UsersService` (telefone único e ligação ao Contato pelo `UserPhoneService`).
 * Auditoria só com ids e contagens (GC8).
 */
@Injectable()
export class SectorPeopleWriteService {
  constructor(
    private readonly people: SectorPeopleService,
    private readonly repo: SectorPeopleRepository,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  async create(
    actorId: string,
    sectorId: string,
    input: CreateSectorPersonInput,
  ): Promise<SectorPerson> {
    const { actor, sector } = await this.people.requireManageable(
      actorId,
      sectorId,
    );
    await this.assertOptions(input);
    const user = await this.users.createPersonWithoutAccess(actorId, {
      ...input,
      sectorId: sector.id,
    });
    await this.auditAdded(actorId, sector.id, {
      source: 'new',
      created: 1,
      failed: 0,
    });
    const [person] = await this.readPeople(actor, [user.id]);
    return person;
  }

  /** D10: um contato por vez, em ordem; falha de telefone vira item de `failed`. */
  async addFromContacts(
    actorId: string,
    sectorId: string,
    input: AddFromContactsInput,
  ): Promise<AddFromContactsResponse> {
    const { actor, sector } = await this.people.requireManageable(
      actorId,
      sectorId,
    );
    await this.assertOptions(input);
    const contactIds = [...new Set(input.contactIds)];
    const contacts = new Map(
      (await this.repo.findContactsForBatch(contactIds)).map((c) => [c.id, c]),
    );
    const createdIds: string[] = [];
    const failed: AddFromContactsResponse['failed'] = [];
    for (const contactId of contactIds) {
      // Sequencial de propósito: a ordem do lote decide quem fica com o número.
      const outcome = await this.addContact(
        { actorId, sectorId: sector.id, options: input },
        contactId,
        contacts.get(contactId),
      );
      if ('userId' in outcome) createdIds.push(outcome.userId);
      else failed.push({ contactId, reason: outcome.reason });
    }
    await this.auditAdded(actorId, sector.id, {
      source: 'contacts',
      created: createdIds.length,
      failed: failed.length,
    });
    return { created: await this.readPeople(actor, createdIds), failed };
  }

  /** Tudo conferido antes do primeiro update: 404 ou 403 não move ninguém. */
  async move(
    actorId: string,
    sectorId: string,
    userIds: string[],
  ): Promise<MovePeopleResponse> {
    const { actor, sector } = await this.people.requireManageable(
      actorId,
      sectorId,
    );
    const ids = [...new Set(userIds)];
    const found = new Map(
      (await this.repo.findPeople(ids)).map((p) => [p.id, p]),
    );
    const people = ids.map((id) => found.get(id));
    if (!people.every((p) => p?.isActive)) throw sectorPeoplePersonNotFound();
    if (!people.every((p) => p && canPickExisting(actor, sector, p))) {
      throw sectorPeopleForbidden();
    }
    for (const id of ids) {
      await this.users.updateUser(id, { sectorId: sector.id }, actorId);
    }
    await this.audit.log('sector_people.moved', 'Sector', sector.id, {
      actorId,
      sectorId: sector.id,
      count: ids.length,
    });
    return { moved: await this.readPeople(actor, ids) };
  }

  async update(
    actorId: string,
    sectorId: string,
    userId: string,
    patch: UpdateSectorPersonInput,
  ): Promise<SectorPerson> {
    const { actor, sector } = await this.people.requireManageable(
      actorId,
      sectorId,
    );
    const person = await this.requirePerson(userId);
    const data = personPatch(patch);
    const fields = Object.keys(data) as PersonField[];
    if (!canEditPerson(sector, person, fields)) throw sectorPeopleForbidden();
    await this.users.updateUser(userId, data, actorId);
    const [row] = await this.readPeople(actor, [userId]);
    return row;
  }

  async remove(
    actorId: string,
    sectorId: string,
    userId: string,
  ): Promise<void> {
    const { sector } = await this.people.requireManageable(actorId, sectorId);
    const person = await this.requirePerson(userId);
    if (person.sectorId !== sector.id) throw sectorPeopleForbidden();
    if (!canRemove(sector, person)) throw sectorPeopleHasAccess();
    await this.users.updateUser(userId, { sectorId: null }, actorId);
    await this.audit.log('sector_people.removed', 'Sector', sector.id, {
      actorId,
      sectorId: sector.id,
      userId,
    });
  }

  /** Q3: nível e turno do pedido inteiro valem antes de criar qualquer pessoa. */
  private async assertOptions(options: BatchOptions): Promise<void> {
    const levelId = options.levelId ?? null;
    const { level, shift } = await this.repo.findLevelAndShift(
      levelId,
      options.shiftId,
    );
    if (!shift?.isActive) throw sectorPeopleInvalidShift();
    if (levelId && !level?.isActive) throw invalidLevel();
  }

  private async addContact(
    ctx: { actorId: string; sectorId: string; options: BatchOptions },
    contactId: string,
    contact: BatchContact | undefined,
  ): Promise<ItemOutcome> {
    if (!contact) return { reason: 'contact_not_found' };
    if (contact.personId) return { reason: 'already_person' };
    try {
      const user = await this.users.createPersonWithoutAccess(ctx.actorId, {
        // D11: contato sem nome vira pessoa com o número como nome.
        name: contact.name?.trim() || contact.phoneE164,
        phone: contact.phoneE164,
        sectorId: ctx.sectorId,
        levelId: ctx.options.levelId ?? null,
        shiftId: ctx.options.shiftId,
      });
      return { userId: user.id };
    } catch (error) {
      return { reason: await this.failureReason(error, contactId) };
    }
  }

  /**
   * Só erro de telefone vira item; o resto (banco, setor inválido) interrompe o
   * lote sem desfazer quem já foi criado. O `UsersService` traduz o P2002 de
   * `contactId` (outro lote ligou o contato) em `user.phone_taken`: relendo a
   * ligação, o motivo volta a ser `already_person` (D10).
   */
  private async failureReason(
    error: unknown,
    contactId: string,
  ): Promise<SectorPeopleFailureReason> {
    const reason = phoneFailure(error);
    if (!reason) throw error;
    if (
      reason === 'phone_taken' &&
      (await this.repo.isContactLinked(contactId))
    )
      return 'already_person';
    return reason;
  }

  private async requirePerson(userId: string): Promise<PeoplePerson> {
    const person = await this.repo.findPerson(userId);
    if (!person?.isActive) throw sectorPeoplePersonNotFound();
    return person;
  }

  /** Respostas pelo mapper da T5 (GC8: telefone de quem tem acesso só ao ADMIN). */
  private async readPeople(
    actor: PeopleActor,
    ids: readonly string[],
  ): Promise<SectorPerson[]> {
    if (ids.length === 0) return [];
    const viewer = { isAdmin: isSectorAdmin(actor) };
    const rows = new Map(
      (await this.repo.findPersonRows(ids)).map((row) => [row.id, row]),
    );
    return ids.flatMap((id) => {
      const row = rows.get(id);
      return row ? [toSectorPerson(row, viewer)] : [];
    });
  }

  private auditAdded(
    actorId: string,
    sectorId: string,
    counts: { source: 'new' | 'contacts'; created: number; failed: number },
  ): Promise<void> {
    return this.audit.log('sector_people.added', 'Sector', sectorId, {
      actorId,
      sectorId,
      ...counts,
    });
  }
}
