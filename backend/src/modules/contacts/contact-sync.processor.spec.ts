import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { UnrecoverableError } from 'bullmq';
import { ContactSyncProcessor } from './contact-sync.processor';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { ContactsRepository } from './contacts.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';
import type { Job } from 'bullmq';
import type { ContactSyncJob } from '../queue/queue.constants';

function makeJob(payload: Partial<ContactSyncJob> = {}): Job<ContactSyncJob> {
  return {
    data: {
      contactIds: ['c1', 'c2'],
      triggeredBy: 'backfill',
      ...payload,
    },
  } as unknown as Job<ContactSyncJob>;
}

/**
 * Canal GOZAP — o cenário de produção, e o padrão do `beforeEach`.
 * `isDefault: true` é obrigatório: fix round 1 (item #5) troca
 * `instancesRepo.findDefault()` por `resolveSyncChannel`, que resolve por
 * `instancesRepo.listActive()` filtrado a `isDefault && supportsNumberCheckFor`
 * — ver resolve-sync-channel.util.ts.
 */
const GOZAP_CHANNEL = {
  id: 'ch1',
  name: 'robo',
  provider: 'GOZAP',
  isDefault: true,
  isActive: true,
  evolutionInstanceName: null,
  gozapInstanceToken: 'cipher',
  sendWindowEnabled: false,
  sendWindowStartHour: 8,
  sendWindowEndHour: 20,
};

/**
 * Canal EVOLUTION, para os testes que dependem de foto de perfil — a busca
 * (`fetchProfilePictureUrl`) só roda quando `channel.provider === 'EVOLUTION'`
 * (o GoZap não tem o método). O padrão do `beforeEach` é GOZAP (o cenário de
 * produção); estes testes sobrescrevem `instancesRepo.listActive` com este
 * canal para exercitar de verdade o caminho de foto.
 */
const EVOLUTION_CHANNEL = {
  id: 'ch1',
  name: 'robo',
  provider: 'EVOLUTION',
  isDefault: true,
  isActive: true,
  evolutionInstanceName: 'inst-default',
  gozapInstanceToken: null,
  sendWindowEnabled: false,
  sendWindowStartHour: 8,
  sendWindowEndHour: 20,
};

