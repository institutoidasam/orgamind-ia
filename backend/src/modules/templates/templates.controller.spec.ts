import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { Reflector } from '@nestjs/core';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';

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

  it('list delegates to templates.list', () => {
    templates.list.mockResolvedValue([] as never);
    controller.list({} as never);
    expect(templates.list).toHaveBeenCalledTimes(1);
    expect(templates.list).toHaveBeenCalledWith(undefined);
  });

  it('list forwards a provider filter from the query to templates.list', () => {
    templates.list.mockResolvedValue([] as never);
    controller.list({ provider: 'TWILIO' } as never);
    expect(templates.list).toHaveBeenCalledWith('TWILIO');
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

  it('sync delegates to templates.syncFromMeta', () => {
    templates.syncFromMeta.mockResolvedValue({ synced: 0, skipped: 0 } as never);
    controller.sync();
    expect(templates.syncFromMeta).toHaveBeenCalledTimes(1);
  });

  it('sync is gated to ADMIN via @Roles', () => {
    const reflector = new Reflector();
    const roles = reflector.get<string[]>(ROLES_KEY, controller.sync);
    expect(roles).toEqual(['ADMIN']);
  });

  it('syncZernio delegates to templates.syncFromZernio', () => {
    templates.syncFromZernio.mockResolvedValue({
      synced: 0,
      skipped: 0,
    } as never);
    controller.syncZernio();
    expect(templates.syncFromZernio).toHaveBeenCalledTimes(1);
  });

  it('syncZernio is gated to ADMIN via @Roles', () => {
    const reflector = new Reflector();
    const roles = reflector.get<string[]>(ROLES_KEY, controller.syncZernio);
    expect(roles).toEqual(['ADMIN']);
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

  // twilio-platform T4 — criar/submeter/editar rascunho Twilio.
  it('createTwilio delegates body to templates.createTwilio', () => {
    templates.createTwilio.mockResolvedValue({ id: 't1' } as never);
    const body = {
      contentType: 'twilio/text',
      name: 'aviso',
      language: 'pt_BR',
      category: 'MARKETING',
      body: 'Olá {{1}}, tudo bem?',
      variables: { '1': 'João' },
    } as never;
    controller.createTwilio(body);
    expect(templates.createTwilio).toHaveBeenCalledWith(body);
  });

  it('createTwilio is gated to ADMIN via @Roles', () => {
    const reflector = new Reflector();
    const roles = reflector.get<string[]>(ROLES_KEY, controller.createTwilio);
    expect(roles).toEqual(['ADMIN']);
  });

  it('submitTwilio forwards id to templates.submitTwilioApproval', () => {
    templates.submitTwilioApproval.mockResolvedValue({ id: 't1' } as never);
    controller.submitTwilio('t1');
    expect(templates.submitTwilioApproval).toHaveBeenCalledWith('t1');
  });

  it('submitTwilio is gated to ADMIN via @Roles', () => {
    const reflector = new Reflector();
    const roles = reflector.get<string[]>(ROLES_KEY, controller.submitTwilio);
    expect(roles).toEqual(['ADMIN']);
  });

  it('updateTwilioDraft forwards id + body to templates.updateTwilioDraft', () => {
    templates.updateTwilioDraft.mockResolvedValue({ id: 't1' } as never);
    const body = {
      contentType: 'twilio/text',
      language: 'pt_BR',
      category: 'MARKETING',
      body: 'Novo corpo, ok.',
      variables: {},
    } as never;
    controller.updateTwilioDraft('t1', body);
    expect(templates.updateTwilioDraft).toHaveBeenCalledWith('t1', body);
  });

  it('updateTwilioDraft is gated to ADMIN via @Roles', () => {
    const reflector = new Reflector();
    const roles = reflector.get<string[]>(
      ROLES_KEY,
      controller.updateTwilioDraft,
    );
    expect(roles).toEqual(['ADMIN']);
  });
});
