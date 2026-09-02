import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, MockProxy } from 'vitest-mock-extended';
import { ContactsService } from './contacts.service';
import { ContactsRepository } from './contacts.repository';
import {
  ContactNotFoundError,
  ContactPhoneConflictError,
  ChannelOfflineForSyncError,
  SyncNotSupportedError,
  SyncOutsideSendWindowError,
} from './errors/contacts.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { ConsentService, GLOBAL_PURPOSE } from '../consent/consent.service';
import { ConsentAction, ConsentSource } from '@prisma/client';
import { invalidContactWhere } from '../../shared/contact-validity';

const defaultSyncQueue = { add: vi.fn().mockResolvedValue({ id: 'j1' }) };

describe('ContactsService', () => {
  let service: ContactsService;
  let repo: MockProxy<ContactsRepository>;
  let audit: MockProxy<AuditService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let consent: MockProxy<ConsentService>;

  beforeEach(() => {
    repo = mockDeep<ContactsRepository>();
    audit = mockDeep<AuditService>();
    wa = mockDeep<WhatsappProvidersService>();
    consent = mockDeep<ConsentService>();
    consent.record.mockResolvedValue({ eventId: 'ev1', created: true });
    consent.reinstate.mockResolvedValue([]);
    consent.rehydrate.mockResolvedValue([]);
    defaultSyncQueue.add.mockResolvedValue({ id: 'j1' } as never);
    service = new ContactsService(
      repo,
      audit,
      wa,
      defaultSyncQueue as never,
      consent as never,
      {
        get: vi.fn().mockResolvedValue({
          id: 'singleton',
          name: 'CONTINUUM',
          legalName: 'Canal do Matheus Garcia - CONTINUUM',
          privacyPolicyUrl: null,
          supportContact: null,
        }),
      } as never,
      { findDefault: vi.fn().mockResolvedValue(null) } as never,
    );
  });

  it('list returns paginated result', async () => {
    repo.listPaginated.mockResolvedValue({ items: [], total: 0 });
    const result = await service.list({ page: 1, pageSize: 50 });
    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
  });

  it('update throws ContactNotFoundError when not found', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.update('missing', { name: 'X' })).rejects.toThrow(
      ContactNotFoundError,
    );
  });

  it('update calls repo when found', async () => {
    repo.findById.mockResolvedValue({ id: 'c1' } as any);
    repo.update.mockResolvedValue({ id: 'c1', name: 'X' } as any);
    const r = await service.update('c1', { name: 'X' });
    expect(r.name).toBe('X');
    expect(repo.update).toHaveBeenCalledWith('c1', { name: 'X' });
  });

  // C1 — `optedOut` é cache derivado. Escrevê-lo direto na linha produzia um
  // opt-out sem trilha, que evaporava na próxima reimportação da planilha.
  describe('update — optedOut passa pelo ConsentService', () => {
    beforeEach(() => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        phoneE164: '+5592998887777',
      } as any);
      repo.update.mockResolvedValue({ id: 'c1' } as any);
    });

    it('optedOut=true vira REVOKE global + SuppressionList (fonte MANUAL_ADMIN)', async () => {
      await service.update('c1', { optedOut: true });

      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'c1',
          phoneE164: '+5592998887777',
          purposeKey: GLOBAL_PURPOSE,
          action: ConsentAction.REVOKE,
          source: ConsentSource.MANUAL_ADMIN,
          suppressionReason: 'manual',
        }),
      );
      // A coluna NUNCA é escrita à mão — o ConsentService reprojeta o cache.
      expect(repo.update).not.toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ optedOut: expect.anything() }),
      );
    });

    it('optedOut=false reativa via reinstate (não inventa consentimento novo)', async () => {
      await service.update('c1', { optedOut: false });

      expect(consent.reinstate).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'c1',
          source: ConsentSource.MANUAL_ADMIN,
        }),
      );
      expect(consent.record).not.toHaveBeenCalled();
    });

    it('os demais campos continuam indo pelo repo, junto com o opt-out', async () => {
      await service.update('c1', { optedOut: true, name: 'Maria' });

      expect(repo.update).toHaveBeenCalledWith('c1', { name: 'Maria' });
      expect(consent.record).toHaveBeenCalledTimes(1);
    });
  });

  it('exportData throws ContactNotFoundError when contact missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.exportData('missing')).rejects.toThrow(
      ContactNotFoundError,
    );
  });

  it('exportData returns contact + messages + importItems and audits', async () => {
    const contact = { id: 'c1', phoneE164: '+5592987654321' } as any;
    const messages = [{ id: 'm1' }] as any;
    const importItems = [{ id: 'ii1' }] as any;
    repo.findById.mockResolvedValue(contact);
    repo.findMessagesForContact.mockResolvedValue(messages);
    repo.findImportItemsForContact.mockResolvedValue(importItems);

    const result = await service.exportData('c1');

    expect(result.contact).toBe(contact);
    expect(result.messages).toBe(messages);
    expect(result.importItems).toBe(importItems);
    expect(typeof result.exportedAt).toBe('string');
    expect(audit.log).toHaveBeenCalledWith('contact.export', 'Contact', 'c1');
  });

  it('delete logs phoneE164 in audit metadata', async () => {
    const existing = { id: 'c1', phoneE164: '+5592111111111' } as any;
    repo.findById.mockResolvedValue(existing);
    repo.delete.mockResolvedValue(existing);
    await service.delete('c1');
    expect(audit.log).toHaveBeenCalledWith(
      'contact.delete',
      'Contact',
      'c1',
      { phoneE164: '+5592111111111' },
    );
  });

  it('não expõe mais validateWhatsapp (fluxo síncrono substituído por syncBackfill)', () => {
    expect(
      (service as unknown as Record<string, unknown>).validateWhatsapp,
    ).toBeUndefined();
  });

  describe('setLabels', () => {
    it('happy path applies adds + removes and audits with partial:false', async () => {
      const contact = {
        id: 'c1',
        phoneE164: '+5592987654321',
        waLabels: ['keep', 'drop1', 'drop2'],
      } as any;
      repo.findById.mockResolvedValue(contact);
      repo.updateLabels.mockImplementation(
        async (_id: string, labels: string[]) =>
          ({ id: 'c1', waLabels: labels }) as never,
      );
      wa.handleContactLabel.mockResolvedValue(undefined as never);

      const result = await service.setLabels('c1', [
        'keep',
        'newA',
        'newB',
      ]);

      // Two adds (newA, newB) + two removes (drop1, drop2) = 4 calls
      expect(wa.handleContactLabel).toHaveBeenCalledTimes(4);
      const jid = '5592987654321@s.whatsapp.net';
      expect(wa.handleContactLabel).toHaveBeenCalledWith({
        jid,
        labelId: 'newA',
        action: 'add',
      });
      expect(wa.handleContactLabel).toHaveBeenCalledWith({
        jid,
        labelId: 'newB',
        action: 'add',
      });
      expect(wa.handleContactLabel).toHaveBeenCalledWith({
        jid,
        labelId: 'drop1',
        action: 'remove',
      });
      expect(wa.handleContactLabel).toHaveBeenCalledWith({
        jid,
        labelId: 'drop2',
        action: 'remove',
      });

      // Final persisted list: keep + newA + newB
      const updateCall = repo.updateLabels.mock.calls[0];
      expect(updateCall[0]).toBe('c1');
      expect(new Set(updateCall[1])).toEqual(
        new Set(['keep', 'newA', 'newB']),
      );

      expect(audit.log).toHaveBeenCalledWith(
        'contact.set_labels',
        'Contact',
        'c1',
        expect.objectContaining({
          added: ['newA', 'newB'],
          removed: ['drop1', 'drop2'],
          partial: false,
          total: 3,
        }),
      );
      expect((result as any).waLabels).toEqual(
        expect.arrayContaining(['keep', 'newA', 'newB']),
      );
    });

    it('persists partial state and re-throws when an Evolution call fails mid-batch', async () => {
      const contact = {
        id: 'c1',
        phoneE164: '+5592987654321',
        waLabels: [],
      } as any;
      repo.findById.mockResolvedValue(contact);
      repo.updateLabels.mockResolvedValue({ id: 'c1' } as never);

      // adds: 5 labels. Succeed for the first 3, fail on the 4th.
      const failure = new Error('evo down');
      let count = 0;
      wa.handleContactLabel.mockImplementation(async () => {
        count++;
        if (count <= 3) return undefined as never;
        throw failure;
      });

      await expect(
        service.setLabels('c1', ['l1', 'l2', 'l3', 'l4', 'l5']),
      ).rejects.toBe(failure);

      // 4 attempts (3 ok + 1 failure). Loop breaks immediately on first error.
      expect(wa.handleContactLabel).toHaveBeenCalledTimes(4);

      // Persisted list is the 3 that succeeded.
      expect(repo.updateLabels).toHaveBeenCalledTimes(1);
      const persisted = repo.updateLabels.mock.calls[0][1];
      expect(new Set(persisted)).toEqual(new Set(['l1', 'l2', 'l3']));

      // Audit logs partial:true with applied list
      expect(audit.log).toHaveBeenCalledWith(
        'contact.set_labels',
        'Contact',
        'c1',
        expect.objectContaining({
          partial: true,
          added: ['l1', 'l2', 'l3', 'l4', 'l5'],
          applied: expect.arrayContaining(['l1', 'l2', 'l3']),
        }),
      );
    });

    it('throws ContactNotFoundError when contact missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.setLabels('missing', ['x'])).rejects.toThrow(
        ContactNotFoundError,
      );
      expect(wa.handleContactLabel).not.toHaveBeenCalled();
      expect(repo.updateLabels).not.toHaveBeenCalled();
    });
  });

  describe('ContactsService.syncBackfill', () => {
    const GOZAP_CHANNEL = {
      id: 'ch1',
      name: 'robo',
      provider: 'GOZAP',
      isDefault: true,
      isActive: true,
      sendWindowEnabled: false,
      sendWindowStartHour: 8,
      sendWindowEndHour: 20,
    };

    function makeService(instances: unknown) {
      return new ContactsService(
        repo,
        audit,
        wa,
        defaultSyncQueue as never,
        consent as never,
        {
          get: vi.fn().mockResolvedValue({
            id: 'singleton',
            name: 'CONTINUUM',
            legalName: 'Canal do Matheus Garcia - CONTINUUM',
            privacyPolicyUrl: null,
            supportContact: null,
          }),
        } as never,
        instances as never,
      );
    }

    /** `resolveSyncChannel` chama `instancesRepo.listActive()`, não mais
     * `findDefault()` (fix round 1 — ver resolve-sync-channel.util.ts). */
    function instancesWith(...channels: unknown[]) {
      return { listActive: vi.fn().mockResolvedValue(channels) };
    }

    beforeEach(() => {
      wa.supportsNumberCheckFor.mockReturnValue(true);
      repo.isSessionChannelOnline.mockResolvedValue(true);
      repo.findIdsForSync.mockResolvedValue(
        Array.from({ length: 120 }, (_, i) => `c${i}`),
      );
      // `defaultSyncQueue` é compartilhado (escopo de módulo) entre os testes
      // deste arquivo, e não há `clearMocks` global — sem isto, os 3 `.add`
      // do primeiro teste ("enfileira em lotes de 50…") vazam para o teste do
      // canal offline, que espera ZERO chamadas.
      defaultSyncQueue.add.mockClear();
    });

    // ★ A TRAVA MUDA DE NATUREZA: era "existe canal Evolution neste deploy?" —
    // que em produção (canal GoZap) fazia o job virar no-op SILENCIOSO. Agora é
    // "o canal padrão sabe validar número?".
    it('enfileira em lotes de 50 quando o canal padrão sabe validar (GoZap)', async () => {
      const instances = instancesWith(GOZAP_CHANNEL);
      const svc = makeService(instances);

      const r = await svc.syncBackfill('unvalidated');

      expect(wa.supportsNumberCheckFor).toHaveBeenCalledWith('GOZAP');
      expect(repo.findIdsForSync).toHaveBeenCalledWith('unvalidated', 50_000);
      expect(defaultSyncQueue.add).toHaveBeenCalledTimes(3);
      expect(r.enqueued).toBe(3);
      // Fix round 1 (minor) — denominador para a barra de progresso da T13.
      expect(r.total).toBe(120);
      expect(r.mode).toBe('unvalidated');
      expect(typeof r.startedAt).toBe('string');
    });

    it('recusa quando não há canal padrão ativo', async () => {
      const instances = instancesWith();
      await expect(makeService(instances).syncBackfill('all')).rejects.toThrow(
        SyncNotSupportedError,
      );
    });

    it('recusa quando o canal padrão não sabe validar número', async () => {
      wa.supportsNumberCheckFor.mockReturnValue(false);
      const instances = instancesWith({ ...GOZAP_CHANNEL, provider: 'ZERNIO' });
      await expect(makeService(instances).syncBackfill('all')).rejects.toThrow(
        SyncNotSupportedError,
      );
    });

    // Fix round 1 (revisão pós-commit, item #5) — `findDefault()` sem
    // provider pegava o `isDefault` mais VELHO entre TODOS os provedores;
    // `setDefault` é escopado por provedor (T8), então um EVOLUTION antigo
    // (morto) e um GOZAP novo (vivo) podiam ser default AO MESMO TEMPO. O
    // resolver escolhe entre os dois pela CAPACIDADE + quem está online —
    // nunca "o mais velho".
    it('entre vários canais default, escolhe quem está online — não o mais antigo', async () => {
      const evolutionStale = {
        id: 'ch-evo-antigo',
        name: 'evo-antigo',
        provider: 'EVOLUTION',
        isDefault: true,
        isActive: true,
        sendWindowEnabled: false,
        sendWindowStartHour: 8,
        sendWindowEndHour: 20,
      };
      repo.isSessionChannelOnline.mockImplementation(
        async (c: { id: string }) => c.id === 'ch1',
      );
      const instances = instancesWith(evolutionStale, GOZAP_CHANNEL);

      const r = await makeService(instances).syncBackfill('unvalidated');

      expect(r.enqueued).toBe(3);
      expect(audit.log).toHaveBeenCalledWith(
        'contact.sync_backfill_requested',
        'Contact',
        undefined,
        expect.objectContaining({ channelId: 'ch1', provider: 'GOZAP' }),
      );
    });

    // O operador clicava e via "3 jobs enfileirados" enquanto todos morriam.
    it('recusa NA HORA quando o canal está desconectado', async () => {
      repo.isSessionChannelOnline.mockResolvedValue(false);
      const instances = instancesWith(GOZAP_CHANNEL);
      await expect(makeService(instances).syncBackfill('all')).rejects.toThrow(
        ChannelOfflineForSyncError,
      );
      expect(defaultSyncQueue.add).not.toHaveBeenCalled();
    });

    it('recusa fora da janela de envio do canal', async () => {
      const instances = instancesWith({
        ...GOZAP_CHANNEL,
        sendWindowEnabled: true,
        sendWindowStartHour: 8,
        sendWindowEndHour: 9,
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T07:00:00Z')); // 03:00 em Manaus
      try {
        await expect(makeService(instances).syncBackfill('all')).rejects.toThrow(
          SyncOutsideSendWindowError,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('audita o pedido com modo e contagem de lotes', async () => {
      const instances = instancesWith(GOZAP_CHANNEL);
      await makeService(instances).syncBackfill('unvalidated');
      expect(audit.log).toHaveBeenCalledWith(
        'contact.sync_backfill_requested',
        'Contact',
        undefined,
        expect.objectContaining({ mode: 'unvalidated', enqueued: 3 }),
      );
    });
  });

  describe('ContactsService.syncProgress', () => {
    it('devolve quantos foram checados desde o início e quantos faltam', async () => {
      repo.countCheckedSince.mockResolvedValue(80);
      repo.countByValidity.mockResolvedValue(1_920);
      const since = new Date('2026-08-24T12:00:00Z');

      const r = await service.syncProgress(since);

      expect(repo.countCheckedSince).toHaveBeenCalledWith(since);
      expect(repo.countByValidity).toHaveBeenCalledWith('unvalidated');
      expect(r).toEqual({ checked: 80, unvalidated: 1_920 });
    });
  });

  /**
   * C5.3 — criar um contato não é necessariamente conhecer uma pessoa nova. Se ela
   * já consentiu (ou já deu PARAR) antes de a linha ser apagada, a trilha continua
   * lá, chaveada pelo `phoneHash` durável — e o estado derivado tem de renascer
   * com ela. Sem isto, o consentimento existe e o gate não o enxerga.
   */
  describe('create — reidrata o consentimento da trilha do phoneHash', () => {
    it('reidrata o contato recém-criado', async () => {
      repo.findByAnyBrForm.mockResolvedValue(null);
      repo.create.mockResolvedValue({ id: 'c1', phoneE164: '+5511999990000' } as never);

      await service.create({ phone: '+5511999990000', name: 'Test' });

      expect(consent.rehydrate).toHaveBeenCalledWith('c1', '+5511999990000');
    });

    it('falha na reidratação não derruba a criação do contato', async () => {
      repo.findByAnyBrForm.mockResolvedValue(null);
      repo.create.mockResolvedValue({ id: 'c1', phoneE164: '+5511999990000' } as never);
      consent.rehydrate.mockRejectedValue(new Error('db down'));

      await expect(
        service.create({ phone: '+5511999990000', name: 'Test' }),
      ).resolves.toMatchObject({ id: 'c1' });
    });
  });

  /**
   * C5 — a mesma pessoa não pode virar duas linhas.
   *
   * `+5592995550101` (13 díg.) e `+559295550101` (12 díg.) são a MESMA conta de
   * WhatsApp — o incidente de 08/07 provou isso em produção. O cadastro manual
   * casava por igualdade EXATA de string, então digitar a outra grafia criava o
   * gêmeo, que nasce GRANTED pela reidratação e recebe a campanha de novo.
   */
  describe('create — identidade é o assinante, não a string', () => {
    it('recusa o cadastro quando o titular já existe na OUTRA grafia do 9º dígito', async () => {
      repo.findByAnyBrForm.mockResolvedValue({
        id: 'c-existente',
        phoneE164: '+5592995550101',
      } as never);
      repo.create.mockResolvedValue({ id: 'c-novo' } as never);

      await expect(
        service.create({ phone: '(92) 9555-0101', name: 'João' }),
      ).rejects.toThrow(ContactPhoneConflictError);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('consulta o repositório pela forma normalizada — quem expande as variantes é o repositório', async () => {
      repo.findByAnyBrForm.mockResolvedValue(null);
      repo.create.mockResolvedValue({ id: 'c1', phoneE164: '+559295550101' } as never);

      await service.create({ phone: '(92) 9555-0101', tags: [] });

      expect(repo.findByAnyBrForm).toHaveBeenCalledWith('+559295550101');
    });
  });

  describe('create sync enqueue', () => {
    it('enqueues a sync job after the contact is created', async () => {
      const syncQueue = { add: vi.fn().mockResolvedValue({ id: 'j1' }) };
      const svc = new ContactsService(
        repo,
        audit,
        wa,
        syncQueue as never,
        consent as never,
        {
          get: vi.fn().mockResolvedValue({
            id: 'singleton',
            name: 'CONTINUUM',
            legalName: 'Canal do Matheus Garcia - CONTINUUM',
            privacyPolicyUrl: null,
            supportContact: null,
          }),
        } as never,
        { findDefault: vi.fn().mockResolvedValue(null) } as never,
      );
      repo.findByAnyBrForm.mockResolvedValue(null);
      repo.create.mockResolvedValue({ id: 'c1', phoneE164: '+5511999990000' } as never);

      await svc.create({ phone: '+5511999990000', name: 'Test' });

      expect(syncQueue.add).toHaveBeenCalledWith('sync', {
        contactIds: ['c1'],
        triggeredBy: 'create',
      });
    });

    it('does not break create if enqueue fails', async () => {
      const syncQueue = {
        add: vi.fn().mockRejectedValue(new Error('redis down')),
      };
      const svc = new ContactsService(
        repo,
        audit,
        wa,
        syncQueue as never,
        consent as never,
        {
          get: vi.fn().mockResolvedValue({
            id: 'singleton',
            name: 'CONTINUUM',
            legalName: 'Canal do Matheus Garcia - CONTINUUM',
            privacyPolicyUrl: null,
            supportContact: null,
          }),
        } as never,
        { findDefault: vi.fn().mockResolvedValue(null) } as never,
      );
      repo.findByAnyBrForm.mockResolvedValue(null);
      repo.create.mockResolvedValue({ id: 'c1', phoneE164: '+5511999990000' } as never);

      const result = await svc.create({ phone: '+5511999990000', name: 'Test' });

      // The mutation must complete normally and return the contact
      expect((result as any).id).toBe('c1');
    });
  });

  describe('retroactive conversation linking on create', () => {
    it('links pre-existing unlinked conversations across both BR 9th-digit forms', async () => {
      repo.findByAnyBrForm.mockResolvedValue(null);
      // Contact saved canonically with the extra 9.
      repo.create.mockResolvedValue({ id: 'cBR', phoneE164: '+5592995550101' } as never);

      await service.create({ phone: '+5592995550101', name: 'Andre Lima' });

      expect(repo.linkConversationsByPhone).toHaveBeenCalledTimes(1);
      const [contactId, variants] = repo.linkConversationsByPhone.mock.calls[0];
      expect(contactId).toBe('cBR');
      expect(new Set(variants)).toEqual(
        new Set(['+5592995550101', '+559295550101']),
      );
    });

    it('does not fail create when linking throws', async () => {
      repo.findByAnyBrForm.mockResolvedValue(null);
      repo.create.mockResolvedValue({ id: 'cBR', phoneE164: '+5592995550101' } as never);
      repo.linkConversationsByPhone.mockRejectedValue(new Error('db blip'));

      const result = await service.create({ phone: '+5592995550101', name: 'Andre' });

      expect((result as { id: string }).id).toBe('cBR');
    });
  });

  describe('bulkDelete — por validade (B.3)', () => {
    it('apaga usando o MESMO predicado do filtro "inválidos" da lista', async () => {
      repo.deleteWhere.mockResolvedValue({ count: 120 });
      const r = await service.bulkDelete({ validity: 'invalid' });

      expect(repo.deleteWhere).toHaveBeenCalledWith(invalidContactWhere());
      expect(r).toEqual({ deleted: 120 });
    });

    it('grava AuditEvent com a contagem e a classe apagada', async () => {
      repo.deleteWhere.mockResolvedValue({ count: 120 });
      await service.bulkDelete({ validity: 'invalid' });

      expect(audit.log).toHaveBeenCalledWith(
        'contact.bulk_delete_invalid',
        'Contact',
        undefined,
        expect.objectContaining({ validity: 'invalid', count: 120 }),
      );
    });

    /**
     * `validity` é checado ANTES de `all`. Um corpo com os dois é ambíguo, e das
     * duas leituras possíveis a mais restrita é a única segura: `all` apagaria a
     * base inteira.
     */
    it('validity vence all quando os dois chegam juntos', async () => {
      repo.deleteWhere.mockResolvedValue({ count: 3 });
      await service.bulkDelete({ validity: 'invalid', all: true });

      expect(repo.deleteWhere).toHaveBeenCalledTimes(1);
      expect(repo.deleteAll).not.toHaveBeenCalled();
    });

    it('sem validity, os caminhos antigos (ids / all) continuam iguais', async () => {
      repo.deleteMany.mockResolvedValue({ count: 2 });
      await service.bulkDelete({ ids: ['a', 'b'] });
      expect(repo.deleteMany).toHaveBeenCalledWith(['a', 'b']);
      expect(repo.deleteWhere).not.toHaveBeenCalled();
    });

    /**
     * Round 1 (pré-revisão) — a "confirmação exige digitar N" da spec só é
     * uma garantia se o servidor recusa quando a tela do operador ficou
     * desatualizada: outra pessoa mexeu na base entre o carregamento da
     * lista e o clique em apagar.
     */
    it('expectedCount divergindo da contagem viva: recusa (409-class) e não apaga nada', async () => {
      repo.countWhere.mockResolvedValue(150);
      const attempt = service.bulkDelete({
        validity: 'invalid',
        expectedCount: 120,
      });

      await expect(attempt).rejects.toMatchObject({ status: 409 });
      // Round 2 (revisão) — a mensagem carrega OS DOIS números: o que está
      // no banco agora e o que o operador confirmou. Sem os dois a mensagem
      // não ensina o operador a decidir o próximo passo.
      await expect(attempt).rejects.toMatchObject({
        message: expect.stringContaining('150'),
      });
      await expect(attempt).rejects.toMatchObject({
        message: expect.stringContaining('120'),
      });
      expect(repo.deleteWhere).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    /**
     * Round 2 (revisão) — fecha a corrida entre `countWhere` e `deleteWhere`:
     * uma linha que virou inválida DEPOIS do instante contado (`snapshot`)
     * não pode ser apagada, mesmo que já combine com `where` na hora do
     * delete. `deleteWhere` tem de receber o predicado original ENVOLVIDO
     * num `AND` com `updatedAt: { lte: snapshot } }` — nunca o `where` nu.
     */
    it('expectedCount batendo com a contagem viva: apaga com o predicado travado no instante da contagem, e o audit carrega os dois números', async () => {
      repo.countWhere.mockResolvedValue(120);
      repo.deleteWhere.mockResolvedValue({ count: 120 });

      const r = await service.bulkDelete({
        validity: 'invalid',
        expectedCount: 120,
      });

      expect(repo.deleteWhere).toHaveBeenCalledWith({
        AND: [invalidContactWhere(), { updatedAt: { lte: expect.any(Date) } }],
      });
      // A checagem de contagem usa o predicado NU (sem o corte de tempo) — é
      // "quantas linhas são inválidas agora", não "quantas eram inválidas até
      // um instante".
      expect(repo.countWhere).toHaveBeenCalledWith(invalidContactWhere());
      expect(r).toEqual({ deleted: 120 });
      expect(audit.log).toHaveBeenCalledWith(
        'contact.bulk_delete_invalid',
        'Contact',
        undefined,
        expect.objectContaining({
          validity: 'invalid',
          count: 120,
          expectedCount: 120,
        }),
      );
    });

    it('sem expectedCount, o comportamento não muda: apaga sem checar a contagem viva', async () => {
      repo.deleteWhere.mockResolvedValue({ count: 120 });

      const r = await service.bulkDelete({ validity: 'invalid' });

      expect(repo.countWhere).not.toHaveBeenCalled();
      expect(repo.deleteWhere).toHaveBeenCalledWith(invalidContactWhere());
      expect(r).toEqual({ deleted: 120 });
    });
  });
});
