import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { TemplatesService } from './templates.service';
import { TemplatesRepository } from './templates.repository';
import {
  MetaCredentialsNotConfiguredError,
  TemplateInUseError,
  TemplateMetaNameConflictError,
  TemplateNotFoundError,
  ZernioCredentialsNotConfiguredError,
} from './errors/templates.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { ValidationError } from '../../shared/errors/domain.error';
import { TwilioContentService } from '../whatsapp-providers/twilio-content.service';
import { ZernioTemplateService } from '../whatsapp-providers/zernio-template.service';
import {
  TemplateActiveCampaignError,
  TemplateNotDraftError,
  TemplateNotTwilioError,
} from './errors/templates.errors';
import type { Env } from '../../shared/config/env.schema';

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

describe('TemplatesService', () => {
  let service: TemplatesService;
  let repo: MockProxy<TemplatesRepository>;
  let config: MockProxy<ConfigService<Env>>;
  let audit: MockProxy<AuditService>;
  let twilioContent: MockProxy<TwilioContentService>;
  let zernioTemplates: MockProxy<ZernioTemplateService>;

  beforeEach(() => {
    repo = mockDeep<TemplatesRepository>();
    config = mockDeep<ConfigService<Env>>();
    audit = mockDeep<AuditService>();
    twilioContent = mockDeep<TwilioContentService>();
    zernioTemplates = mockDeep<ZernioTemplateService>();
    // `configured` é readonly na classe — o mock precisa do valor explícito, e
    // configurable para que o teste de "sem credencial" possa desligá-lo.
    Object.defineProperty(zernioTemplates, 'configured', {
      value: true,
      configurable: true,
    });
    service = new TemplatesService(
      repo,
      config,
      audit,
      twilioContent,
      zernioTemplates,
    );
    // axios is a module-level mock — reset it so call-count/ordering assertions
    // (pagination tests) don't see leaked calls from earlier tests.
    vi.mocked(axios.get).mockReset();
  });

  it('list delegates to repo.listAll()', async () => {
    repo.listAll.mockResolvedValue([]);
    const result = await service.list();
    expect(result).toEqual([]);
    expect(repo.listAll).toHaveBeenCalledTimes(1);
  });

  it('list forwards the provider filter to repo.listAll()', async () => {
    repo.listAll.mockResolvedValue([]);
    await service.list('TWILIO' as never);
    expect(repo.listAll).toHaveBeenCalledWith('TWILIO');
  });

  it('list calls repo.listAll() with undefined when no provider filter given', async () => {
    repo.listAll.mockResolvedValue([]);
    await service.list();
    expect(repo.listAll).toHaveBeenCalledWith(undefined);
  });

  // twilio-platform T3 — the approval-sync columns written by the 2-min job
  // (twilioApprovalStatus raw, twilioRejectionReason, lastTwilioSyncAt) must
  // flow untouched through list() so the frontend catalog can render them.
  it('list returns the Twilio approval-sync fields untouched', async () => {
    const syncedAt = new Date('2026-07-10T12:00:00.000Z');
    const row = {
      id: 't1',
      metaName: 'convite_apoiadores',
      status: 'REJECTED',
      provider: 'TWILIO',
      twilioApprovalStatus: 'rejected',
      twilioRejectionReason: 'Categoria incorreta',
      lastTwilioSyncAt: syncedAt,
    };
    repo.listAll.mockResolvedValue([row as never]);

    const result = await service.list();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      twilioApprovalStatus: 'rejected',
      twilioRejectionReason: 'Categoria incorreta',
      lastTwilioSyncAt: syncedAt,
    });
  });

  it('syncFromMeta throws MetaCredentialsNotConfiguredError when env missing', async () => {
    config.get.mockReturnValue(undefined);
    await expect(service.syncFromMeta()).rejects.toThrow(
      MetaCredentialsNotConfiguredError,
    );
  });

  describe('create', () => {
    it('extracts positional variables from body and persists them', async () => {
      repo.findByMetaName.mockResolvedValue(null);
      repo.create.mockImplementation(
        async (data) =>
          ({
            id: 't1',
            createdAt: new Date(),
            ...data,
          }) as never,
      );

      const result = await service.create({
        metaName: 'boas_vindas',
        language: 'pt_BR',
        body: 'Olá {{1}}, sua cidade é {{2}}',
        category: 'MARKETING',
      });

      expect(result.variables).toEqual(['1', '2']);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metaName: 'boas_vindas',
          variables: ['1', '2'],
          status: 'APPROVED',
          category: 'MARKETING',
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        'template.create',
        'Template',
        't1',
        expect.objectContaining({ metaName: 'boas_vindas' }),
      );
    });

    it('extracts named variables from body', async () => {
      repo.findByMetaName.mockResolvedValue(null);
      repo.create.mockImplementation(
        async (data) =>
          ({
            id: 't1',
            createdAt: new Date(),
            ...data,
          }) as never,
      );

      const result = await service.create({
        metaName: 'welcome',
        language: 'pt_BR',
        body: 'Olá {{name}}, bem-vindo à {{city}}!',
        category: 'UTILITY',
      });

      expect(result.variables).toEqual(['name', 'city']);
    });

    it('throws TemplateMetaNameConflictError when metaName exists', async () => {
      repo.findByMetaName.mockResolvedValue({ id: 'existing' } as never);
      await expect(
        service.create({
          metaName: 'taken',
          language: 'pt_BR',
          body: 'Hello',
          category: 'UTILITY',
        }),
      ).rejects.toThrow(TemplateMetaNameConflictError);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('persists twilioContentSid when provided', async () => {
      const HX = 'HX0123456789abcdef0123456789abcdef';
      repo.findByMetaName.mockResolvedValue(null);
      repo.create.mockImplementation(
        async (data) =>
          ({
            id: 't1',
            createdAt: new Date(),
            ...data,
          }) as never,
      );

      await service.create({
        metaName: 'oficial_cold',
        language: 'pt_BR',
        body: 'Olá',
        category: 'UTILITY',
        provider: 'TWILIO',
        twilioContentSid: HX,
      } as never);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ twilioContentSid: HX, provider: 'TWILIO' }),
      );
    });
  });

  describe('create — provider', () => {
    beforeEach(() => {
      repo.findByMetaName.mockResolvedValue(null);
      repo.create.mockImplementation(
        async (data) => ({ id: 't1', createdAt: new Date(), ...data }) as never,
      );
    });

    it('defaults provider to EVOLUTION when omitted', async () => {
      const result = await service.create({
        metaName: 'boas_vindas',
        language: 'pt_BR',
        body: 'Olá',
        category: 'UTILITY',
      } as never);

      expect(result.provider).toBe('EVOLUTION');
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'EVOLUTION' }),
      );
    });

    // ZB — este teste usava ZERNIO, que agora é RECUSADO por aqui (o caminho
    // genérico gravava APPROVED sem falar com a Meta; ver o describe "create
    // (genérico) — a armadilha antiga"). META continua sendo um provider
    // explícito válido para a criação manual.
    it('persists an explicit provider', async () => {
      const result = await service.create({
        metaName: 'meta_tpl',
        language: 'pt_BR',
        body: 'Olá',
        category: 'UTILITY',
        provider: 'META',
      } as never);

      expect(result.provider).toBe('META');
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'META' }),
      );
    });

    it('response includes provider', async () => {
      const result = await service.create({
        metaName: 'meta_tpl',
        language: 'pt_BR',
        body: 'Olá',
        category: 'UTILITY',
        provider: 'META',
      } as never);

      expect(result).toHaveProperty('provider', 'META');
    });
  });

  describe('update', () => {
    it('re-extracts variables when body changes', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'old',
        metaName: 'x',
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.update('t1', { body: 'New {{1}} and {{2}} and {{3}}' });

      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          body: 'New {{1}} and {{2}} and {{3}}',
          variables: ['1', '2', '3'],
        }),
      );
    });

    it('does not re-extract variables when body is unchanged', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'same body {{1}}',
        metaName: 'x',
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.update('t1', { language: 'en_US' });

      const call = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(call.variables).toBeUndefined();
      expect(call.language).toBe('en_US');
    });

    it('throws TemplateNotFoundError when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update('missing', { body: 'x' })).rejects.toThrow(
        TemplateNotFoundError,
      );
    });
  });

  describe('update — provider', () => {
    it('persists an explicit provider change', async () => {
      // ZERNIO NÃO entra aqui, de propósito — ver "a row ZERNIO forjada por
      // PATCH" abaixo: virar ZERNIO por edição criava uma row "aprovada" de um
      // template que a Meta nunca viu.
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'x',
        metaName: 'x',
        provider: 'EVOLUTION',
        twilioContentSid: null,
      } as never);
      repo.update.mockResolvedValue({ id: 't1', provider: 'META' } as never);

      await service.update('t1', { provider: 'META' } as never);

      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ provider: 'META' }),
      );
    });

    it('leaves provider untouched when not supplied', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'x',
        metaName: 'x',
        provider: 'EVOLUTION',
        twilioContentSid: null,
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.update('t1', { language: 'en_US' });

      const call = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect('provider' in call).toBe(false);
    });

    it('throws when switching to TWILIO without a twilioContentSid (effective value), PT-BR message', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'x',
        metaName: 'x',
        provider: 'EVOLUTION',
        twilioContentSid: null,
      } as never);

      const err = await service
        .update('t1', { provider: 'TWILIO' } as never)
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe(
        'template.twilio_content_sid_required',
      );
      expect((err as ValidationError).message).toMatch(/TWILIO/);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('allows switching to TWILIO when twilioContentSid is supplied in the same request', async () => {
      const HX = 'HX0123456789abcdef0123456789abcdef';
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'x',
        metaName: 'x',
        provider: 'EVOLUTION',
        twilioContentSid: null,
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.update('t1', {
        provider: 'TWILIO',
        twilioContentSid: HX,
      } as never);

      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ provider: 'TWILIO', twilioContentSid: HX }),
      );
    });

    it('allows switching to TWILIO when the row already has a twilioContentSid', async () => {
      const HX = 'HX0123456789abcdef0123456789abcdef';
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'x',
        metaName: 'x',
        provider: 'EVOLUTION',
        twilioContentSid: HX,
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.update('t1', { provider: 'TWILIO' } as never);

      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ provider: 'TWILIO' }),
      );
    });

    it('throws when setting twilioContentSid on a non-TWILIO template (effective provider), PT-BR message', async () => {
      const HX = 'HX0123456789abcdef0123456789abcdef';
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'x',
        metaName: 'x',
        provider: 'EVOLUTION',
        twilioContentSid: null,
      } as never);

      const err = await service
        .update('t1', { twilioContentSid: HX } as never)
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe(
        'template.twilio_content_sid_not_allowed',
      );
      expect((err as ValidationError).message).toMatch(/TWILIO/);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('throws when clearing provider away from TWILIO while twilioContentSid stays set', async () => {
      const HX = 'HX0123456789abcdef0123456789abcdef';
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'x',
        metaName: 'x',
        provider: 'TWILIO',
        twilioContentSid: HX,
      } as never);

      const err = await service
        .update('t1', { provider: 'EVOLUTION' } as never)
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe(
        'template.twilio_content_sid_not_allowed',
      );
    });

    it('throws when clearing twilioContentSid on a template that stays TWILIO', async () => {
      const HX = 'HX0123456789abcdef0123456789abcdef';
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'x',
        metaName: 'x',
        provider: 'TWILIO',
        twilioContentSid: HX,
      } as never);

      const err = await service
        .update('t1', { twilioContentSid: null } as never)
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe(
        'template.twilio_content_sid_required',
      );
      expect((err as ValidationError).message).toMatch(/TWILIO/);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('does not re-validate provider/twilioContentSid when neither field is touched', async () => {
      // Defensive: a legacy row could theoretically carry an inconsistent
      // combo pre-dating this validation; an unrelated field update (e.g.
      // language) must not be blocked by it.
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'x',
        metaName: 'x',
        provider: 'EVOLUTION',
        twilioContentSid: 'HX0123456789abcdef0123456789abcdef',
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.update('t1', { language: 'en_US' });

      expect(repo.update).toHaveBeenCalled();
    });
  });

  // ★ A PORTA LATERAL: o create recusa ZERNIO, mas o PATCH aceitava provider+status.
  describe('update — a row ZERNIO forjada por PATCH', () => {
    it('recusa transformar um template em ZERNIO por edição', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        provider: 'EVOLUTION',
        status: 'APPROVED',
        kind: 'TEXT',
        body: 'oi',
      } as never);

      await expect(
        service.update('t1', {
          provider: 'ZERNIO',
          status: 'APPROVED',
        } as never),
      ).rejects.toThrow(ValidationError);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('recusa editar o status de uma row ZERNIO — quem aprova é a Meta', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        provider: 'ZERNIO',
        status: 'PENDING',
        kind: 'TEXT',
        body: 'oi',
      } as never);

      await expect(
        service.update('t1', { status: 'APPROVED' } as never),
      ).rejects.toThrow(ValidationError);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('mas uma edição inócua numa row ZERNIO (ex.: idioma) continua passando', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        provider: 'ZERNIO',
        status: 'APPROVED',
        kind: 'TEXT',
        body: 'oi',
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await expect(
        service.update('t1', { language: 'en_US' } as never),
      ).resolves.toBeDefined();
    });
  });

  describe('delete', () => {
    it('throws TemplateInUseError when campaigns reference the template', async () => {
      repo.findById.mockResolvedValue({ id: 't1', metaName: 'x' } as never);
      repo.findInUseByCampaigns.mockResolvedValue(2);

      await expect(service.delete('t1')).rejects.toThrow(TemplateInUseError);
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('succeeds when no campaigns reference it', async () => {
      repo.findById.mockResolvedValue({ id: 't1', metaName: 'x' } as never);
      repo.findInUseByCampaigns.mockResolvedValue(0);
      repo.delete.mockResolvedValue({ id: 't1' } as never);

      await service.delete('t1');

      expect(repo.delete).toHaveBeenCalledWith('t1');
      expect(audit.log).toHaveBeenCalledWith(
        'template.delete',
        'Template',
        't1',
        { metaName: 'x' },
      );
    });

    it('throws TemplateNotFoundError when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.delete('missing')).rejects.toThrow(
        TemplateNotFoundError,
      );
    });
  });

  describe('create — interactive kinds', () => {
    beforeEach(() => {
      repo.findByMetaName.mockResolvedValue(null);
      repo.create.mockImplementation(
        async (data) => ({ id: 't1', createdAt: new Date(), ...data }) as never,
      );
    });

    it('LIST kind extracts variables from every operator-authored string', async () => {
      const interactiveConfig = {
        title: 'Hello {{name}}',
        description: 'Pick from {{city}}',
        buttonText: 'Open',
        sections: [
          {
            title: 'Section {{1}}',
            rows: [
              { rowId: 'r1', title: 'Row {{name}}', description: 'd {{2}}' },
              { rowId: 'r2', title: 'plain' },
            ],
          },
        ],
      };

      const result = await service.create({
        metaName: 'list_t',
        language: 'pt_BR',
        category: 'UTILITY',
        kind: 'LIST',
        interactiveConfig,
      } as never);

      // {{name}} {{city}} {{1}} {{2}} (deduped, first-seen order)
      expect(result.variables).toEqual(['name', 'city', '1', '2']);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'LIST',
          interactiveConfig: expect.objectContaining({
            title: 'Hello {{name}}',
          }),
        }),
      );
    });

    it('BUTTONS kind extracts variables from button titles + body strings', async () => {
      const interactiveConfig = {
        description: 'Confirma {{nome}}?',
        buttons: [
          { buttonId: 'yes', title: 'Sim {{1}}' },
          { buttonId: 'no', title: 'Não' },
        ],
      };
      const result = await service.create({
        metaName: 'btn_t',
        language: 'pt_BR',
        category: 'UTILITY',
        kind: 'BUTTONS',
        interactiveConfig,
      } as never);
      expect(result.variables).toEqual(['nome', '1']);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'BUTTONS' }),
      );
    });

    it('POLL kind extracts variables from question + each option', async () => {
      const interactiveConfig = {
        question: 'Qual {{1}} prefere?',
        options: ['A {{name}}', 'B'],
        selectableOptionsCount: 1,
      };
      const result = await service.create({
        metaName: 'poll_t',
        language: 'pt_BR',
        category: 'UTILITY',
        kind: 'POLL',
        interactiveConfig,
      } as never);
      expect(result.variables).toEqual(['1', 'name']);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'POLL' }),
      );
    });

    it('LIST without interactiveConfig throws template.interactive_config_required', async () => {
      await expect(
        service.create({
          metaName: 'list_no_cfg',
          language: 'pt_BR',
          category: 'UTILITY',
          kind: 'LIST',
        } as never),
      ).rejects.toMatchObject({ code: 'template.interactive_config_required' });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('LIST with invalid-shape interactiveConfig throws template.interactive_config_invalid', async () => {
      await expect(
        service.create({
          metaName: 'list_bad_cfg',
          language: 'pt_BR',
          category: 'UTILITY',
          kind: 'LIST',
          interactiveConfig: { title: '', sections: [] },
        } as never),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        service.create({
          metaName: 'list_bad_cfg2',
          language: 'pt_BR',
          category: 'UTILITY',
          kind: 'LIST',
          interactiveConfig: { title: '', sections: [] },
        } as never),
      ).rejects.toMatchObject({ code: 'template.interactive_config_invalid' });
    });
  });

  // Characterization tests locking the current behavior of
  // collectInteractiveStrings (exercised indirectly via create/update) and the
  // update variable-recompute paths — added before the complexity refactor so
  // any behavior drift fails loudly.
  describe('characterization — collectInteractiveStrings (via create)', () => {
    beforeEach(() => {
      repo.findByMetaName.mockResolvedValue(null);
      repo.create.mockImplementation(
        async (data) => ({ id: 't1', createdAt: new Date(), ...data }) as never,
      );
    });

    it('LIST includes footerText and skips empty optional strings, walking sections + rows', async () => {
      const interactiveConfig = {
        title: 'T {{title}}',
        description: 'D {{desc}}',
        buttonText: 'B {{btn}}',
        footerText: 'F {{foot}}',
        sections: [
          {
            title: 'S {{sec}}',
            rows: [
              {
                rowId: 'r1',
                title: 'R {{row}}',
                description: 'RD {{rowdesc}}',
              },
              { rowId: 'r2', title: 'plain row' }, // no description
            ],
          },
        ],
      };
      const result = await service.create({
        metaName: 'list_full',
        language: 'pt_BR',
        category: 'UTILITY',
        kind: 'LIST',
        interactiveConfig,
      } as never);
      // footerText var ({{foot}}) MUST be present; first-seen order, deduped.
      expect(result.variables).toEqual([
        'title',
        'desc',
        'btn',
        'foot',
        'sec',
        'row',
        'rowdesc',
      ]);
    });

    it('BUTTONS includes optional title + footerText when present', async () => {
      const interactiveConfig = {
        title: 'T {{title}}',
        description: 'D {{desc}}',
        footerText: 'F {{foot}}',
        buttons: [
          { buttonId: 'b1', title: 'B1 {{b1}}' },
          { buttonId: 'b2', title: 'B2 {{b2}}' },
        ],
      };
      const result = await service.create({
        metaName: 'btn_full',
        language: 'pt_BR',
        category: 'UTILITY',
        kind: 'BUTTONS',
        interactiveConfig,
      } as never);
      expect(result.variables).toEqual(['title', 'desc', 'foot', 'b1', 'b2']);
    });

    it('POLL collects question and every option in order', async () => {
      const interactiveConfig = {
        question: 'Q {{q}}',
        options: ['{{o1}}', 'plain', '{{o3}}'],
        selectableOptionsCount: 1,
      };
      const result = await service.create({
        metaName: 'poll_order',
        language: 'pt_BR',
        category: 'UTILITY',
        kind: 'POLL',
        interactiveConfig,
      } as never);
      expect(result.variables).toEqual(['q', 'o1', 'o3']);
    });
  });

  describe('update — kind transitions', () => {
    it('toggling kind from TEXT -> LIST validates the new config and re-extracts variables', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'old body',
        kind: 'TEXT',
        metaName: 'x',
        interactiveConfig: null,
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      const interactiveConfig = {
        title: 'T {{a}}',
        description: 'D',
        buttonText: 'B',
        sections: [{ title: 'S', rows: [{ rowId: 'r', title: 'r {{b}}' }] }],
      };

      await service.update('t1', {
        kind: 'LIST',
        interactiveConfig,
      } as never);

      const callArgs = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs.kind).toBe('LIST');
      expect(callArgs.variables).toEqual(['a', 'b']);
    });

    it('toggling to LIST without supplying interactiveConfig falls back to existing and re-validates', async () => {
      // existing has bad interactiveConfig — switching kind should re-validate.
      repo.findById.mockResolvedValue({
        id: 't1',
        body: '',
        kind: 'TEXT',
        metaName: 'x',
        interactiveConfig: { broken: true },
      } as never);

      await expect(
        service.update('t1', { kind: 'LIST' } as never),
      ).rejects.toMatchObject({ code: 'template.interactive_config_invalid' });
    });

    it('switching LIST -> TEXT recomputes variables from the body, dropping interactive-derived ones', async () => {
      // Existing LIST template carries variables extracted from interactive
      // strings ({{city}}, {{section}}). Switching to TEXT must drop those and
      // recompute from the (existing) body, which only references {{name}}.
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'Olá {{name}}',
        kind: 'LIST',
        metaName: 'x',
        variables: ['name', 'city', 'section'],
        interactiveConfig: { title: 'T {{city}}' },
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.update('t1', { kind: 'TEXT' } as never);

      const callArgs = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs.kind).toBe('TEXT');
      expect(callArgs.variables).toEqual(['name']);
    });

    it('updating an interactive template config in-place (no kind change) re-extracts from the new config', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        body: '',
        kind: 'LIST',
        metaName: 'x',
        variables: ['old'],
        interactiveConfig: { title: 'T {{old}}' },
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      const interactiveConfig = {
        title: 'T {{newvar}}',
        description: 'D',
        buttonText: 'B',
        sections: [{ title: 'S', rows: [{ rowId: 'r', title: 'R {{rowv}}' }] }],
      };
      await service.update('t1', { interactiveConfig });

      const callArgs = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs.kind).toBeUndefined();
      expect(callArgs.variables).toEqual(['newvar', 'rowv']);
      expect(callArgs.interactiveConfig).toEqual(
        expect.objectContaining({ title: 'T {{newvar}}' }),
      );
    });

    it('TEXT template with unchanged body and no kind change leaves variables untouched', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'Hi {{1}}',
        kind: 'TEXT',
        metaName: 'x',
        variables: ['1'],
        interactiveConfig: null,
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.update('t1', { category: 'MARKETING' } as never);

      const callArgs = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs.variables).toBeUndefined();
      expect(callArgs.category).toBe('MARKETING');
      // not touching config -> no interactiveConfig key in the update payload
      expect('interactiveConfig' in callArgs).toBe(false);
    });

    it('switching to TEXT with a new body recomputes variables from the new body', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        body: 'old',
        kind: 'BUTTONS',
        metaName: 'x',
        variables: ['stale', 'gone'],
        interactiveConfig: { description: 'Hi {{stale}}', buttons: [] },
      } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.update('t1', {
        kind: 'TEXT',
        body: 'New {{a}} and {{b}}',
      } as never);

      const callArgs = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs.kind).toBe('TEXT');
      expect(callArgs.variables).toEqual(['a', 'b']);
    });
  });

  describe('syncFromMeta', () => {
    it('upserts each template returned by Meta and audits the count', async () => {
      config.get.mockImplementation((key: string) => {
        if (key === 'META_BUSINESS_ACCOUNT_ID') return 'waba_123';
        if (key === 'META_ACCESS_TOKEN') return 'tok_abc';
        return undefined;
      });
      vi.mocked(axios.get).mockResolvedValue({
        data: {
          data: [
            {
              name: 'tpl_a',
              language: 'pt_BR',
              status: 'APPROVED',
              category: 'MARKETING',
              components: [
                { type: 'BODY', text: 'Olá {{1}}, bem-vindo' },
                { type: 'HEADER', text: 'ignored' },
              ],
            },
            {
              name: 'tpl_b',
              language: 'en_US',
              status: 'PENDING',
              components: [{ type: 'BODY', text: 'Hi {{name}}' }],
            },
            {
              name: 'tpl_c_no_body',
              language: 'pt_BR',
              status: 'APPROVED',
              category: 'UTILITY',
              components: [],
            },
          ],
        },
      });
      repo.upsertByMetaName.mockResolvedValue({ id: 't' } as never);

      const result = await service.syncFromMeta();
      expect(result).toEqual({ synced: 3, skipped: 0 });
      expect(repo.upsertByMetaName).toHaveBeenCalledTimes(3);
      expect(repo.upsertByMetaName).toHaveBeenCalledWith(
        expect.objectContaining({
          metaName: 'tpl_a',
          language: 'pt_BR',
          body: 'Olá {{1}}, bem-vindo',
          variables: ['1'],
          status: 'APPROVED',
          category: 'MARKETING',
        }),
      );
      expect(repo.upsertByMetaName).toHaveBeenCalledWith(
        expect.objectContaining({
          metaName: 'tpl_b',
          variables: ['name'],
          status: 'PENDING',
          // missing category in payload -> default UTILITY
          category: 'UTILITY',
        }),
      );
      expect(repo.upsertByMetaName).toHaveBeenCalledWith(
        expect.objectContaining({
          metaName: 'tpl_c_no_body',
          body: '',
          variables: [],
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        'template.sync',
        'Template',
        undefined,
        { synced: 3, skipped: 0 },
      );
      expect(axios.get).toHaveBeenCalledWith(
        'https://graph.facebook.com/v22.0/waba_123/message_templates',
        expect.objectContaining({
          headers: { Authorization: 'Bearer tok_abc' },
        }),
      );
    });

    it('follows data.paging.next to fetch every page of templates', async () => {
      config.get.mockImplementation((key: string) => {
        if (key === 'META_BUSINESS_ACCOUNT_ID') return 'waba_123';
        if (key === 'META_ACCESS_TOKEN') return 'tok_abc';
        return undefined;
      });
      repo.upsertByMetaName.mockResolvedValue({ id: 't' } as never);

      const nextUrl =
        'https://graph.facebook.com/v22.0/waba_123/message_templates?after=CURSOR';
      vi.mocked(axios.get)
        .mockResolvedValueOnce({
          data: {
            data: [
              {
                name: 'page1_a',
                language: 'pt_BR',
                status: 'APPROVED',
                category: 'UTILITY',
                components: [{ type: 'BODY', text: 'one' }],
              },
            ],
            paging: { next: nextUrl },
          },
        })
        .mockResolvedValueOnce({
          data: {
            data: [
              {
                name: 'page2_a',
                language: 'pt_BR',
                status: 'APPROVED',
                category: 'UTILITY',
                components: [{ type: 'BODY', text: 'two' }],
              },
            ],
            // no paging.next -> last page
          },
        });

      const result = await service.syncFromMeta();

      expect(result).toEqual({ synced: 2, skipped: 0 });
      expect(axios.get).toHaveBeenCalledTimes(2);
      // First call hits the base endpoint with a limit param.
      expect(vi.mocked(axios.get).mock.calls[0][0]).toBe(
        'https://graph.facebook.com/v22.0/waba_123/message_templates',
      );
      // Second call follows the absolute paging.next URL verbatim.
      expect(vi.mocked(axios.get).mock.calls[1][0]).toBe(nextUrl);
      expect(repo.upsertByMetaName).toHaveBeenCalledWith(
        expect.objectContaining({ metaName: 'page1_a' }),
      );
      expect(repo.upsertByMetaName).toHaveBeenCalledWith(
        expect.objectContaining({ metaName: 'page2_a' }),
      );
    });

    it('stops following pagination at the page cap to avoid an unbounded loop', async () => {
      config.get.mockImplementation((key: string) => {
        if (key === 'META_BUSINESS_ACCOUNT_ID') return 'waba_123';
        if (key === 'META_ACCESS_TOKEN') return 'tok_abc';
        return undefined;
      });
      repo.upsertByMetaName.mockResolvedValue({ id: 't' } as never);

      // Every page reports a next cursor — a misbehaving API that would loop
      // forever. The service must cap the number of pages it fetches.
      let n = 0;
      vi.mocked(axios.get).mockImplementation(async () => {
        n++;
        return {
          data: {
            data: [
              {
                name: `tpl_${n}`,
                language: 'pt_BR',
                status: 'APPROVED',
                category: 'UTILITY',
                components: [{ type: 'BODY', text: 'x' }],
              },
            ],
            paging: { next: `https://graph.facebook.com/next?p=${n}` },
          },
        };
      });

      await service.syncFromMeta();

      // Cap is 50 pages — must never exceed it even though next is always set.
      expect(vi.mocked(axios.get).mock.calls.length).toBeLessThanOrEqual(50);
      expect(vi.mocked(axios.get).mock.calls.length).toBeGreaterThan(1);
    });

    it('throws MetaCredentialsNotConfiguredError when only one of the env vars is set', async () => {
      config.get.mockImplementation((key: string) => {
        if (key === 'META_BUSINESS_ACCOUNT_ID') return 'waba_123';
        return undefined; // META_ACCESS_TOKEN missing
      });
      await expect(service.syncFromMeta()).rejects.toThrow(
        MetaCredentialsNotConfiguredError,
      );
    });

    describe('resilience (A9)', () => {
      beforeEach(() => {
        config.get.mockImplementation((key: string) => {
          if (key === 'META_BUSINESS_ACCOUNT_ID') return 'waba_123';
          if (key === 'META_ACCESS_TOKEN') return 'tok_abc';
          return undefined;
        });
        repo.upsertByMetaName.mockResolvedValue({ id: 't' } as never);
      });

      it('keeps a Meta PAUSED status as PAUSED (in-enum since twilio-platform T2)', async () => {
        vi.mocked(axios.get).mockResolvedValue({
          data: {
            data: [
              {
                name: 'tpl_paused',
                language: 'pt_BR',
                status: 'PAUSED',
                category: 'UTILITY',
                components: [{ type: 'BODY', text: 'Hi' }],
              },
            ],
          },
        });

        const result = await service.syncFromMeta();

        expect(result).toEqual({ synced: 1, skipped: 0 });
        expect(repo.upsertByMetaName).toHaveBeenCalledWith(
          expect.objectContaining({
            metaName: 'tpl_paused',
            status: 'PAUSED',
          }),
        );
      });

      it('normalizes a Meta status outside the enum (e.g. DISABLED) to a safe PENDING value', async () => {
        vi.mocked(axios.get).mockResolvedValue({
          data: {
            data: [
              {
                name: 'tpl_disabled',
                language: 'pt_BR',
                status: 'DISABLED', // not in PENDING/APPROVED/REJECTED/PAUSED
                category: 'UTILITY',
                components: [{ type: 'BODY', text: 'Hi' }],
              },
            ],
          },
        });

        const result = await service.syncFromMeta();

        expect(result).toEqual({ synced: 1, skipped: 0 });
        expect(repo.upsertByMetaName).toHaveBeenCalledWith(
          expect.objectContaining({
            metaName: 'tpl_disabled',
            status: 'PENDING',
          }),
        );
      });

      it('normalizes a legacy/unknown category (e.g. OTP) to a safe UTILITY value', async () => {
        vi.mocked(axios.get).mockResolvedValue({
          data: {
            data: [
              {
                name: 'tpl_otp',
                language: 'pt_BR',
                status: 'APPROVED',
                category: 'OTP', // legacy, not in MARKETING/UTILITY/AUTHENTICATION
                components: [{ type: 'BODY', text: 'Code {{1}}' }],
              },
            ],
          },
        });

        const result = await service.syncFromMeta();

        expect(result).toEqual({ synced: 1, skipped: 0 });
        expect(repo.upsertByMetaName).toHaveBeenCalledWith(
          expect.objectContaining({
            metaName: 'tpl_otp',
            status: 'APPROVED',
            category: 'UTILITY',
          }),
        );
      });

      it('skips a bad item, keeps syncing the rest, and reports the skipped count', async () => {
        vi.mocked(axios.get).mockResolvedValue({
          data: {
            data: [
              {
                name: 'tpl_ok_1',
                language: 'pt_BR',
                status: 'APPROVED',
                category: 'UTILITY',
                components: [{ type: 'BODY', text: 'one' }],
              },
              {
                name: 'tpl_bad',
                language: 'pt_BR',
                status: 'APPROVED',
                category: 'UTILITY',
                components: [{ type: 'BODY', text: 'boom' }],
              },
              {
                name: 'tpl_ok_2',
                language: 'pt_BR',
                status: 'APPROVED',
                category: 'UTILITY',
                components: [{ type: 'BODY', text: 'three' }],
              },
            ],
          },
        });
        // The middle upsert fails — must not abort the whole sync.
        repo.upsertByMetaName.mockImplementation(async (data: any) => {
          if (data.metaName === 'tpl_bad') {
            throw new Error('db write failed');
          }
          return { id: 't' } as never;
        });

        const result = await service.syncFromMeta();

        expect(result).toEqual({ synced: 2, skipped: 1 });
        expect(repo.upsertByMetaName).toHaveBeenCalledTimes(3);
        expect(repo.upsertByMetaName).toHaveBeenCalledWith(
          expect.objectContaining({ metaName: 'tpl_ok_1' }),
        );
        expect(repo.upsertByMetaName).toHaveBeenCalledWith(
          expect.objectContaining({ metaName: 'tpl_ok_2' }),
        );
      });

      it('still records the template.sync audit event with synced + skipped even when an item fails', async () => {
        vi.mocked(axios.get).mockResolvedValue({
          data: {
            data: [
              {
                name: 'tpl_ok',
                language: 'pt_BR',
                status: 'APPROVED',
                category: 'UTILITY',
                components: [{ type: 'BODY', text: 'ok' }],
              },
              {
                name: 'tpl_bad',
                language: 'pt_BR',
                status: 'APPROVED',
                category: 'UTILITY',
                components: [{ type: 'BODY', text: 'bad' }],
              },
            ],
          },
        });
        repo.upsertByMetaName.mockImplementation(async (data: any) => {
          if (data.metaName === 'tpl_bad') throw new Error('boom');
          return { id: 't' } as never;
        });

        await service.syncFromMeta();

        expect(audit.log).toHaveBeenCalledWith(
          'template.sync',
          'Template',
          undefined,
          { synced: 1, skipped: 1 },
        );
      });
    });
  });

  // ZC — o sync do catálogo do Zernio é POR CANAL: o Zernio não tem catálogo da
  // organização, `accountId` é obrigatório na query, e o mesmo nome de template
  // pode existir em WABAs diferentes.
  describe('syncFromZernio', () => {
    const channel = { id: 'ch_1', zernioAccountId: 'acc_1', name: 'Canal 1' };

    function tpl(overrides: Record<string, unknown> = {}) {
      return {
        id: '833669913010819',
        name: 'bem_vindo_mg',
        status: 'APPROVED',
        category: 'MARKETING',
        language: 'pt_BR',
        components: [{ type: 'BODY', text: 'Olá {{1}}, bem-vindo' }],
        ...overrides,
      };
    }

    beforeEach(() => {
      repo.listActiveZernioAccounts.mockResolvedValue([channel]);
      repo.upsertZernioTemplate.mockResolvedValue({ id: 't' } as never);
      zernioTemplates.list.mockResolvedValue([]);
    });

    it('sem credencial Zernio → ZernioCredentialsNotConfiguredError, sem tocar no banco', async () => {
      Object.defineProperty(zernioTemplates, 'configured', {
        value: false,
        configurable: true,
      });

      await expect(service.syncFromZernio()).rejects.toThrow(
        ZernioCredentialsNotConfiguredError,
      );
      expect(repo.listActiveZernioAccounts).not.toHaveBeenCalled();
    });

    it('sem canais ZERNIO ativos → {synced:0, skipped:0}, sem chamar a API', async () => {
      repo.listActiveZernioAccounts.mockResolvedValue([]);

      await expect(service.syncFromZernio()).resolves.toEqual({
        synced: 0,
        skipped: 0,
      });
      expect(zernioTemplates.list).not.toHaveBeenCalled();
    });

    // O coração do ZC: upsert pela chave completa, guardando o id da Meta e os
    // components (a estrutura que `body` sozinho perde).
    it('importa o catálogo e faz upsert pela chave (canal, nome, idioma)', async () => {
      zernioTemplates.list.mockResolvedValue([tpl()]);

      const result = await service.syncFromZernio();

      expect(result).toEqual({ synced: 1, skipped: 0 });
      expect(zernioTemplates.list).toHaveBeenCalledWith('acc_1');
      expect(repo.upsertZernioTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: 'ch_1',
          metaName: 'bem_vindo_mg',
          language: 'pt_BR',
          data: expect.objectContaining({
            body: 'Olá {{1}}, bem-vindo',
            variables: ['1'],
            status: 'APPROVED',
            category: 'MARKETING',
            zernioTemplateId: '833669913010819',
            zernioStatusRaw: 'APPROVED',
            components: [{ type: 'BODY', text: 'Olá {{1}}, bem-vindo' }],
          }),
        }),
      );
    });

    // Idempotência: o upsert é pela chave composta, então a 2ª rodada reescreve a
    // MESMA row em vez de criar outra.
    it('rodar duas vezes é idempotente (mesma chave, mesmo canal)', async () => {
      zernioTemplates.list.mockResolvedValue([tpl()]);

      await service.syncFromZernio();
      await service.syncFromZernio();

      const keys = repo.upsertZernioTemplate.mock.calls.map((c) => ({
        channelId: (c[0] as Record<string, unknown>).channelId,
        metaName: (c[0] as Record<string, unknown>).metaName,
        language: (c[0] as Record<string, unknown>).language,
      }));
      expect(keys).toEqual([
        { channelId: 'ch_1', metaName: 'bem_vindo_mg', language: 'pt_BR' },
        { channelId: 'ch_1', metaName: 'bem_vindo_mg', language: 'pt_BR' },
      ]);
    });

    // O caso que o unique GLOBAL de metaName quebrava: duas WABAs, o mesmo nome.
    it('o mesmo nome em canais diferentes vira DUAS rows (catálogo é por WABA)', async () => {
      repo.listActiveZernioAccounts.mockResolvedValue([
        channel,
        { id: 'ch_2', zernioAccountId: 'acc_2', name: 'Canal 2' },
      ]);
      zernioTemplates.list.mockResolvedValue([tpl({ name: 'boas_vindas' })]);

      await service.syncFromZernio();

      expect(zernioTemplates.list).toHaveBeenCalledWith('acc_1');
      expect(zernioTemplates.list).toHaveBeenCalledWith('acc_2');
      const channelIds = repo.upsertZernioTemplate.mock.calls.map(
        (c) => (c[0] as Record<string, unknown>).channelId,
      );
      expect(channelIds).toEqual(['ch_1', 'ch_2']);
    });

    // A ARMADILHA: a listagem só devolve APPROVED/PENDING/REJECTED, mas o webhook
    // amplia para DISABLED/IN_APPEAL/PENDING_DELETION — e um desses explodia no
    // Zod e derrubava o sync inteiro. Agora mapeia e PRESERVA o raw.
    it.each([
      ['DISABLED', 'PAUSED'],
      ['PENDING_DELETION', 'PAUSED'],
      ['IN_APPEAL', 'PENDING'],
      ['STATUS_QUE_A_META_INVENTOU', 'PENDING'],
    ])('status %s não quebra o sync → %s, com o raw preservado', async (raw, mapped) => {
      zernioTemplates.list.mockResolvedValue([tpl({ status: raw })]);

      const result = await service.syncFromZernio();

      expect(result).toEqual({ synced: 1, skipped: 0 });
      expect(repo.upsertZernioTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: mapped,
            zernioStatusRaw: raw,
          }),
        }),
      );
    });

    it('template sem BODY → body "" e variables []', async () => {
      zernioTemplates.list.mockResolvedValue([tpl({ components: [] })]);

      await service.syncFromZernio();

      expect(repo.upsertZernioTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ body: '', variables: [] }),
        }),
      );
    });

    // "Não consegui ler esta WABA" ≠ "esta WABA tem 0 templates". Confundir os
    // dois faria o sync concluir que o catálogo sumiu.
    it('falha de rede em UMA conta não aborta as outras', async () => {
      repo.listActiveZernioAccounts.mockResolvedValue([
        channel,
        { id: 'ch_2', zernioAccountId: 'acc_2', name: 'Canal 2' },
      ]);
      zernioTemplates.list
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce([tpl()]);

      const result = await service.syncFromZernio();

      expect(result).toEqual({ synced: 1, skipped: 0 });
      expect(repo.upsertZernioTemplate).toHaveBeenCalledTimes(1);
    });

    it('item que falha na escrita é pulado e contado, sem derrubar o resto', async () => {
      zernioTemplates.list.mockResolvedValue([
        tpl({ name: 'ok_1' }),
        tpl({ name: 'ruim' }),
        tpl({ name: 'ok_2' }),
      ]);
      repo.upsertZernioTemplate
        .mockResolvedValueOnce({ id: 'a' } as never)
        .mockRejectedValueOnce(new Error('write failed'))
        .mockResolvedValueOnce({ id: 'c' } as never);

      const result = await service.syncFromZernio();

      expect(result).toEqual({ synced: 2, skipped: 1 });
      expect(audit.log).toHaveBeenCalledWith(
        'template.sync_zernio',
        'Template',
        undefined,
        { synced: 2, skipped: 1 },
      );
    });
  });

  // ZC — o webhook chega e o status muda NA HORA. É o que permite que a
  // reconciliação seja uma rede de segurança espaçada (1h) em vez do mecanismo
  // principal: o balde do Zernio é o MESMO do envio.
  // ★ O BURACO QUE O SYNC ERA: um template de opt-in criado no painel do Zernio,
  // com um rótulo que o reconhecedor não lê, entrava APROVADO e selecionável.
  describe('syncFromZernio — os rótulos dos botões', () => {
    const channel = { id: 'ch_1', zernioAccountId: 'acc_1', name: 'Canal 1' };

    const withButtons = (labels: string[]) => ({
      id: '999',
      name: 'reapresentacao_optin',
      status: 'APPROVED',
      category: 'MARKETING',
      language: 'pt_BR',
      components: [
        { type: 'BODY', text: 'Olá' },
        {
          type: 'BUTTONS',
          buttons: labels.map((text) => ({ type: 'QUICK_REPLY', text })),
        },
      ],
    });

    beforeEach(() => {
      repo.listActiveZernioAccounts.mockResolvedValue([channel]);
      repo.upsertZernioTemplate.mockResolvedValue({ id: 't' } as never);
      repo.findZernioTemplate.mockResolvedValue(null);
    });

    it('importa um template importado SEM declaração — e é isso que o gate de campanha bloqueia depois', async () => {
      zernioTemplates.list.mockResolvedValue([
        withButtons(['Bora, quero!', 'Agora não']) as never,
      ]);

      await service.syncFromZernio();

      const persisted = repo.upsertZernioTemplate.mock.calls[0]![0];
      // Nada é INVENTADO: o sync não pode adivinhar que "Bora, quero!" era o
      // "sim". Persistir "não declarado" é o que faz o gate recusar a campanha.
      expect(persisted.data.consentButtonRoles).toBe(Prisma.JsonNull);
    });

    it('PRESERVA a declaração do operador quando os rótulos não mudaram', async () => {
      repo.findZernioTemplate.mockResolvedValue({
        id: 't1',
        consentButtonRoles: [
          { text: 'Sim, quero receber', role: 'OPT_IN' },
          { text: 'Não quero receber', role: 'OPT_OUT' },
        ],
      } as never);
      zernioTemplates.list.mockResolvedValue([
        withButtons(['Sim, quero receber', 'Não quero receber']) as never,
      ]);

      await service.syncFromZernio();

      const persisted = repo.upsertZernioTemplate.mock.calls[0]![0];
      expect(persisted.data.consentButtonRoles).toEqual([
        { text: 'Sim, quero receber', role: 'OPT_IN' },
        { text: 'Não quero receber', role: 'OPT_OUT' },
      ]);
    });

    it('★ DERRUBA a declaração quando a Meta reescreveu o rótulo (a row volta a bloquear)', async () => {
      repo.findZernioTemplate.mockResolvedValue({
        id: 't1',
        consentButtonRoles: [{ text: 'Sim, quero receber', role: 'OPT_IN' }],
      } as never);
      zernioTemplates.list.mockResolvedValue([
        withButtons(['Sim, quero rece']) as never,
      ]);

      await service.syncFromZernio();

      const persisted = repo.upsertZernioTemplate.mock.calls[0]![0];
      expect(persisted.data.consentButtonRoles).toBe(Prisma.JsonNull);
    });
  });

  describe('applyZernioTemplateStatus', () => {
    it('atualiza o status do template casado, preservando o raw', async () => {
      repo.findZernioTemplate.mockResolvedValue({ id: 't1' } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      const ok = await service.applyZernioTemplateStatus({
        channelId: 'ch_1',
        zernioTemplateId: '833669913010819',
        metaName: 'bem_vindo_mg',
        language: 'pt_BR',
        status: 'REJECTED',
        reason: 'Conteúdo promocional não permitido',
      });

      expect(ok).toBe(true);
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          status: 'REJECTED',
          zernioStatusRaw: 'REJECTED',
          zernioRejectionReason: 'Conteúdo promocional não permitido',
        }),
      );
    });

    // Um status novo da Meta não pode derrubar o webhook — nem abrir o gate.
    it('status desconhecido no webhook → PENDING (fechado), sem lançar', async () => {
      repo.findZernioTemplate.mockResolvedValue({ id: 't1' } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.applyZernioTemplateStatus({
        channelId: 'ch_1',
        metaName: 'x',
        language: 'pt_BR',
        status: 'ALGO_NOVO',
      });

      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ status: 'PENDING', zernioStatusRaw: 'ALGO_NOVO' }),
      );
    });

    // 'NONE' é como a Meta diz "sem motivo" num template aprovado — gravá-lo
    // faria a UI exibir "Motivo: NONE" num template saudável.
    it('reason "NONE" não vira motivo de rejeição', async () => {
      repo.findZernioTemplate.mockResolvedValue({ id: 't1' } as never);
      repo.update.mockResolvedValue({ id: 't1' } as never);

      await service.applyZernioTemplateStatus({
        channelId: 'ch_1',
        metaName: 'x',
        language: 'pt_BR',
        status: 'APPROVED',
        reason: 'NONE',
      });

      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ zernioRejectionReason: null }),
      );
    });

    // O webhook pode chegar antes do 1º sync (ou o template nasceu fora do orgamind).
    it('template desconhecido → false, sem escrever nada', async () => {
      repo.findZernioTemplate.mockResolvedValue(null);

      const ok = await service.applyZernioTemplateStatus({
        channelId: 'ch_1',
        metaName: 'nunca_visto',
        language: 'pt_BR',
        status: 'APPROVED',
      });

      expect(ok).toBe(false);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  // ── twilio-platform T4: criar/submeter/editar rascunho/excluir na Twilio ──

  const TWILIO_SID = 'HX00000000000000000000000000000042';

  describe('createTwilio', () => {
    const input = {
      contentType: 'twilio/quick-reply' as const,
      name: 'confirmacao_visita',
      language: 'pt_BR',
      category: 'UTILITY' as const,
      body: 'Olá {{1}}, confirma a visita?',
      variables: { '1': 'João' },
      actions: [
        { title: 'Confirmar', id: 'confirm' },
        { title: 'PARAR', id: 'optout' },
      ],
    };

    beforeEach(() => {
      repo.findByMetaName.mockResolvedValue(null);
      twilioContent.createContent.mockResolvedValue({ sid: TWILIO_SID });
      repo.create.mockImplementation(
        async (data) => ({ id: 't1', createdAt: new Date(), ...data }) as never,
      );
    });

    it('valida, cria o rascunho na Twilio e grava o row local TWILIO em draft', async () => {
      const result = await service.createTwilio(input);

      expect(twilioContent.createContent).toHaveBeenCalledWith({
        friendlyName: 'confirmacao_visita',
        language: 'pt_BR',
        variables: { '1': 'João' },
        types: {
          'twilio/quick-reply': {
            body: 'Olá {{1}}, confirma a visita?',
            actions: [
              { title: 'Confirmar', id: 'confirm' },
              { title: 'PARAR', id: 'optout' },
            ],
          },
        },
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metaName: 'confirmacao_visita',
          provider: 'TWILIO',
          twilioContentSid: TWILIO_SID,
          status: 'PENDING',
          twilioApprovalStatus: 'draft',
          language: 'pt_BR',
          body: 'Olá {{1}}, confirma a visita?',
          variables: ['1'],
          category: 'UTILITY',
          kind: 'BUTTONS',
        }),
      );
      expect(result).toMatchObject({ id: 't1', provider: 'TWILIO' });
      expect(audit.log).toHaveBeenCalledWith(
        'template.twilio_create',
        'Template',
        't1',
        expect.any(Object),
      );
    });

    it('twilio/text vira kind TEXT sem interactiveConfig com types twilio/text', async () => {
      await service.createTwilio({
        contentType: 'twilio/text',
        name: 'aviso_simples',
        language: 'pt_BR',
        category: 'MARKETING',
        body: 'Olá {{1}}, novidades chegaram.',
        variables: { '1': 'João' },
      });

      expect(twilioContent.createContent).toHaveBeenCalledWith(
        expect.objectContaining({
          types: { 'twilio/text': { body: 'Olá {{1}}, novidades chegaram.' } },
        }),
      );
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'TEXT' }),
      );
    });

    it('input inválido → ValidationError com TODOS os problemas; Twilio não é chamada', async () => {
      const err = await service
        .createTwilio({
          ...input,
          name: 'Nome Ruim',
          body: '{{1}} e {{3}}',
          variables: {},
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe('template.twilio_invalid');
      expect(err.message).toMatch(/minúsculas/);
      expect(err.message).toMatch(/começar com uma variável/);
      expect(err.message).toMatch(/sequenciais/);
      expect(err.message).toMatch(/amostra/i);
      expect(twilioContent.createContent).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('nome já usado localmente → conflito antes de chamar a Twilio', async () => {
      repo.findByMetaName.mockResolvedValue({ id: 'other' } as never);

      await expect(service.createTwilio(input)).rejects.toThrow(
        TemplateMetaNameConflictError,
      );
      expect(twilioContent.createContent).not.toHaveBeenCalled();
    });
  });

  describe('submitTwilioApproval', () => {
    const draftRow = {
      id: 't1',
      metaName: 'confirmacao_visita',
      language: 'pt_BR',
      category: 'UTILITY',
      provider: 'TWILIO',
      twilioContentSid: TWILIO_SID,
      twilioApprovalStatus: 'draft',
    };

    beforeEach(() => {
      twilioContent.submitApproval.mockResolvedValue({ status: 'received' });
      repo.update.mockImplementation(
        async (id, data) => ({ id, ...data }) as never,
      );
    });

    it('submete com name=metaName + category e grava o status retornado', async () => {
      repo.findById.mockResolvedValue(draftRow as never);

      const result = await service.submitTwilioApproval('t1');

      expect(twilioContent.submitApproval).toHaveBeenCalledWith(TWILIO_SID, {
        name: 'confirmacao_visita',
        category: 'UTILITY',
      });
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          twilioApprovalStatus: 'received',
          status: 'PENDING',
          lastTwilioSyncAt: expect.any(Date),
        }),
      );
      expect(result).toMatchObject({ twilioApprovalStatus: 'received' });
      expect(audit.log).toHaveBeenCalledWith(
        'template.twilio_submit',
        'Template',
        't1',
        expect.objectContaining({ status: 'received' }),
      );
    });

    it('aceita row legado com twilioApprovalStatus null (rascunho sincronizado antes do T4)', async () => {
      repo.findById.mockResolvedValue({
        ...draftRow,
        twilioApprovalStatus: null,
      } as never);

      await service.submitTwilioApproval('t1');

      expect(twilioContent.submitApproval).toHaveBeenCalledTimes(1);
    });

    it('já submetido (received) → TemplateNotDraftError; Twilio não é chamada', async () => {
      repo.findById.mockResolvedValue({
        ...draftRow,
        twilioApprovalStatus: 'received',
      } as never);

      await expect(service.submitTwilioApproval('t1')).rejects.toThrow(
        TemplateNotDraftError,
      );
      expect(twilioContent.submitApproval).not.toHaveBeenCalled();
    });

    it('template de outro provedor → TemplateNotTwilioError', async () => {
      repo.findById.mockResolvedValue({
        ...draftRow,
        provider: 'EVOLUTION',
        twilioContentSid: null,
      } as never);

      await expect(service.submitTwilioApproval('t1')).rejects.toThrow(
        TemplateNotTwilioError,
      );
    });

    it('TWILIO sem twilioContentSid → TemplateNotTwilioError', async () => {
      repo.findById.mockResolvedValue({
        ...draftRow,
        twilioContentSid: null,
      } as never);

      await expect(service.submitTwilioApproval('t1')).rejects.toThrow(
        TemplateNotTwilioError,
      );
    });

    it('inexistente → TemplateNotFoundError', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.submitTwilioApproval('missing')).rejects.toThrow(
        TemplateNotFoundError,
      );
    });
  });

  describe('updateTwilioDraft', () => {
    const draftRow = {
      id: 't1',
      metaName: 'confirmacao_visita',
      language: 'pt_BR',
      category: 'UTILITY',
      provider: 'TWILIO',
      twilioContentSid: TWILIO_SID,
      twilioApprovalStatus: 'draft',
    };
    const input = {
      contentType: 'twilio/text' as const,
      language: 'pt_BR',
      category: 'MARKETING' as const,
      body: 'Novo corpo {{1}}, tudo certo.',
      variables: { '1': 'João' },
    };

    beforeEach(() => {
      repo.update.mockImplementation(
        async (id, data) => ({ id, ...data }) as never,
      );
    });

    it('edita o rascunho na Twilio e atualiza o row local', async () => {
      repo.findById.mockResolvedValue(draftRow as never);

      await service.updateTwilioDraft('t1', input);

      expect(twilioContent.updateDraft).toHaveBeenCalledWith(TWILIO_SID, {
        friendlyName: 'confirmacao_visita',
        language: 'pt_BR',
        variables: { '1': 'João' },
        types: { 'twilio/text': { body: 'Novo corpo {{1}}, tudo certo.' } },
      });
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          body: 'Novo corpo {{1}}, tudo certo.',
          category: 'MARKETING',
          variables: ['1'],
          kind: 'TEXT',
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        'template.twilio_draft_update',
        'Template',
        't1',
        expect.any(Object),
      );
    });

    it('já submetido → TemplateNotDraftError; Twilio não é chamada', async () => {
      repo.findById.mockResolvedValue({
        ...draftRow,
        twilioApprovalStatus: 'pending',
      } as never);

      await expect(service.updateTwilioDraft('t1', input)).rejects.toThrow(
        TemplateNotDraftError,
      );
      expect(twilioContent.updateDraft).not.toHaveBeenCalled();
    });

    it('mudança de idioma → ValidationError (Content API não permite)', async () => {
      repo.findById.mockResolvedValue(draftRow as never);

      const err = await service
        .updateTwilioDraft('t1', { ...input, language: 'en_US' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe('template.twilio_language_immutable');
      expect(twilioContent.updateDraft).not.toHaveBeenCalled();
    });

    it('input inválido agrega TODOS os problemas (ValidationError)', async () => {
      repo.findById.mockResolvedValue(draftRow as never);

      const err = await service
        .updateTwilioDraft('t1', { ...input, body: '{{1}}{{2}}', variables: {} })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe('template.twilio_invalid');
      expect(err.message).toMatch(/adjacentes/);
      expect(err.message).toMatch(/amostra/i);
      expect(twilioContent.updateDraft).not.toHaveBeenCalled();
    });
  });

  describe('delete — templates Twilio e campanhas ativas', () => {
    const twilioRow = {
      id: 't1',
      metaName: 'confirmacao_visita',
      provider: 'TWILIO',
      twilioContentSid: TWILIO_SID,
    };

    it('row TWILIO com Content SID → exclui na Twilio antes do delete local', async () => {
      repo.findById.mockResolvedValue(twilioRow as never);
      repo.countActiveCampaignsUsingTemplate.mockResolvedValue(0);
      repo.findInUseByCampaigns.mockResolvedValue(0);
      repo.delete.mockResolvedValue(twilioRow as never);

      await service.delete('t1');

      expect(twilioContent.deleteContent).toHaveBeenCalledWith(TWILIO_SID);
      expect(repo.delete).toHaveBeenCalledWith('t1');
    });

    it('campanha ATIVA usando o template → TemplateActiveCampaignError; nada é excluído', async () => {
      repo.findById.mockResolvedValue(twilioRow as never);
      repo.countActiveCampaignsUsingTemplate.mockResolvedValue(2);

      await expect(service.delete('t1')).rejects.toThrow(
        TemplateActiveCampaignError,
      );
      expect(twilioContent.deleteContent).not.toHaveBeenCalled();
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('row de outro provedor → não chama a Twilio', async () => {
      repo.findById.mockResolvedValue({
        id: 't1',
        metaName: 'x',
        provider: 'EVOLUTION',
        twilioContentSid: null,
      } as never);
      repo.countActiveCampaignsUsingTemplate.mockResolvedValue(0);
      repo.findInUseByCampaigns.mockResolvedValue(0);
      repo.delete.mockResolvedValue({ id: 't1' } as never);

      await service.delete('t1');

      expect(twilioContent.deleteContent).not.toHaveBeenCalled();
      expect(repo.delete).toHaveBeenCalledWith('t1');
    });
  });
  // ─────────────────────────────────────────────────────────────────────────
  // ZB — criar template COM BOTÕES no Zernio (POST /templates/zernio)
  //
  // O que estes testes protegem é UMA coisa: é IMPOSSÍVEL nascer um template
  // cujo botão de opt-in o sistema não reconheça. O bloqueio mora no SERVIDOR,
  // dono do reconhecedor — não na UI, que um curl ignora.
  // ─────────────────────────────────────────────────────────────────────────
  describe('createZernio', () => {
    const channel = {
      id: 'ch1',
      zernioAccountId: 'acc1',
      name: 'Campanha',
      provider: 'ZERNIO',
      isActive: true,
    };

    const optInInput = {
      channelId: 'ch1',
      name: 'reapresentacao_optin',
      language: 'pt_BR',
      category: 'MARKETING' as const,
      body: 'Oi! Podemos continuar te enviando novidades da campanha?',
      bodyExamples: [],
      buttons: [
        { type: 'QUICK_REPLY' as const, text: 'Sim, quero receber', role: 'OPT_IN' as const },
        { type: 'QUICK_REPLY' as const, text: 'Não quero receber', role: 'OPT_OUT' as const },
      ],
    };

    beforeEach(() => {
      repo.findZernioChannel.mockResolvedValue(channel as never);
      repo.findByChannelAndName.mockResolvedValue(null);
      repo.upsertZernioTemplate.mockResolvedValue({ id: 't-new' } as never);
      zernioTemplates.create.mockResolvedValue({
        id: '123456',
        status: 'PENDING',
      });
      zernioTemplates.getByName.mockResolvedValue(null);
    });

    it('cria na Meta via Zernio e persiste PENDING com os components crus', async () => {
      await service.createZernio(optInInput);

      expect(zernioTemplates.create).toHaveBeenCalledWith('acc1', {
        name: 'reapresentacao_optin',
        language: 'pt_BR',
        category: 'MARKETING',
        components: [
          { type: 'BODY', text: optInInput.body },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'Sim, quero receber' },
              { type: 'QUICK_REPLY', text: 'Não quero receber' },
            ],
          },
        ],
      });

      const persisted = repo.upsertZernioTemplate.mock.calls[0]![0];
      expect(persisted.channelId).toBe('ch1');
      expect(persisted.metaName).toBe('reapresentacao_optin');
      // NUNCA APPROVED fabricado — o gate de campanha só abre quando a Meta abrir.
      expect(persisted.data.status).toBe('PENDING');
      expect(persisted.data.kind).toBe('BUTTONS');
      expect(persisted.data.zernioTemplateId).toBe('123456');
    });

    it('BLOQUEIA rótulo de opt-in não reconhecido — e nem chega a chamar o Zernio', async () => {
      await expect(
        service.createZernio({
          ...optInInput,
          buttons: [
            { type: 'QUICK_REPLY', text: 'Bora!', role: 'OPT_IN' },
            { type: 'QUICK_REPLY', text: 'Não quero receber', role: 'OPT_OUT' },
          ],
        }),
      ).rejects.toThrow(ValidationError);
      expect(zernioTemplates.create).not.toHaveBeenCalled();
      expect(repo.upsertZernioTemplate).not.toHaveBeenCalled();
    });

    it('BLOQUEIA botão comum cujo rótulo seria lido como consentimento', async () => {
      await expect(
        service.createZernio({
          ...optInInput,
          buttons: [{ type: 'QUICK_REPLY', text: 'Quero receber', role: 'NONE' }],
        }),
      ).rejects.toThrow(ValidationError);
      expect(zernioTemplates.create).not.toHaveBeenCalled();
    });

    it('exige um canal ZERNIO com conta configurada', async () => {
      repo.findZernioChannel.mockResolvedValue(null);
      await expect(service.createZernio(optInInput)).rejects.toThrow(
        ValidationError,
      );
      expect(zernioTemplates.create).not.toHaveBeenCalled();
    });

    it('recusa nome duplicado NO MESMO CANAL (a chave real é composta)', async () => {
      repo.findByChannelAndName.mockResolvedValue({ id: 'old' } as never);
      await expect(service.createZernio(optInInput)).rejects.toThrow(
        TemplateMetaNameConflictError,
      );
      expect(zernioTemplates.create).not.toHaveBeenCalled();
    });

    it('sem credencial Zernio, não tenta criar', async () => {
      Object.defineProperty(zernioTemplates, 'configured', {
        value: false,
        configurable: true,
      });
      await expect(service.createZernio(optInInput)).rejects.toThrow(
        ZernioCredentialsNotConfiguredError,
      );
    });

    it('round-trip: se a Meta devolver o rótulo de opt-in irreconhecível, NÃO persiste', async () => {
      // O rótulo que volta no clique é o rótulo COMO A META O GUARDOU. Se ela
      // truncou/alterou a ponto de o reconhecedor não pegar mais, a campanha
      // colheria zero — melhor descobrir aqui.
      zernioTemplates.getByName.mockResolvedValue({
        id: '123456',
        name: 'reapresentacao_optin',
        language: 'pt_BR',
        components: [
          {
            type: 'BUTTONS',
            buttons: [{ type: 'QUICK_REPLY', text: 'Sim, quero rece' }],
          },
        ],
      } as never);

      await expect(service.createZernio(optInInput)).rejects.toThrow(
        ValidationError,
      );
      expect(repo.upsertZernioTemplate).not.toHaveBeenCalled();
    });

    it('round-trip indisponível (leitura falhou) não derruba a criação', async () => {
      zernioTemplates.getByName.mockRejectedValue(new Error('timeout'));
      await expect(service.createZernio(optInInput)).resolves.toBeDefined();
      expect(repo.upsertZernioTemplate).toHaveBeenCalled();
    });

    it('persiste a DECLARAÇÃO de papel dos botões (é ela que o gate de campanha lê)', async () => {
      await service.createZernio(optInInput);

      const persisted = repo.upsertZernioTemplate.mock.calls[0]![0];
      expect(persisted.data.consentButtonRoles).toEqual([
        { text: 'Sim, quero receber', role: 'OPT_IN' },
        { text: 'Não quero receber', role: 'OPT_OUT' },
      ]);
    });

    it('★ round-trip rejeitado APAGA o template na Meta — senão o sync o traz de volta em 1h', async () => {
      // Sem o DELETE, a rejeição durava no máximo 60 minutos: o syncFromZernio
      // lista TUDO da conta e faz upsert, e o template voltava como row normal —
      // aprovado, selecionável, colhendo zero.
      zernioTemplates.getByName.mockResolvedValue({
        id: '123456',
        name: 'reapresentacao_optin',
        language: 'pt_BR',
        components: [
          {
            type: 'BUTTONS',
            buttons: [{ type: 'QUICK_REPLY', text: 'Sim, quero rece' }],
          },
        ],
      } as never);

      await expect(service.createZernio(optInInput)).rejects.toThrow(
        ValidationError,
      );
      expect(zernioTemplates.delete).toHaveBeenCalledWith(
        'acc1',
        'reapresentacao_optin',
      );
      expect(repo.upsertZernioTemplate).not.toHaveBeenCalled();
    });

    it('se o DELETE remoto falhar, ainda assim NÃO persiste — e diz ao operador para apagar no painel', async () => {
      zernioTemplates.getByName.mockResolvedValue({
        id: '123456',
        name: 'reapresentacao_optin',
        language: 'pt_BR',
        components: [
          {
            type: 'BUTTONS',
            buttons: [{ type: 'QUICK_REPLY', text: 'Sim, quero rece' }],
          },
        ],
      } as never);
      zernioTemplates.delete.mockRejectedValue(new Error('500'));

      await expect(service.createZernio(optInInput)).rejects.toThrow(
        /apague-o no painel/i,
      );
      expect(repo.upsertZernioTemplate).not.toHaveBeenCalled();
    });

    it('recusa categoria AUTHENTICATION — a Meta exige forma rígida e rejeitaria', async () => {
      await expect(
        service.createZernio({
          ...optInInput,
          category: 'AUTHENTICATION' as never,
        }),
      ).rejects.toThrow(ValidationError);
      expect(zernioTemplates.create).not.toHaveBeenCalled();
    });
  });

  // ★ A PORTA QUE FALTAVA: o template criado FORA do orgamind.
  describe('declareConsentButtons (classificar os botões de um template importado)', () => {
    const row = (overrides: Record<string, unknown> = {}) =>
      ({
        id: 't1',
        metaName: 'reapresentacao_optin',
        provider: 'ZERNIO',
        components: [
          { type: 'BODY', text: 'oi' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'Bora, quero!' },
              { type: 'QUICK_REPLY', text: 'Agora não' },
            ],
          },
        ],
        consentButtonRoles: null,
        ...overrides,
      }) as never;

    beforeEach(() => {
      repo.update.mockResolvedValue({ id: 't1' } as never);
    });

    it('grava a declaração quando ela é coerente com o reconhecedor', async () => {
      repo.findById.mockResolvedValue(row());

      await service.declareConsentButtons('t1', {
        buttons: [
          { text: 'Bora, quero!', role: 'NONE' },
          { text: 'Agora não', role: 'NONE' },
        ],
      });

      expect(repo.update).toHaveBeenCalledWith('t1', {
        consentButtonRoles: [
          { text: 'Bora, quero!', role: 'NONE' },
          { text: 'Agora não', role: 'NONE' },
        ],
      });
    });

    it('★ RECUSA declarar "Bora, quero!" como OPT_IN — a declaração não faz o clique ser lido', async () => {
      repo.findById.mockResolvedValue(row());

      await expect(
        service.declareConsentButtons('t1', {
          buttons: [
            { text: 'Bora, quero!', role: 'OPT_IN' },
            { text: 'Agora não', role: 'OPT_OUT' },
          ],
        }),
      ).rejects.toThrow(ValidationError);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('exige papel para TODOS os botões — um botão sem declaração continua bloqueando', async () => {
      repo.findById.mockResolvedValue(row());

      await expect(
        service.declareConsentButtons('t1', {
          buttons: [{ text: 'Bora, quero!', role: 'NONE' }],
        }),
      ).rejects.toThrow(/Agora não/);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('recusa template que não é ZERNIO (lá o clique volta com o id que nós escolhemos)', async () => {
      repo.findById.mockResolvedValue(row({ provider: 'EVOLUTION' }));

      await expect(
        service.declareConsentButtons('t1', {
          buttons: [{ text: 'Bora, quero!', role: 'NONE' }],
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('recusa template sem botões de resposta rápida', async () => {
      repo.findById.mockResolvedValue(
        row({ components: [{ type: 'BODY', text: 'oi' }] }),
      );

      await expect(
        service.declareConsentButtons('t1', {
          buttons: [{ text: 'x', role: 'NONE' }],
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('create (genérico) — a armadilha antiga', () => {
    it('recusa provider=ZERNIO: uma row APPROVED que não existe na Meta é mentira', async () => {
      repo.findByMetaName.mockResolvedValue(null);
      await expect(
        service.create({
          metaName: 'fake_zernio',
          language: 'pt_BR',
          body: 'oi',
          category: 'UTILITY',
          kind: 'TEXT',
          provider: 'ZERNIO',
        } as never),
      ).rejects.toThrow(ValidationError);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('consentButtonChoices', () => {
    it('serve a lista fechada de rótulos reconhecidos (a UI não tem cópia)', () => {
      const choices = service.consentButtonChoices();
      expect(choices.optIn).toContain('Sim, quero receber');
      expect(choices.optOut).toContain('Não quero receber');
    });
  });
});
