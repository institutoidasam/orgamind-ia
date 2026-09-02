import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { CampaignsController } from './campaigns.controller';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import type { CampaignsService } from './campaigns.service';

/**
 * Build a CampaignsService stub with only the methods a given test exercises.
 * The controller is a thin delegation layer, so unit tests assert it forwards
 * the right arguments to the service rather than re-testing business logic.
 */
function makeService(
  overrides: Partial<Record<keyof CampaignsService, unknown>> = {},
): CampaignsService {
  return overrides as unknown as CampaignsService;
}

describe('CampaignsController', () => {
  it('POST /campaigns/preflight-checks delegates to service.preflightChecks', async () => {
    const svc = makeService({
      preflightChecks: vi.fn().mockResolvedValue({
        recipients: 1,
        reachability: { total: 1, reachable: 1, invalid: 0, unknown: 0 },
        checks: [],
      }),
    });
    const ctrl = new CampaignsController(svc);
    const body = {
      filters: { combinator: 'and', rules: [] },
      defaultInstanceId: 'i1',
      schedule: { type: 'IMMEDIATE' },
      timezone: 'America/Sao_Paulo',
    };
    const res = await ctrl.preflightChecks(body as any);
    expect(svc.preflightChecks).toHaveBeenCalled();
    expect(res).toHaveProperty('checks');
  });

  it('gates POST /campaigns (create) behind @Roles(ADMIN) so operators cannot schedule mass sends', () => {
    const reflector = new Reflector();
    const roles = reflector.getAllAndOverride(ROLES_KEY, [
      CampaignsController.prototype.create,
      CampaignsController,
    ]);
    // A scheduled campaign is auto-dispatched by CAMPAIGN_SCHEDULER without ever
    // passing through the ADMIN-gated run(), so create() must itself require ADMIN.
    expect(roles).toEqual(['ADMIN']);
  });

  // ── "Disparar novamente" — default unreached, resendToAll explícito ───────
  describe('POST /campaigns/:id/redispatch', () => {
    it('sem body, delega resendToAll=false (retrocompatível)', async () => {
      const redispatchCampaign = vi.fn().mockResolvedValue({ queued: 3 });
      const ctrl = new CampaignsController(
        makeService({ redispatchCampaign }),
      );

      const res = await ctrl.redispatch('c1', { resendToAll: false } as any);

      expect(redispatchCampaign).toHaveBeenCalledWith('c1', false);
      expect(res).toEqual({ queued: 3 });
    });

    it('com resendToAll:true no body, delega true', async () => {
      const redispatchCampaign = vi.fn().mockResolvedValue({ queued: 10 });
      const ctrl = new CampaignsController(
        makeService({ redispatchCampaign }),
      );

      await ctrl.redispatch('c1', { resendToAll: true } as any);

      expect(redispatchCampaign).toHaveBeenCalledWith('c1', true);
    });

    it('é ADMIN-only', () => {
      const reflector = new Reflector();
      const roles = reflector.getAllAndOverride(ROLES_KEY, [
        CampaignsController.prototype.redispatch,
        CampaignsController,
      ]);
      expect(roles).toEqual(['ADMIN']);
    });
  });

  // ── ZE — lotes ────────────────────────────────────────────────────────────
  describe('ZE — lotes', () => {
    it('POST /campaigns/:id/batches delega para service.sendBatch com o tamanho pedido', async () => {
      const svc = makeService({
        sendBatch: vi.fn().mockResolvedValue({
          batchId: 'b1',
          seq: 1,
          requested: 50,
          queued: 50,
          skipped: 0,
          remaining: 70,
        }),
      });
      const ctrl = new CampaignsController(svc);

      const res = await ctrl.sendBatch('camp1', { size: 50 } as never);

      expect(svc.sendBatch).toHaveBeenCalledWith('camp1', 50);
      expect(res).toMatchObject({ queued: 50, remaining: 70 });
    });

    it('GET /campaigns/:id/batch-summary delega para service.batchSummary', async () => {
      const svc = makeService({
        batchSummary: vi.fn().mockResolvedValue({ total: 120, pending: 70 }),
      });
      const ctrl = new CampaignsController(svc);

      await ctrl.batchSummary('camp1');

      expect(svc.batchSummary).toHaveBeenCalledWith('camp1');
    });

    it('GET /campaigns/:id/batches delega para service.listBatches', async () => {
      const svc = makeService({ listBatches: vi.fn().mockResolvedValue([]) });
      const ctrl = new CampaignsController(svc);

      await ctrl.listBatches('camp1');

      expect(svc.listBatches).toHaveBeenCalledWith('camp1');
    });

    it('gates POST /:id/batches behind @Roles(ADMIN) — um lote é um disparo real', () => {
      const reflector = new Reflector();
      const roles = reflector.getAllAndOverride(ROLES_KEY, [
        CampaignsController.prototype.sendBatch,
        CampaignsController,
      ]);
      expect(roles).toEqual(['ADMIN']);
    });
  });
  /**
   * APAGAR CAMPANHA. É o endpoint mais destrutivo da API: o CASCADE leva junto as
   * Message da campanha, que são as bolhas do inbox. ADMIN-only, e o mapeamento
   * fica travado aqui — um @Delete apontando para o método errado apagaria coisa
   * que ninguém pediu.
   */
  describe('DELETE /campaigns/:id', () => {
    it('delega para service.remove', async () => {
      const remove = vi.fn().mockResolvedValue({ deleted: true, id: 'c1' });
      const ctrl = new CampaignsController(makeService({ remove }));

      await expect(ctrl.remove('c1')).resolves.toEqual({
        deleted: true,
        id: 'c1',
      });
      expect(remove).toHaveBeenCalledWith('c1');
    });

    it('é ADMIN-only', () => {
      const reflector = new Reflector();
      const roles = reflector.getAllAndOverride(ROLES_KEY, [
        CampaignsController.prototype.remove,
        CampaignsController,
      ]);
      expect(roles).toEqual(['ADMIN']);
    });
  });

  /**
   * F1 T9 — o aviso de "apagar campanha" (segmentos dependentes). Não é
   * ADMIN-only: é só leitura, mesma política de preflight/waiting/batch-summary.
   */
  describe('GET /campaigns/:id/dependent-segments', () => {
    it('delega para service.getDependentSegments', async () => {
      const getDependentSegments = vi
        .fn()
        .mockResolvedValue([{ id: 'seg-1', name: 'Já receberam a X' }]);
      const ctrl = new CampaignsController(
        makeService({ getDependentSegments }),
      );

      const res = await ctrl.dependentSegments('c1');

      expect(getDependentSegments).toHaveBeenCalledWith('c1');
      expect(res).toEqual([{ id: 'seg-1', name: 'Já receberam a X' }]);
    });
  });

  /**
   * F2 T7 — o painel "por que falhou". Só leitura, mesma política de
   * preflight/waiting/batch-summary/dependent-segments (não é @Roles('ADMIN')).
   */
  describe('GET /campaigns/:id/failure-reasons', () => {
    it('delega para service.getFailureReasons', async () => {
      const getFailureReasons = vi.fn().mockResolvedValue([
        {
          failureReason: 'OPT_OUT',
          count: 5,
          label: 'Destinatário optou por sair (opt-out)',
        },
      ]);
      const ctrl = new CampaignsController(makeService({ getFailureReasons }));

      const res = await ctrl.failureReasons('c1');

      expect(getFailureReasons).toHaveBeenCalledWith('c1');
      expect(res).toEqual([
        {
          failureReason: 'OPT_OUT',
          count: 5,
          label: 'Destinatário optou por sair (opt-out)',
        },
      ]);
    });
  });
});
