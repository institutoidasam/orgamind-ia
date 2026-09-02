import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import {
  TemplateApprovalSyncProcessor,
  mapTwilioApprovalStatus,
  extractBodyFromTypes,
} from './template-approval-sync.processor';
import { TemplatesRepository } from './templates.repository';
import {
  TwilioContentService,
  type TwilioContentItem,
} from '../whatsapp-providers/twilio-content.service';

const SID_1 = 'HX00000000000000000000000000000001';
const SID_2 = 'HX00000000000000000000000000000002';

function makeItem(overrides: Partial<TwilioContentItem> = {}): TwilioContentItem {
  return {
    sid: SID_1,
    friendlyName: 'primeiro_contato',
    language: 'pt_BR',
    variables: { '1': 'João', '2': 'IDASAM' },
    types: { 'twilio/text': { body: 'Olá {{1}}, aqui é {{2}}' } },
    approval: {
      name: 'primeiro_contato',
      category: 'MARKETING',
      status: 'approved',
      rejectionReason: '',
    },
    ...overrides,
  };
}

/** A minimal persisted Template row for the "existing" paths. */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl-1',
    metaName: 'primeiro_contato',
    language: 'pt_BR',
    body: 'Olá {{1}}',
    variables: ['1'],
    status: 'PENDING',
    category: 'MARKETING',
    createdAt: new Date(),
    kind: 'TEXT',
    interactiveConfig: null,
    twilioContentSid: SID_1,
    provider: 'TWILIO',
    twilioApprovalStatus: null,
    twilioRejectionReason: null,
    lastTwilioSyncAt: null,
    ...overrides,
  } as never;
}

describe('mapTwilioApprovalStatus', () => {
  it.each([
    ['received', 'PENDING'],
    ['pending', 'PENDING'],
    ['approved', 'APPROVED'],
    ['rejected', 'REJECTED'],
    ['paused', 'PAUSED'],
    ['disabled', 'PAUSED'],
  ])('mapeia %s → %s', (raw, expected) => {
    expect(mapTwilioApprovalStatus(raw)).toBe(expected);
  });

  it('sem approval_request (undefined) → PENDING', () => {
    expect(mapTwilioApprovalStatus(undefined)).toBe('PENDING');
  });

  it('status desconhecido (in_appeal) → PENDING (default seguro, não envia)', () => {
    expect(mapTwilioApprovalStatus('in_appeal')).toBe('PENDING');
  });

  it('é case-insensitive (APPROVED → APPROVED)', () => {
    expect(mapTwilioApprovalStatus('APPROVED')).toBe('APPROVED');
  });
});

describe('extractBodyFromTypes', () => {
  it('prefere twilio/text.body', () => {
    expect(
      extractBodyFromTypes({
        'twilio/quick-reply': { body: 'qr body' },
        'twilio/text': { body: 'text body' },
      }),
    ).toBe('text body');
  });

  it('cai para o body do primeiro type quando não há twilio/text', () => {
    expect(
      extractBodyFromTypes({ 'twilio/quick-reply': { body: 'qr body' } }),
    ).toBe('qr body');
  });

  it('retorna "" quando nenhum type tem body', () => {
    expect(extractBodyFromTypes({ 'twilio/media': {} })).toBe('');
    expect(extractBodyFromTypes({})).toBe('');
  });
});

