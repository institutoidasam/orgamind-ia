import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { ContactsExportService } from './contacts-export.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';

/**
 * Pure dispatch tests — verify each controller route forwards to the
 * matching service method with the expected arguments. Decorators
 * (Roles, ApiOperation) are a Nest concern and not exercised here.
 */
describe('ContactsController', () => {
  let controller: ContactsController;
  let contacts: MockProxy<ContactsService>;
  let exportService: MockProxy<ContactsExportService>;

  beforeEach(() => {
    contacts = mockDeep<ContactsService>();
    exportService = mockDeep<ContactsExportService>();
    controller = new ContactsController(contacts, exportService);
  });

  it('list forwards query to contacts.list', () => {
    contacts.list.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    } as never);
    const q = { page: 1, pageSize: 50 } as never;
    controller.list(q);
    expect(contacts.list).toHaveBeenCalledWith(q);
  });

  it('facets delegates to contacts.facets', () => {
    contacts.facets.mockResolvedValue({} as never);
    controller.facets();
    expect(contacts.facets).toHaveBeenCalledTimes(1);
  });

  it('create forwards body to contacts.create', () => {
    contacts.create.mockResolvedValue({ id: 'c1' } as never);
    const body = { phone: '+5592987654321', name: 'Alice' } as never;
    controller.create(body);
    expect(contacts.create).toHaveBeenCalledWith(body);
  });

  it('export forwards id to contacts.exportData', () => {
    contacts.exportData.mockResolvedValue({} as never);
    controller.export('c1');
    expect(contacts.exportData).toHaveBeenCalledWith('c1');
  });

  it('update forwards id + body to contacts.update', () => {
    contacts.update.mockResolvedValue({ id: 'c1' } as never);
    const body = { name: 'Bob' } as never;
    controller.update('c1', body);
    expect(contacts.update).toHaveBeenCalledWith('c1', body);
  });

  it('bulkDelete forwards body to contacts.bulkDelete', () => {
    contacts.bulkDelete.mockResolvedValue({ deleted: 0 } as never);
    const body = { ids: ['a', 'b'] } as never;
    controller.bulkDelete(body);
    expect(contacts.bulkDelete).toHaveBeenCalledWith(body);
  });

  it('não expõe mais o endpoint validate-whatsapp (removido em favor de POST /contacts/sync)', () => {
    expect(
      (controller as unknown as Record<string, unknown>).validateWhatsapp,
    ).toBeUndefined();
  });

  describe('POST /contacts/sync', () => {
    it('delegates to service.syncBackfill with mode', async () => {
      contacts.syncBackfill = vi
        .fn()
        .mockResolvedValue({ enqueued: 3, mode: 'unvalidated' });
      const result = await controller.syncBackfill({ mode: 'unvalidated' } as never);
      expect(contacts.syncBackfill).toHaveBeenCalledWith('unvalidated');
      expect(result).toEqual({ enqueued: 3, mode: 'unvalidated' });
    });
  });

  it('setContactLabels forwards id and labelIds (extracted from body) to contacts.setLabels', () => {
    contacts.setLabels.mockResolvedValue({ id: 'c1' } as never);
    controller.setContactLabels('c1', { labelIds: ['l1', 'l2'] });
    expect(contacts.setLabels).toHaveBeenCalledWith('c1', ['l1', 'l2']);
  });

  it('delete forwards id to contacts.delete', () => {
    contacts.delete.mockResolvedValue({ id: 'c1' } as never);
    controller.delete('c1');
    expect(contacts.delete).toHaveBeenCalledWith('c1');
  });

  it('DELETE /contacts/:id (LGPD hard erasure) is gated @Roles(ADMIN), like bulk-delete', () => {
    // Single-contact erasure is as destructive as bulk-delete (real
    // prisma.contact.delete with message cascade); it must not be reachable
    // by a plain OPERATOR one id at a time.
    const roles = Reflect.getMetadata(ROLES_KEY, controller.delete);
    expect(roles).toEqual(['ADMIN']);
  });

  it('sync/progress converte o `since` (string ISO) para Date e repassa ao serviço', async () => {
    contacts.syncProgress = vi
      .fn()
      .mockResolvedValue({ checked: 10, unvalidated: 90 });
    const since = '2026-08-24T12:00:00.000Z';
    const r = await controller.syncProgress({ since } as never);
    expect(contacts.syncProgress).toHaveBeenCalledWith(new Date(since));
    expect(r).toEqual({ checked: 10, unvalidated: 90 });
  });

  describe('GET /contacts/export.xlsx', () => {
    it('repassa a query e o `res` para o serviço de export', async () => {
      exportService.streamXlsx.mockResolvedValue(42);
      const res = {} as never;
      await controller.exportXlsx({ validity: 'invalid' } as never, res);
      expect(exportService.streamXlsx).toHaveBeenCalledWith(
        { validity: 'invalid' },
        res,
      );
    });

    // A planilha é dado pessoal em volume. ADMIN, sempre.
    it('a rota exige ADMIN', () => {
      expect(Reflect.getMetadata(ROLES_KEY, controller.exportXlsx)).toEqual([
        'ADMIN',
      ]);
    });
  });
});