describe('ContactSyncProcessor', () => {
  let prisma: MockProxy<PrismaService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let audit: MockProxy<AuditService>;
  let instancesRepo: MockProxy<WhatsappInstancesRepository>;
  let contactsRepo: MockProxy<ContactsRepository>;
  let processor: ContactSyncProcessor;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    wa = mockDeep<WhatsappProvidersService>();
    audit = mockDeep<AuditService>();
    instancesRepo = mockDeep<WhatsappInstancesRepository>();
    contactsRepo = mockDeep<ContactsRepository>();
    // Padrão: canal GOZAP ativo, default, online, sem janela — o cenário de
    // produção. `listActive()`, não `findDefault()` (fix round 1, item #5).
    instancesRepo.listActive.mockResolvedValue([GOZAP_CHANNEL] as never);
    contactsRepo.isSessionChannelOnline.mockResolvedValue(true);
    wa.supportsNumberCheckFor.mockReturnValue(true);
    processor = new ContactSyncProcessor(
      prisma,
      wa,
      audit,
      instancesRepo,
      contactsRepo,
    );
  });

  it('roda com concurrency:1 — o ritmo do GoZap não é uma reserva atômica (fix round 1, item #1)', () => {
    // `@nestjs/bullmq` guarda o 2º argumento do `@Processor(...)` sob esta
    // chave (`WORKER_METADATA`, `bullmq:worker_metadata`) — não reexportada
    // publicamente pelo pacote, então o teste vai direto no Reflect, como os
    // outros testes de metadata deste repo já fazem para `@Roles` e
    // `imports` de módulo.
    const options = Reflect.getMetadata(
      'bullmq:worker_metadata',
      ContactSyncProcessor,
    );
    expect(options).toEqual({ concurrency: 1 });
  });

  it('não faz nada quando o canal padrão não sabe validar número', async () => {
    wa.supportsNumberCheckFor.mockReturnValue(false);
    await processor.process(makeJob());
    expect(wa.supportsNumberCheckFor).toHaveBeenCalledWith('GOZAP');
    expect(wa.checkNumbersOnWhatsappVia).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it('não faz nada quando não há canal padrão ativo', async () => {
    instancesRepo.listActive.mockResolvedValue([]);
    await processor.process(makeJob());
    expect(wa.checkNumbersOnWhatsappVia).not.toHaveBeenCalled();
  });

  // ★ ABORTAR COM MOTIVO CLARO (spec B.5). Fix round 1, item #3: o aborto
  // determinístico agora é `UnrecoverableError` — o job MORRE com uma
  // tentativa só (não queima os 3 `attempts` configurados tentando de novo
  // contra um canal que continua offline).
  it('aborta quando o canal está offline', async () => {
    contactsRepo.isSessionChannelOnline.mockResolvedValue(false);
    await expect(processor.process(makeJob())).rejects.toThrow(
      UnrecoverableError,
    );
    expect(wa.checkNumbersOnWhatsappVia).not.toHaveBeenCalled();
  });

  // Fix round 2 (revisão pós-commit, minor) — `ChannelOfflineForSyncError`
  // interpolava `channel.name`, um rótulo LIVRE que o operador digita ao
  // criar o canal — e em produção alguns operadores digitam o próprio
  // telefone ali. A mensagem volta para a tela e pode acabar em log/Sentry.
  // Este é o teste de PONTA A PONTA: canal com `name` telefônico, offline,
  // e a mensagem do `UnrecoverableError` sem nenhuma sequência de 8+
  // dígitos — prova que o caminho real (não só a classe do erro isolada)
  // usa `channel.id`, não `channel.name`.
  it('canal offline com nome telefônico: a mensagem do erro não vaza o telefone', async () => {
    instancesRepo.listActive.mockResolvedValue([
      { ...GOZAP_CHANNEL, name: '+5592999998888' },
    ] as never);
    contactsRepo.isSessionChannelOnline.mockResolvedValue(false);

    let thrown: Error | undefined;
    try {
      await processor.process(makeJob());
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect(thrown!.message).not.toContain('+5592999998888');
    expect(thrown!.message).not.toMatch(/\d{8,}/);
  });

  // triggeredBy padrão de makeJob() é 'backfill' — pedido explícito do
  // operador, então continua recusando ALTO (fix round 1, item #2(a)).
  it('aborta fora da janela de envio do canal (trigger não-periódico)', async () => {
    instancesRepo.listActive.mockResolvedValue([
      {
        ...GOZAP_CHANNEL,
        sendWindowEnabled: true,
        sendWindowStartHour: 8,
        sendWindowEndHour: 9,
      },
    ] as never);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T07:00:00Z')); // 03:00 em Manaus
    try {
      await expect(processor.process(makeJob())).rejects.toThrow(
        UnrecoverableError,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // ★ FIX ROUND 1, item #2(a) — o cron ('periodic') não é um pedido
  // explícito: fora da janela, PULA graciosamente (sem lançar), audita as
  // contagens, e não marca ninguém. Antes desta correção, TODA execução
  // noturna do cron caía fora da janela padrão e falhava — todo santo dia.
  it('fora da janela + triggeredBy periodic: pula graciosamente, audita, não lança', async () => {
    instancesRepo.listActive.mockResolvedValue([
      {
        ...GOZAP_CHANNEL,
        sendWindowEnabled: true,
        sendWindowStartHour: 8,
        sendWindowEndHour: 9,
      },
    ] as never);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T07:00:00Z')); // 03:00 em Manaus
    try {
      await expect(
        processor.process(makeJob({ triggeredBy: 'periodic' })),
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    expect(wa.checkNumbersOnWhatsappVia).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_skipped_outside_window',
      'Contact',
      undefined,
      expect.objectContaining({
        channelId: 'ch1',
        count: 2,
        triggeredBy: 'periodic',
      }),
    );
  });

  /**
   * ★ REVISÃO FINAL DA FASE B (importante) — o gate de janela já tratava
   * 'periodic' como pulo gracioso, mas o gate de OFFLINE logo abaixo dele
   * abortava ALTO para todo mundo. Com a sessão do GoZap caída (o estado
   * normal quando o QR expira de madrugada), o cron enfileira ~100 lotes e
   * os 100 falham vermelhos, todas as noites — ruído que treina o operador a
   * ignorar o Bull Board justo onde as falhas REAIS aparecem. Nenhum desses
   * jobs fez pedido nenhum: não há o que reportar como erro.
   */
  it('canal offline + triggeredBy periodic: pula graciosamente, audita, não lança', async () => {
    contactsRepo.isSessionChannelOnline.mockResolvedValue(false);

    await expect(
      processor.process(makeJob({ triggeredBy: 'periodic' })),
    ).resolves.toBeUndefined();

    expect(wa.checkNumbersOnWhatsappVia).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_skipped_channel_offline',
      'Contact',
      undefined,
      expect.objectContaining({
        channelId: 'ch1',
        count: 2,
        triggeredBy: 'periodic',
      }),
    );
  });

  // O pedido EXPLÍCITO do operador continua recusando alto: "por que não fez
  // nada?" merece um erro visível, não um log silencioso.
  it('canal offline + trigger não-periódico continua abortando (UnrecoverableError)', async () => {
    contactsRepo.isSessionChannelOnline.mockResolvedValue(false);
    await expect(
      processor.process(makeJob({ triggeredBy: 'backfill' })),
    ).rejects.toThrow(UnrecoverableError);
    expect(audit.log).not.toHaveBeenCalledWith(
      'contact.sync_skipped_channel_offline',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  // O canal caiu DEPOIS de o lote começar: o erro cru do adapter viraria
  // "erro desconhecido" no Bull Board. Reclassificar diz o que houve — e
  // (fix round 1, item #3) o job não retenta contra um canal que já sabemos
  // estar offline.
  it('se o canal cai no meio, o erro vira UnrecoverableError (não retenta)', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511999990001', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockRejectedValue(new Error('socket hang up'));
    contactsRepo.isSessionChannelOnline
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(processor.process(makeJob())).rejects.toThrow(
      UnrecoverableError,
    );
    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_aborted_channel_offline',
      'Contact',
      undefined,
      expect.objectContaining({ channelId: 'ch1' }),
    );
  });

  // ★ REDE DE SEGURANÇA. A pílula de veneno foi curada NA ORIGEM na revisão
  // final da Fase B: o adapter GoZap não lança mais por um 200 irreconhecível
  // — ele encerra o lote e devolve o já consultado, com o restante como
  // `exists: null` (ver gozap-cloud.adapter.spec.ts, C2). Este teste guarda o
  // caminho que sobra: se QUALQUER adapter (ou uma regressão neste) voltar a
  // lançar `gozap.check_unknown_response`, o job morre com UMA tentativa
  // (`UnrecoverableError`, não os 3 attempts do BullMQ contra a mesma
  // resposta) e não marca ninguém.
  it('resposta do /chat/check não reconhecida (poison pill): UnrecoverableError, não marca ninguém, audita', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511999990001', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockRejectedValue(
      new WhatsappSendError(
        'GoZap devolveu uma resposta que o /chat/check não reconhece (sem "IsIn").',
        'gozap.check_unknown_response',
        undefined,
        false,
      ),
    );

    await expect(processor.process(makeJob())).rejects.toThrow(
      UnrecoverableError,
    );

    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_batch_unknown_response',
      'Contact',
      undefined,
      expect.objectContaining({ channelId: 'ch1', count: 1 }),
    );
  });

  it('num canal GOZAP não tenta buscar foto de perfil (o adapter não tem o método)', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511999990001', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: true, jid: '5511999990001@s.whatsapp.net', number: '5511999990001' },
    ]);
    await processor.process(makeJob());
    expect(wa.fetchProfilePictureUrl).not.toHaveBeenCalled();
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({ whatsappValid: true }),
    });
  });

  it('validates a batch and updates whatsappValid + whatsappCheckedAt per contact', async () => {
    instancesRepo.listActive.mockResolvedValue([EVOLUTION_CHANNEL] as never);
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511999990001', whatsappValid: null } as never,
      { id: 'c2', phoneE164: '+5511999990002', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: true, jid: '5511999990001@s.whatsapp.net', number: '5511999990001' },
      { exists: false, jid: null, number: '5511999990002' },
    ]);
    wa.fetchProfilePictureUrl.mockResolvedValue('https://cdn.wa/p.jpg');

    await processor.process(makeJob());

    expect(wa.checkNumbersOnWhatsappVia).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch1' }),
      ['+5511999990001', '+5511999990002'],
    );
    expect(wa.fetchProfilePictureUrl).toHaveBeenCalledWith(
      '5511999990001@s.whatsapp.net',
      'inst-default',
    );
    expect(prisma.contact.update).toHaveBeenCalledTimes(2);
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({
        whatsappValid: true,
        whatsappCheckedAt: expect.any(Date),
        profilePictureUrl: 'https://cdn.wa/p.jpg',
      }),
    });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'c2' },
      data: expect.objectContaining({
        whatsappValid: false,
        whatsappCheckedAt: expect.any(Date),
      }),
    });
  });

  it('does NOT overwrite a cached profilePictureUrl when fetchProfilePictureUrl returns null', async () => {
    // Regression: previously the processor wrote `profilePictureUrl: null`
    // on every successful sync, eventually wiping every cached avatar.
    instancesRepo.listActive.mockResolvedValue([EVOLUTION_CHANNEL] as never);
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511', whatsappValid: true } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: true, jid: '5511@s.whatsapp.net', number: '5511' },
    ]);
    wa.fetchProfilePictureUrl.mockResolvedValue(null);

    await processor.process(makeJob({ contactIds: ['c1'] }));

    const updateCall = (prisma.contact.update as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateCall.data.whatsappValid).toBe(true);
    expect(updateCall.data.whatsappCheckedAt).toBeInstanceOf(Date);
    expect(updateCall.data).not.toHaveProperty('profilePictureUrl');
  });

  it('writes audit.contact.sync_batch with valid/invalid counts', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: true, jid: '5511@s.whatsapp.net', number: '5511' },
    ]);
    wa.fetchProfilePictureUrl.mockResolvedValue(null);

    await processor.process(makeJob({ contactIds: ['c1'], triggeredBy: 'create' }));

    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_batch',
      'Contact',
      undefined,
      expect.objectContaining({
        count: 1,
        validCount: 1,
        invalidCount: 0,
        triggeredBy: 'create',
      }),
    );
  });

  it('logs contact.sync_marked_invalid when contact flips from valid/null → invalid', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511', whatsappValid: true } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: false, jid: null, number: '5511' },
    ]);

    await processor.process(makeJob({ contactIds: ['c1'] }));

    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_marked_invalid',
      'Contact',
      'c1',
      { previousValue: true },
    );
  });

  it('does NOT emit sync_marked_invalid when contact stays invalid', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511', whatsappValid: false } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: false, jid: null, number: '5511' },
    ]);

    await processor.process(makeJob({ contactIds: ['c1'] }));

    const calls = (audit.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('contact.sync_marked_invalid');
  });

  it('silently skips contacts that were deleted between enqueue and processing', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    await processor.process(makeJob());
    expect(wa.checkNumbersOnWhatsappVia).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it('skips quietly when no default connection is configured (no 404 storm)', async () => {
    // Regression: with no DB default the processor used to fall back to the
    // adapter env instance name and fail every job with Evolution 404s.
    instancesRepo.listActive.mockResolvedValue([]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511', whatsappValid: null } as never,
    ]);

    await processor.process(makeJob({ contactIds: ['c1'] }));

    expect(wa.checkNumbersOnWhatsappVia).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it('throws when checkNumbersOnWhatsappVia throws (lets BullMQ retry)', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockRejectedValue(new Error('429 rate limited'));

    await expect(processor.process(makeJob({ contactIds: ['c1'] }))).rejects.toThrow(
      /429/,
    );
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  // --- Characterization tests (lock behavior before COMPLEXITY refactor) ---

  it('classifyByReachability: ignores contacts absent from checkNumbersOnWhatsappVia results', async () => {
    // c2 has no matching entry in the result set (key not in byNumber) → it is
    // neither validated nor invalidated nor counted, and never updated.
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511999990001', whatsappValid: null } as never,
      { id: 'c2', phoneE164: '+5511999990002', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: true, jid: '5511999990001@s.whatsapp.net', number: '5511999990001' },
      // intentionally no entry for 5511999990002
    ]);
    wa.fetchProfilePictureUrl.mockResolvedValue(null);

    await processor.process(makeJob());

    expect(prisma.contact.update).toHaveBeenCalledTimes(1);
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' } }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_batch',
      'Contact',
      undefined,
      expect.objectContaining({ count: 2, validCount: 1, invalidCount: 0 }),
    );
  });

  // Fix round 2 (Task 11 review, design ruling): `exists: null` means
  // UNCONFIRMED (e.g. a GoZap channel's mismatch), not "not on WhatsApp" —
  // it must never be written as `whatsappValid: false`. This test compiles
  // under the widened `WhatsappProvidersService` return type and exercises
  // the processor's own minimal handling (skip + count); the full UI/consumer
  // treatment of "unconfirmed" is Task 12's job, not this processor's.
  it('classifyByReachability: exists:null (unconfirmed) is skipped — no update either way, only counted', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511999990001', whatsappValid: null } as never,
      { id: 'c2', phoneE164: '+5511999990002', whatsappValid: true } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      {
        exists: null,
        jid: null,
        number: '5511999990001',
        reason: 'gozap.check_mismatch',
      },
      { exists: true, jid: '5511999990002@s.whatsapp.net', number: '5511999990002' },
    ]);
    wa.fetchProfilePictureUrl.mockResolvedValue(null);

    await processor.process(makeJob());

    // c1 (null) never gets an update call at all — not valid, not invalid.
    const c1Calls = (prisma.contact.update as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0].where.id === 'c1',
    );
    expect(c1Calls).toHaveLength(0);
    // c2 (confirmed true) still updates normally.
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c2' } }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_batch',
      'Contact',
      undefined,
      expect.objectContaining({
        count: 2,
        validCount: 1,
        invalidCount: 0,
        unknownCount: 1,
      }),
    );
  });

  it('fetchPicturesInParallel: skips fetch for a valid contact whose jid is null and writes no avatar', async () => {
    instancesRepo.listActive.mockResolvedValue([EVOLUTION_CHANNEL] as never);
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: true, jid: null, number: '5511' },
    ]);

    await processor.process(makeJob({ contactIds: ['c1'] }));

    expect(wa.fetchProfilePictureUrl).not.toHaveBeenCalled();
    const updateCall = (prisma.contact.update as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateCall.data.whatsappValid).toBe(true);
    expect(updateCall.data).not.toHaveProperty('profilePictureUrl');
  });

  it('fetchPicturesInParallel: a thrown picture fetch does not abort the batch (treated as no avatar)', async () => {
    instancesRepo.listActive.mockResolvedValue([EVOLUTION_CHANNEL] as never);
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511000000001', whatsappValid: null } as never,
      { id: 'c2', phoneE164: '+5511000000002', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: true, jid: '5511000000001@s.whatsapp.net', number: '5511000000001' },
      { exists: true, jid: '5511000000002@s.whatsapp.net', number: '5511000000002' },
    ]);
    wa.fetchProfilePictureUrl.mockImplementation(async (jid: string) => {
      if (jid === '5511000000001@s.whatsapp.net') throw new Error('boom');
      return 'https://cdn.wa/c2.jpg';
    });

    await processor.process(makeJob());

    expect(prisma.contact.update).toHaveBeenCalledTimes(2);
    const calls = (prisma.contact.update as ReturnType<typeof vi.fn>).mock.calls;
    const c1Data = calls.find((c) => c[0].where.id === 'c1')![0].data as Record<string, unknown>;
    const c2Data = calls.find((c) => c[0].where.id === 'c2')![0].data as Record<string, unknown>;
    expect(c1Data).not.toHaveProperty('profilePictureUrl');
    expect(c2Data.profilePictureUrl).toBe('https://cdn.wa/c2.jpg');
  });

  it('applyValidUpdates: an empty-string fetched URL is NOT written (preserves cached avatar)', async () => {
    instancesRepo.listActive.mockResolvedValue([EVOLUTION_CHANNEL] as never);
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5511', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: true, jid: '5511@s.whatsapp.net', number: '5511' },
    ]);
    wa.fetchProfilePictureUrl.mockResolvedValue('');

    await processor.process(makeJob({ contactIds: ['c1'] }));

    const updateCall = (prisma.contact.update as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateCall.data).not.toHaveProperty('profilePictureUrl');
  });

  it('applyInvalidUpdates: marks invalid + audits only the contacts that flip (null→invalid logs)', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'cFlip', phoneE164: '+5511000000001', whatsappValid: null } as never,
      { id: 'cStay', phoneE164: '+5511000000002', whatsappValid: false } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: false, jid: null, number: '5511000000001' },
      { exists: false, jid: null, number: '5511000000002' },
    ]);

    await processor.process(makeJob({ contactIds: ['cFlip', 'cStay'] }));

    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'cFlip' },
      data: { whatsappValid: false, whatsappCheckedAt: expect.any(Date) },
    });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'cStay' },
      data: { whatsappValid: false, whatsappCheckedAt: expect.any(Date) },
    });
    const invalidLogs = (audit.log as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'contact.sync_marked_invalid',
    );
    expect(invalidLogs).toHaveLength(1);
    expect(invalidLogs[0]).toEqual([
      'contact.sync_marked_invalid',
      'Contact',
      'cFlip',
      { previousValue: null },
    ]);
  });

  it('uses a single shared timestamp for whatsappCheckedAt across valid and invalid writes', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'cValid', phoneE164: '+5511000000001', whatsappValid: null } as never,
      { id: 'cInvalid', phoneE164: '+5511000000002', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      { exists: true, jid: '5511000000001@s.whatsapp.net', number: '5511000000001' },
      { exists: false, jid: null, number: '5511000000002' },
    ]);
    wa.fetchProfilePictureUrl.mockResolvedValue(null);

    await processor.process(makeJob({ contactIds: ['cValid', 'cInvalid'] }));

    const calls = (prisma.contact.update as ReturnType<typeof vi.fn>).mock.calls;
    const validAt = (calls.find((c) => c[0].where.id === 'cValid')![0].data as Record<string, Date>)
      .whatsappCheckedAt;
    const invalidAt = (calls.find((c) => c[0].where.id === 'cInvalid')![0].data as Record<string, Date>)
      .whatsappCheckedAt;
    expect(validAt.getTime()).toBe(invalidAt.getTime());
  });

  /**
   * ★ REVISÃO FINAL DA FASE B (importante) — O NÃO CONFIRMADO ERA REPAGO
   * TODA NOITE.
   *
   * `exists: null` significa NÃO SEI (o `/chat/check` respondeu com o número
   * de outro assinante, ou com um 200 que não reconhecemos). Antes o processor
   * só CONTAVA esses contatos: nada era gravado, nem sequer
   * `whatsappCheckedAt`. Como a seleção do cron é por `whatsappCheckedAt`
   * vencido, o mesmo contato voltava amanhã, e depois de amanhã — consulta
   * real, paga, num cliente não oficial, para receber o mesmo "não sei".
   *
   * A correção grava o CARIMBO (`whatsappCheckedAt`) e MAIS NADA:
   * `whatsappValid` continua intocado, porque "não sei" não é um veredito.
   * Isso mantém o contato dentro do N de "Validar não validados"
   * (`unvalidatedContactWhere` chaveia em `whatsappValid: null`) — o operador
   * pode reexaminar quando quiser — sem deixar o cron martelá-lo diariamente.
   */
  it('exists:null grava whatsappCheckedAt e NADA mais — não vira veredito e não volta amanhã', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'cOk', phoneE164: '+5511000000001', whatsappValid: null } as never,
      {
        id: 'cNaoSei',
        phoneE164: '+5511000000002',
        whatsappValid: null,
      } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      {
        exists: true,
        jid: '5511000000001@s.whatsapp.net',
        number: '5511000000001',
      },
      {
        exists: null,
        jid: null,
        number: '5511000000002',
        reason: 'gozap.check_unknown_response',
      },
    ]);
    wa.fetchProfilePictureUrl.mockResolvedValue(null);

    await processor.process(makeJob({ contactIds: ['cOk', 'cNaoSei'] }));

    // O mock ignora `where`, então o que prova a correção é o ARGUMENTO.
    const bulk = (prisma.contact.updateMany as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(bulk).toHaveLength(1);
    const arg = bulk[0][0] as {
      where: { id: { in: string[] } };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: { in: ['cNaoSei'] } });
    // `whatsappCheckedAt` e SÓ ele: um `whatsappValid: false` aqui
    // transformaria "não sei" em "inválido" durável, e o contato sumiria de
    // toda campanha para sempre.
    expect(Object.keys(arg.data)).toEqual(['whatsappCheckedAt']);
    expect(arg.data.whatsappCheckedAt).toBeInstanceOf(Date);

    // O não confirmado NÃO passa pelo update por contato (que grava veredito).
    const perContact = (
      prisma.contact.update as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id);
    expect(perContact).toEqual(['cOk']);

    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_batch',
      'Contact',
      undefined,
      expect.objectContaining({ unknownCount: 1, validCount: 1 }),
    );
  });

  it('sem nenhum exists:null, não emite updateMany à toa', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'cOk', phoneE164: '+5511000000001', whatsappValid: null } as never,
    ]);
    wa.checkNumbersOnWhatsappVia.mockResolvedValue([
      {
        exists: true,
        jid: '5511000000001@s.whatsapp.net',
        number: '5511000000001',
      },
    ]);
    await processor.process(makeJob({ contactIds: ['cOk'] }));
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });
});