describe('TemplateApprovalSyncProcessor', () => {
  let processor: TemplateApprovalSyncProcessor;
  let twilioContent: MockProxy<TwilioContentService>;
  let repo: MockProxy<TemplatesRepository>;

  beforeEach(() => {
    twilioContent = mockDeep<TwilioContentService>();
    // mockDeep can't infer readonly value props — set explicitly.
    Object.defineProperty(twilioContent, 'configured', {
      value: true,
      writable: true,
    });
    repo = mockDeep<TemplatesRepository>();
    repo.markTwilioRemoved.mockResolvedValue(0);
    processor = new TemplateApprovalSyncProcessor(twilioContent, repo);
  });

  it('deploy sem credenciais Twilio → tick vira no-op (não chama a API nem marca removidos)', async () => {
    Object.defineProperty(twilioContent, 'configured', { value: false });

    await processor.process();

    expect(twilioContent.listContentAndApprovals).not.toHaveBeenCalled();
    expect(repo.markTwilioRemoved).not.toHaveBeenCalled();
  });

  it('cria template novo (provider TWILIO) com campos mapeados do item', async () => {
    twilioContent.listContentAndApprovals.mockResolvedValue([makeItem()]);
    repo.findByTwilioContentSid.mockResolvedValue(null);
    repo.findByMetaName.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeRow());

    await processor.process();

    expect(repo.create).toHaveBeenCalledOnce();
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metaName: 'primeiro_contato',
        language: 'pt_BR',
        body: 'Olá {{1}}, aqui é {{2}}',
        variables: ['1', '2'],
        status: 'APPROVED',
        category: 'MARKETING',
        provider: 'TWILIO',
        twilioContentSid: SID_1,
        twilioApprovalStatus: 'approved',
        twilioRejectionReason: null,
        lastTwilioSyncAt: expect.any(Date),
      }),
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('template nunca submetido (sem approval) → PENDING, raw draft, metaName do friendly_name, categoria default UTILITY', async () => {
    twilioContent.listContentAndApprovals.mockResolvedValue([
      makeItem({ approval: undefined, friendlyName: 'rascunho_x' }),
    ]);
    repo.findByTwilioContentSid.mockResolvedValue(null);
    repo.findByMetaName.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeRow());

    await processor.process();

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metaName: 'rascunho_x',
        status: 'PENDING',
        category: 'UTILITY',
        // T4: rascunho explícito — o gate de submit/edição/PATCH depende de
        // twilioApprovalStatus 'draft' (null é aceito só como legado).
        twilioApprovalStatus: 'draft',
      }),
    );
  });

  it('row existente sem approval na Twilio mantém raw draft no update (não null)', async () => {
    twilioContent.listContentAndApprovals.mockResolvedValue([
      makeItem({ approval: undefined }),
    ]);
    repo.findByTwilioContentSid.mockResolvedValue(
      makeRow({ twilioApprovalStatus: 'draft' }),
    );

    await processor.process();

    expect(repo.update).toHaveBeenCalledWith(
      'tpl-1',
      expect.objectContaining({ twilioApprovalStatus: 'draft' }),
    );
  });

  it('conflito de metaName com row de OUTRO sid → sufixo _tw', async () => {
    twilioContent.listContentAndApprovals.mockResolvedValue([makeItem()]);
    repo.findByTwilioContentSid.mockResolvedValue(null);
    // Same metaName already taken by an Evolution template (different sid).
    repo.findByMetaName.mockResolvedValue(
      makeRow({ id: 'tpl-evo', twilioContentSid: null, provider: 'EVOLUTION' }),
    );
    repo.create.mockResolvedValue(makeRow());

    await processor.process();

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ metaName: 'primeiro_contato_tw' }),
    );
  });

  it('template existente (mesmo sid) → update de status/raw/reason/categoria/lastSync, sem create', async () => {
    twilioContent.listContentAndApprovals.mockResolvedValue([
      makeItem({
        approval: {
          name: 'primeiro_contato',
          category: 'UTILITY',
          status: 'rejected',
          rejectionReason: 'INVALID_FORMAT',
        },
      }),
    ]);
    repo.findByTwilioContentSid.mockResolvedValue(makeRow());
    repo.update.mockResolvedValue(makeRow());

    await processor.process();

    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledOnce();
    expect(repo.update).toHaveBeenCalledWith('tpl-1', {
      status: 'REJECTED',
      category: 'UTILITY',
      twilioApprovalStatus: 'rejected',
      twilioRejectionReason: 'INVALID_FORMAT',
      lastTwilioSyncAt: expect.any(Date),
    });
  });

  it('paused na Twilio → status local PAUSED', async () => {
    twilioContent.listContentAndApprovals.mockResolvedValue([
      makeItem({
        approval: { name: 'primeiro_contato', status: 'paused' },
      }),
    ]);
    repo.findByTwilioContentSid.mockResolvedValue(makeRow({ status: 'APPROVED' }));
    repo.update.mockResolvedValue(makeRow());

    await processor.process();

    expect(repo.update).toHaveBeenCalledWith(
      'tpl-1',
      expect.objectContaining({ status: 'PAUSED', twilioApprovalStatus: 'paused' }),
    );
  });

  it('filtra verify_auto_created (não upserta), mas o sid conta como "visto"', async () => {
    twilioContent.listContentAndApprovals.mockResolvedValue([
      makeItem({ sid: SID_2, friendlyName: 'verify_auto_created' }),
    ]);

    await processor.process();

    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.findByTwilioContentSid).not.toHaveBeenCalled();
    // The sid still counts as present at Twilio — it must NOT be marked removed.
    expect(repo.markTwilioRemoved).toHaveBeenCalledWith([SID_2], expect.any(Date));
  });

  it('marca como removido-na-Twilio os sids locais que não voltaram no catálogo', async () => {
    twilioContent.listContentAndApprovals.mockResolvedValue([makeItem()]);
    repo.findByTwilioContentSid.mockResolvedValue(makeRow());
    repo.update.mockResolvedValue(makeRow());
    repo.markTwilioRemoved.mockResolvedValue(3);

    await processor.process();

    expect(repo.markTwilioRemoved).toHaveBeenCalledOnce();
    expect(repo.markTwilioRemoved).toHaveBeenCalledWith([SID_1], expect.any(Date));
  });

  it('falha em um item não aborta os demais (try/catch por item)', async () => {
    twilioContent.listContentAndApprovals.mockResolvedValue([
      makeItem({ sid: SID_1 }),
      makeItem({ sid: SID_2, friendlyName: 'segundo_template' }),
    ]);
    repo.findByTwilioContentSid
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(makeRow({ id: 'tpl-2', twilioContentSid: SID_2 }));
    repo.update.mockResolvedValue(makeRow());

    await expect(processor.process()).resolves.toBeUndefined();

    // Second item still processed…
    expect(repo.update).toHaveBeenCalledWith('tpl-2', expect.anything());
    // …and BOTH sids count as seen (the failed one exists at Twilio).
    expect(repo.markTwilioRemoved).toHaveBeenCalledWith(
      [SID_1, SID_2],
      expect.any(Date),
    );
  });

  it('categoria desconhecida da Twilio não é gravada no update (mantém a local)', async () => {
    twilioContent.listContentAndApprovals.mockResolvedValue([
      makeItem({
        approval: { name: 'x', category: 'OTP', status: 'approved' },
      }),
    ]);
    repo.findByTwilioContentSid.mockResolvedValue(makeRow());
    repo.update.mockResolvedValue(makeRow());

    await processor.process();

    const data = repo.update.mock.calls[0][1] as Record<string, unknown>;
    expect(data.category).toBeUndefined();
    expect(data.status).toBe('APPROVED');
  });
});
