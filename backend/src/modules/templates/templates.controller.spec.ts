import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { Reflector } from '@nestjs/core';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { routesOf } from '../../../test/routes-of';

/**
 * Each route is a thin pass-through to TemplatesService — verify dispatch.
 */
describe('TemplatesController', () => {
  let controller: TemplatesController;
  let templates: MockProxy<TemplatesService>;

  beforeEach(() => {
    templates = mockDeep<TemplatesService>();
    controller = new TemplatesController(templates);
  });

  // R5: criar/sincronizar/enviar templates de Twilio, Zernio e Meta saiu do HTTP.
  it('não expõe as rotas de Meta, Twilio e Zernio', () => {
    const routes = routesOf(TemplatesController);
    for (const removed of [
      'POST /sync',
      'POST /sync/zernio',
      'POST /zernio',
      'POST /twilio',
      'POST /:id/twilio-submit',
      'PATCH /:id/twilio-draft',
    ]) {
      expect(routes).not.toContain(removed);
    }
  });

  it('mantém as rotas de Evolution (listar, criar, editar, apagar)', () => {
    expect(routesOf(TemplatesController)).toEqual(
      expect.arrayContaining([
        'GET /',
        'POST /',
        'PATCH /:id',
        'DELETE /:id',
        'GET /consent-buttons',
        'PATCH /:id/consent-buttons',
      ]),
    );
  });

  it('list delegates to templates.list', () => {
    templates.list.mockResolvedValue([] as never);
    controller.list({} as never);
    expect(templates.list).toHaveBeenCalledTimes(1);
    expect(templates.list).toHaveBeenCalledWith(undefined);
  });

  it('list forwards a provider filter from the query to templates.list', () => {
    templates.list.mockResolvedValue([] as never);
    controller.list({ provider: 'EVOLUTION' } as never);
    expect(templates.list.mock.calls).toEqual([['EVOLUTION']]);
  });

  // twilio-platform T3 — the controller must not strip the approval-sync
  // fields (twilioApprovalStatus, twilioRejectionReason, lastTwilioSyncAt):
  // they reach the HTTP response exactly as the service returns them.
  it('list passes the Twilio approval-sync fields through to the response', async () => {
    const syncedAt = new Date('2026-07-10T12:00:00.000Z');
    templates.list.mockResolvedValue([
      {
        id: 't1',
        metaName: 'convite_apoiadores',
        status: 'PAUSED',
        provider: 'TWILIO',
        twilioApprovalStatus: 'paused',
        twilioRejectionReason: 'Pausado pela Meta',
        lastTwilioSyncAt: syncedAt,
      },
    ] as never);

    const result = await controller.list({} as never);

    expect(result[0]).toMatchObject({
      twilioApprovalStatus: 'paused',
      twilioRejectionReason: 'Pausado pela Meta',
      lastTwilioSyncAt: syncedAt,
    });
  });

  it('list is not role-gated (stays open)', () => {
    const reflector = new Reflector();
    const roles = reflector.get<string[]>(ROLES_KEY, controller.list);
    expect(roles).toBeUndefined();
  });

  it('create forwards body to templates.create', () => {
    templates.create.mockResolvedValue({ id: 't1' } as never);
    const body = {
      metaName: 'x',
      language: 'pt_BR',
      body: 'hi',
      category: 'UTILITY',
    } as never;
    controller.create(body);
    expect(templates.create).toHaveBeenCalledWith(body);
  });

  it('update forwards id + body to templates.update', () => {
    templates.update.mockResolvedValue({ id: 't1' } as never);
    const body = { language: 'en_US' } as never;
    controller.update('t1', body);
    expect(templates.update).toHaveBeenCalledWith('t1', body);
  });

  it('delete forwards id to templates.delete', () => {
    templates.delete.mockResolvedValue({ id: 't1' } as never);
    controller.delete('t1');
    expect(templates.delete).toHaveBeenCalledWith('t1');
  });
});
