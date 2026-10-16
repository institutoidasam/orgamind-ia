import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UsersRepository } from './users.repository';
import { ContactsService } from '../contacts/contacts.service';
import { ContactsRepository } from '../contacts/contacts.repository';
import { ContactPhoneConflictError } from '../contacts/errors/contacts.errors';
import {
  brazilianPhoneVariants,
  normalizeToE164,
} from '../contacts/phone.util';
import {
  ConflictError,
  ValidationError,
} from '../../shared/errors/domain.error';

/**
 * Telefone (WhatsApp) do usuário da equipe: normalização, unicidade por
 * titular (as duas grafias do 9º dígito são o mesmo número) e ligação ao
 * `Contact` do mesmo número. Nunca registra o telefone em log/auditoria.
 */
@Injectable()
export class UserPhoneService {
  constructor(
    private readonly users: UsersRepository,
    private readonly contacts: ContactsService,
    private readonly contactsRepo: ContactsRepository,
  ) {}

  normalize(raw: string): string {
    const phoneE164 = normalizeToE164(raw, 'BR');
    if (!phoneE164) {
      throw new ValidationError(
        'Telefone inválido',
        'Use DDD + número, com ou sem +55',
        'user.invalid_phone',
      );
    }
    return phoneE164;
  }

  async assertAvailable(phoneE164: string, selfId?: string): Promise<void> {
    const ownerId = await this.users.findIdByPhoneVariants(
      brazilianPhoneVariants(phoneE164),
    );
    if (ownerId && ownerId !== selfId) {
      throw new ConflictError('Phone already taken', 'user.phone_taken');
    }
  }

  /**
   * Contato do número em qualquer grafia BR → reaproveita (preenche só o nome
   * vazio; consentimento intocado). Senão cria pelo `ContactsService.create`
   * (auditoria, reidratação de consentimento, ligação de conversas).
   *
   * Risco aceito (M7): o chamador resolve o contato ANTES de gravar o usuário.
   * Numa corrida de e-mail (P2002 em `email` no create do usuário) o contato
   * criado aqui fica sem usuário — é um `Contact` legítimo do número, e o
   * próximo cadastro com esse telefone liga a ele. Inverter a ordem deixaria
   * usuário gravado sem contato quando a ligação falha, e `ContactsService.create`
   * não participa da mesma transação do `repo.create`.
   */
  async resolveContactId(
    phoneE164: string,
    displayName: string,
  ): Promise<string> {
    const existing = await this.contactsRepo.findByAnyBrForm(phoneE164);
    if (existing) {
      if (!existing.name) {
        await this.contacts.update(existing.id, { name: displayName });
      }
      return existing.id;
    }
    try {
      const created = await this.contacts.create({
        phone: phoneE164,
        name: displayName,
        tags: [],
      });
      return created.id;
    } catch (err) {
      if (!(err instanceof ContactPhoneConflictError)) throw err;
      // Outro cadastro criou o contato entre a leitura e o create: liga a ele.
      const raced = await this.contactsRepo.findByAnyBrForm(phoneE164);
      if (!raced) throw err;
      return raced.id;
    }
  }

  /** P2002 em phoneE164/contactId (corrida entre dois cadastros) → user.phone_taken. */
  static isPhoneUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      /phoneE164|contactId/.test(JSON.stringify(err.meta?.target ?? null))
    );
  }
}
