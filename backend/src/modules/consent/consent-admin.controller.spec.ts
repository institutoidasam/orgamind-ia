import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ConsentAdminController } from './consent-admin.controller';
import {
  ConsentAdminService,
  type AdminPurposeView,
  type ConsentTextView,
} from './consent-admin.service';
import {
  ConsentBulkGrantService,
  type BulkGrantResult,
} from './consent-bulk-grant.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import type { BulkGrant } from '../../schemas/contracts/consent-admin.schema';

const REQ = { user: { sub: 'user-1', email: 'a@b.c', role: 'ADMIN' } } as never;

describe('ConsentAdminController', () => {
  let admin: MockProxy<ConsentAdminService>;
  let bulk: MockProxy<ConsentBulkGrantService>;
  let controller: ConsentAdminController;

  beforeEach(() => {
    admin = mockDeep<ConsentAdminService>();
    bulk = mockDeep<ConsentBulkGrantService>();
    controller = new ConsentAdminController(admin, bulk);
  });

  it('é ADMIN-only: criar finalidade e escrever o texto de consentimento é criar a PROVA', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ConsentAdminController)).toEqual([
      'ADMIN',
    ]);
  });

  it('GET /consent/purposes/all lista todas (inclusive inativas)', async () => {
    const purposes = [{ key: 'continuum_avisos' }] as AdminPurposeView[];
    admin.listPurposes.mockResolvedValue(purposes);

    await expect(controller.listAll()).resolves.toBe(purposes);
  });

  it('POST /consent/purposes cria a finalidade com o operador como ator', async () => {
    const view = { key: 'continuum_avisos' } as AdminPurposeView;
    admin.createPurpose.mockResolvedValue(view);
    const dto = {
      key: 'continuum_avisos',
      label: 'Avisos do CONTINUUM',
      description: 'Comunicados do programa.',
      isSensitive: false,
      active: true,
    };

    await expect(controller.createPurpose(dto, REQ)).resolves.toBe(view);
    expect(admin.createPurpose).toHaveBeenCalledWith(dto, 'user-1');
  });

  it('PATCH /consent/purposes/:key edita a finalidade', async () => {
    const view = { key: 'continuum_avisos' } as AdminPurposeView;
    admin.updatePurpose.mockResolvedValue(view);

    await expect(
      controller.updatePurpose('continuum_avisos', { active: false }, REQ),
    ).resolves.toBe(view);
    expect(admin.updatePurpose).toHaveBeenCalledWith(
      'continuum_avisos',
      { active: false },
      'user-1',
    );
  });

  it('DELETE /consent/purposes/:key apaga a finalidade sem uso', async () => {
    await controller.deletePurpose('continuum_avisos', REQ);
    expect(admin.deletePurpose).toHaveBeenCalledWith(
      'continuum_avisos',
      'user-1',
    );
  });

  it('POST /consent/texts publica uma nova versão do texto', async () => {
    const text = { id: 'ct2', version: 'optin-continuum-v1' } as ConsentTextView;
    admin.publishText.mockResolvedValue(text);
    const dto = {
      purposeKey: 'continuum_avisos',
      version: 'optin-continuum-v1',
      body: 'Autorizo o CONTINUUM…',
    };

    await expect(controller.publishText(dto, REQ)).resolves.toBe(text);
    expect(admin.publishText).toHaveBeenCalledWith(dto, 'user-1');
  });
});

describe('ConsentAdminController — bulk-grant', () => {
  let admin: MockProxy<ConsentAdminService>;
  let bulk: MockProxy<ConsentBulkGrantService>;
  let controller: ConsentAdminController;

  const dto: BulkGrant = {
    purposeKey: 'continuum_avisos',
    filters: { combinator: 'and', rules: [] },
    evidenceRef: 'Contrato CONTINUUM #123',
    collectedAt: new Date('2025-03-12'),
  };

  const result: BulkGrantResult = {
    total: 10,
    granted: 8,
    skippedSuppressed: 1,
    alreadyGranted: 1,
    failed: 0,
  };

  beforeEach(() => {
    admin = mockDeep<ConsentAdminService>();
    bulk = mockDeep<ConsentBulkGrantService>();
    controller = new ConsentAdminController(admin, bulk);
  });

  it('POST /consent/bulk-grant registra com o operador identificado', async () => {
    bulk.apply.mockResolvedValue(result);

    await expect(controller.bulkGrant(dto, REQ)).resolves.toBe(result);
    // O ator vai para a evidência e para a auditoria: o registro fica gravado
    // com a identificação de quem declarou.
    expect(bulk.apply).toHaveBeenCalledWith(dto, {
      id: 'user-1',
      email: 'a@b.c',
    });
  });

  it('POST /consent/bulk-grant/preview conta sem gravar', async () => {
    bulk.preview.mockResolvedValue(result);

    await expect(controller.bulkGrantPreview(dto)).resolves.toBe(result);
    expect(bulk.preview).toHaveBeenCalledWith(dto);
    expect(bulk.apply).not.toHaveBeenCalled();
  });
});
