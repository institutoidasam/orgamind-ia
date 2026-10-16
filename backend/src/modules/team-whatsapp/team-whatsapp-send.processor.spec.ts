import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import {
  mockDeep,
  type MockProxy,
  type DeepMockProxy,
} from 'vitest-mock-extended';
import { DelayedError, type Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { TeamWhatsappSendProcessor } from './team-whatsapp-send.processor';
import {
  ChatService,
  ChatProviderNoReplyError,
  type TeamSendResult,
} from '../chat/chat.service';
import { ConsentService } from '../consent/consent.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ConflictError } from '../../shared/errors/domain.error';
import {
  acquirePacingLock,
  releasePacingLock,
} from '../campaigns/pacing.helper';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';

vi.mock('../campaigns/pacing.helper', () => ({
  acquirePacingLock: vi.fn(),
  releasePacingLock: vi.fn(),
  PACING_JITTER_MIN_MS: 10000,
}));

const PHONE = '+5592991234567';
const TEXT = 'Oi equipe';
const SENT_OK: TeamSendResult = {
  messageId: 'm1',
  sent: true,
  errorCode: null,
  retryable: false,
};
const failed = (
  errorCode: string | null,
  retryable: boolean,
): TeamSendResult => ({ messageId: 'm1', sent: false, errorCode, retryable });

function makeRecipient(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    status: 'QUEUED',
    messageId: null,
    user: { phoneE164: PHONE, contact: { id: 'c1', phoneE164: PHONE } },
    dispatch: {
      id: 'd1',
      authorId: 'u-admin',
      text: TEXT,
      channel: { id: 'ch1', provider: 'GOZAP', isActive: true },
    },
    ...over,
  };
}

function makeJob(attemptsMade = 0, moveToDelayed = vi.fn()) {
  return {
    data: { recipientId: 'r1' },
    attemptsMade,
    opts: { attempts: 3 },
    moveToDelayed,
  } as unknown as Job<TeamWhatsappSendJob>;
}

let prisma: DeepMockProxy<PrismaService>;
let chat: MockProxy<ChatService>;
let consent: MockProxy<ConsentService>;
let redis: DeepMockProxy<Redis>;
let proc: TeamWhatsappSendProcessor;
const LOCK_KEY = 'pacing:send:lock:ch1';

beforeEach(() => {
  vi.mocked(acquirePacingLock)
    .mockReset()
    .mockResolvedValue({ acquired: true });
  vi.mocked(releasePacingLock).mockReset().mockResolvedValue(undefined);
  prisma = mockDeep<PrismaService>();
  chat = mockDeep<ChatService>();
  consent = mockDeep<ConsentService>();
  consent.isSuppressed.mockResolvedValue(false);
  prisma.teamWhatsappRecipient.findUnique.mockResolvedValue(
    makeRecipient() as never,
  );
  prisma.teamWhatsappRecipient.updateMany.mockResolvedValue({
    count: 1,
  });
  chat.prepareTeamMessage.mockResolvedValue({ messageId: 'm1' });
  chat.sendTeamMessage.mockResolvedValue(SENT_OK);
  redis = mockDeep<Redis>();
  redis.del.mockResolvedValue(1);
  proc = new TeamWhatsappSendProcessor(prisma, chat, consent, redis);
});

type RecipientWrite = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};
const writes = () =>
  prisma.teamWhatsappRecipient.updateMany.mock.calls.map(
    ([a]) => a as unknown as RecipientWrite,
  );
const statusWrites = () => writes().filter((w) => 'status' in w.data);
const lastData = () => writes().at(-1)?.data;
const withPrior = (
  row: { status: string; errorCode: string | null } | null,
) => {
  prisma.teamWhatsappRecipient.findUnique.mockResolvedValue(
    makeRecipient({ messageId: 'm1' }) as never,
  );
  prisma.message.findUnique.mockResolvedValue(row as never);
};

describe('TeamWhatsappSendProcessor — pré-checagens', () => {
  it('status diferente de QUEUED não reenvia', async () => {
    prisma.teamWhatsappRecipient.findUnique.mockResolvedValue(
      makeRecipient({ status: 'SENT' }) as never,
    );
    await proc.process(makeJob());
    expect(chat.prepareTeamMessage.mock.calls).toHaveLength(0);
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
    expect(writes()).toEqual([]);
  });

  it('SAIR depois de enfileirar vira SKIPPED/SUPPRESSED', async () => {
    consent.isSuppressed.mockResolvedValue(true);
    await proc.process(makeJob());
    expect(prisma.teamWhatsappRecipient.updateMany.mock.calls).toContainEqual([
      {
        where: { id: 'r1', status: 'QUEUED' },
        data: { status: 'SKIPPED', skipReason: 'SUPPRESSED' },
      },
    ]);
    expect(consent.isSuppressed.mock.calls).toContainEqual([PHONE]);
    expect(chat.prepareTeamMessage.mock.calls).toHaveLength(0);
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
    expect(acquirePacingLock).not.toHaveBeenCalled();
  });
});

describe('TeamWhatsappSendProcessor — pré-checagens (telefone)', () => {
  it.each([
    ['sem telefone', { phoneE164: null, contact: null }],
    ['usuário removido', null],
  ])(
    'usuário perdeu o telefone vira SKIPPED/NO_PHONE (%s)',
    async (_n, user) => {
      prisma.teamWhatsappRecipient.findUnique.mockResolvedValue(
        makeRecipient({ user }) as never,
      );
      await proc.process(makeJob());
      expect(lastData()).toEqual({ status: 'SKIPPED', skipReason: 'NO_PHONE' });
      expect(chat.prepareTeamMessage.mock.calls).toHaveLength(0);
    },
  );
});

describe('TeamWhatsappSendProcessor — pré-checagens (canal)', () => {
  it.each([
    ['desativado', { id: 'ch1', provider: 'GOZAP', isActive: false }],
    ['removido', null],
    [
      'fora de TEAM_PROVIDERS',
      { id: 'ch1', provider: 'TWILIO', isActive: true },
    ],
  ])('canal %s vira FAILED channel_invalid', async (_n, channel) => {
    const r = makeRecipient();
    prisma.teamWhatsappRecipient.findUnique.mockResolvedValue({
      ...r,
      dispatch: { ...r.dispatch, channel },
    } as never);
    await proc.process(makeJob());
    expect(lastData()).toEqual({
      status: 'FAILED',
      errorCode: 'team_whatsapp.channel_invalid',
    });
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
    expect(acquirePacingLock).not.toHaveBeenCalled();
  });
});

describe('TeamWhatsappSendProcessor — envio e retentativa', () => {
  it('envio ok: prepara uma vez, grava o messageId antes do envio, marca SENT e solta o pacing', async () => {
    await proc.process(makeJob());
    expect(chat.prepareTeamMessage.mock.calls).toHaveLength(1);
    expect(chat.prepareTeamMessage.mock.calls).toContainEqual([
      {
        instanceId: 'ch1',
        contactId: 'c1',
        phoneE164: PHONE,
        text: TEXT,
        authorUserId: 'u-admin',
      },
    ]);
    const upd = prisma.teamWhatsappRecipient.updateMany.mock;
    expect(upd.calls[0]).toEqual([
      {
        where: { id: 'r1', status: 'QUEUED', messageId: null },
        data: { messageId: 'm1' },
      },
    ]);
    expect(upd.invocationCallOrder[0]).toBeLessThan(
      chat.sendTeamMessage.mock.invocationCallOrder[0],
    );
    expect(chat.sendTeamMessage.mock.calls).toContainEqual([
      { messageId: 'm1', text: TEXT },
    ]);
    expect(upd.calls[1]).toEqual([
      {
        where: { id: 'r1', status: 'QUEUED' },
        data: { status: 'SENT', messageId: 'm1' },
      },
    ]);
    expect(acquirePacingLock).toHaveBeenCalledWith(expect.anything(), 'ch1');
    expect(releasePacingLock).toHaveBeenCalledWith(
      expect.anything(),
      'ch1',
      expect.anything(),
    );
  });
});

describe('TeamWhatsappSendProcessor — pacing e retentativa', () => {
  it('pacing ocupado adia o job sem preparar nem enviar', async () => {
    vi.mocked(acquirePacingLock).mockResolvedValue({
      acquired: false,
      retryDelayMs: 5000,
    });
    const moveToDelayed = vi.fn();
    const job = makeJob(0, moveToDelayed);
    await expect(proc.process(job, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed.mock.calls).toContainEqual([
      expect.any(Number),
      'tok',
    ]);
    expect(chat.prepareTeamMessage.mock.calls).toHaveLength(0);
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
    expect(releasePacingLock).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('erro retentável relança e a última tentativa marca FAILED', async () => {
    chat.sendTeamMessage.mockResolvedValue(
      failed('evolution.not_connected', true),
    );
    await expect(proc.process(makeJob(0))).rejects.toThrow(
      'team_whatsapp.retry:evolution.not_connected',
    );
    expect(statusWrites()).toEqual([]);
    expect(releasePacingLock).not.toHaveBeenCalled();
    expect(redis.del.mock.calls).toEqual([[LOCK_KEY]]);
    withPrior({ status: 'FAILED', errorCode: 'evolution.not_connected' });
    chat.isRedispatchableFailure.mockReturnValue(true);
    await expect(proc.process(makeJob(2))).resolves.toBeUndefined();
    expect(lastData()).toEqual({
      status: 'FAILED',
      errorCode: 'evolution.not_connected',
      messageId: 'm1',
    });
  });
});

describe('TeamWhatsappSendProcessor — falha final', () => {
  it.each([['gozap.invalid_recipient'], ['gozap.timeout']])(
    'erro não retentável (%s) marca FAILED sem relançar',
    async (code) => {
      chat.sendTeamMessage.mockResolvedValue(failed(code, false));
      await expect(proc.process(makeJob(0))).resolves.toBeUndefined();
      expect(lastData()).toEqual({
        status: 'FAILED',
        errorCode: code,
        messageId: 'm1',
      });
    },
  );

  it('falha sem código marca FAILED send_failed sem relançar', async () => {
    chat.sendTeamMessage.mockResolvedValue(failed(null, false));
    await expect(proc.process(makeJob(0))).resolves.toBeUndefined();
    expect(lastData()).toEqual({
      status: 'FAILED',
      errorCode: 'team_whatsapp.send_failed',
      messageId: 'm1',
    });
  });
});

describe('TeamWhatsappSendProcessor — idempotência por priorOutcome', () => {
  it('retentativa reaproveita o messageId (FAILED redispatchável)', async () => {
    withPrior({ status: 'FAILED', errorCode: 'evolution.not_connected' });
    chat.isRedispatchableFailure.mockReturnValue(true);
    await proc.process(makeJob(1));
    expect(chat.isRedispatchableFailure.mock.calls).toContainEqual([
      'evolution.not_connected',
    ]);
    expect(chat.prepareTeamMessage.mock.calls).toHaveLength(0);
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(1);
    expect(chat.sendTeamMessage.mock.calls).toContainEqual([
      { messageId: 'm1', text: TEXT },
    ]);
    expect(lastData()).toEqual({ status: 'SENT', messageId: 'm1' });
  });

  it.each([['gozap.timeout'], [null]])(
    'retentativa com Message FAILED (%s) não reenvia',
    async (code) => {
      withPrior({ status: 'FAILED', errorCode: code });
      chat.isRedispatchableFailure.mockReturnValue(false);
      await proc.process(makeJob(1));
      expect(lastData()).toEqual({
        status: 'FAILED',
        errorCode: 'team_whatsapp.indeterminate',
      });
      expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
      expect(acquirePacingLock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['SENDING'],
    ['CANCELLED'],
    ['WAITING_INSTANCE'],
    ['RECEIVED'],
    ['SKIPPED_SUPPRESSED'],
  ])('retentativa com Message %s não reenvia', async (status) => {
    withPrior({ status, errorCode: null });
    await proc.process(makeJob(1));
    expect(lastData()).toEqual({
      status: 'FAILED',
      errorCode: 'team_whatsapp.indeterminate',
    });
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
  });
});

describe('TeamWhatsappSendProcessor — priorOutcome entregue ou sumido', () => {
  it.each([['SENT'], ['DELIVERED'], ['READ']])(
    'retentativa com Message %s grava SENT sem reenviar',
    async (status) => {
      withPrior({ status, errorCode: null });
      await proc.process(makeJob(1));
      expect(lastData()).toEqual({ status: 'SENT' });
      expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
      expect(acquirePacingLock).not.toHaveBeenCalled();
    },
  );

  it('retentativa com Message ainda QUEUED reenvia a mesma linha; linha sumida vira message_missing', async () => {
    withPrior({ status: 'QUEUED', errorCode: null });
    await proc.process(makeJob(1));
    expect(chat.prepareTeamMessage.mock.calls).toHaveLength(0);
    expect(chat.sendTeamMessage.mock.calls).toContainEqual([
      { messageId: 'm1', text: TEXT },
    ]);
    chat.sendTeamMessage.mockClear();
    withPrior(null);
    await proc.process(makeJob(1));
    expect(lastData()).toEqual({
      status: 'FAILED',
      errorCode: 'team_whatsapp.message_missing',
    });
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
  });
});

describe('TeamWhatsappSendProcessor — idempotência entre execuções', () => {
  it('destinatário sumido não faz nada', async () => {
    prisma.teamWhatsappRecipient.findUnique.mockResolvedValue(null);
    await proc.process(makeJob());
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
    expect(writes()).toEqual([]);
  });

  it('falha no settle após SENT não reenvia', async () => {
    prisma.teamWhatsappRecipient.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('db'));
    await expect(proc.process(makeJob(0))).rejects.toThrow(
      'team_whatsapp.unexpected:Error',
    );
    vi.mocked(acquirePacingLock).mockClear();
    withPrior({ status: 'SENT', errorCode: null });
    await proc.process(makeJob(1));
    expect(lastData()).toEqual({ status: 'SENT' });
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(1);
    expect(acquirePacingLock).not.toHaveBeenCalled();
  });

  it('gravação do messageId sem efeito (outra execução já gravou) não envia', async () => {
    prisma.teamWhatsappRecipient.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    await expect(proc.process(makeJob(0))).rejects.toMatchObject({
      code: 'team_whatsapp.not_claimed',
    });
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
    expect(statusWrites()).toEqual([]);
    expect(releasePacingLock).not.toHaveBeenCalled();
    expect(redis.del.mock.calls).toEqual([[LOCK_KEY]]);
  });

  it('claim recusado (team_whatsapp.not_claimed) fora da última tentativa relança sem marcar', async () => {
    chat.sendTeamMessage.mockRejectedValue(
      new ConflictError('claimed', 'team_whatsapp.not_claimed'),
    );
    await expect(proc.process(makeJob(0))).rejects.toThrow();
    expect(writes()).toEqual([
      {
        where: { id: 'r1', status: 'QUEUED', messageId: null },
        data: { messageId: 'm1' },
      },
    ]);
  });
});

describe('TeamWhatsappSendProcessor — exceções na última tentativa', () => {
  it.each([
    [
      'ChatProviderNoReplyError',
      new ChatProviderNoReplyError('GOZAP'),
      'chat.provider_no_inbox_reply',
    ],
  ])(
    'exceção (%s) na última tentativa marca FAILED e relança',
    async (_n, err, code) => {
      chat.prepareTeamMessage.mockRejectedValue(err);
      await expect(proc.process(makeJob(2))).rejects.toBe(err);
      expect(lastData()).toEqual({ status: 'FAILED', errorCode: code });
    },
  );

  it('erro genérico na última tentativa marca FAILED e relança só o código', async () => {
    chat.prepareTeamMessage.mockRejectedValue(new Error('redis'));
    await expect(proc.process(makeJob(2))).rejects.toThrow(
      'team_whatsapp.unexpected:Error',
    );
    expect(lastData()).toEqual({
      status: 'FAILED',
      errorCode: 'team_whatsapp.send_failed',
    });
  });

  it('exceção fora da última tentativa relança sem finish', async () => {
    chat.prepareTeamMessage.mockRejectedValue(new Error('redis'));
    await expect(proc.process(makeJob(0))).rejects.toThrow(
      'team_whatsapp.unexpected:Error',
    );
    expect(writes()).toEqual([]);
  });

  it('load rejeitando na última tentativa grava o FAILED padrão pelo recipientId do job', async () => {
    prisma.teamWhatsappRecipient.findUnique.mockRejectedValue(new Error('db'));
    await expect(proc.process(makeJob(2))).rejects.toThrow(
      'team_whatsapp.unexpected:Error',
    );
    expect(writes().at(-1)).toEqual({
      where: { id: 'r1', status: 'QUEUED' },
      data: { status: 'FAILED', errorCode: 'team_whatsapp.send_failed' },
    });
  });
});

describe('TeamWhatsappSendProcessor — exceção com Message já gravada', () => {
  it.each([
    ['SENT', { status: 'SENT' }],
    ['SENDING', { status: 'FAILED', errorCode: 'team_whatsapp.indeterminate' }],
  ])(
    'exceção na última tentativa com Message já %s não rebaixa o envio',
    async (status, expected) => {
      prisma.teamWhatsappRecipient.findUnique
        .mockResolvedValueOnce(makeRecipient() as never)
        .mockResolvedValueOnce({ messageId: 'm1' } as never);
      prisma.teamWhatsappRecipient.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error('db'))
        .mockResolvedValueOnce({ count: 1 });
      prisma.message.findUnique.mockResolvedValue({
        status,
        errorCode: null,
      } as never);
      await expect(proc.process(makeJob(2))).rejects.toThrow(
        'team_whatsapp.unexpected:Error',
      );
      expect(lastData()).toEqual(expected);
      expect(chat.sendTeamMessage.mock.calls).toHaveLength(1);
    },
  );
});

describe('TeamWhatsappSendProcessor — log', () => {
  const spies: MockInstance[] = [];
  beforeEach(() => {
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      spies.push(
        vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      );
    }
  });
  afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

  it('nenhum log leva texto ou telefone', async () => {
    chat.sendTeamMessage.mockResolvedValue(
      failed('gozap.invalid_recipient', false),
    );
    await proc.process(makeJob(0));
    chat.prepareTeamMessage.mockRejectedValue(
      new Error(`falhou para ${PHONE}: ${TEXT}`),
    );
    await expect(proc.process(makeJob(2))).rejects.toThrow();
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(spies.some((s) => s.mock.calls.length > 0)).toBe(true);
    expect(logged).toContain('r1');
    expect(logged).not.toContain(TEXT);
    expect(logged).not.toContain(PHONE);
  });
});

/** Classificação REAL do ChatService (o `chat` deste spec é mock). */
const realChat = Object.create(ChatService.prototype) as ChatService;

describe('TeamWhatsappSendProcessor — código que nunca reenvia', () => {
  it.each([['evolution.timeout'], ['evolution.unknown'], ['sending_stuck']])(
    'retentativa com Message FAILED (%s) vira FAILED sem chamar o provedor',
    async (code) => {
      withPrior({ status: 'FAILED', errorCode: code });
      chat.isRedispatchableFailure.mockImplementation((c) =>
        realChat.isRedispatchableFailure(c),
      );
      await proc.process(makeJob(1));
      expect(lastData()).toEqual({
        status: 'FAILED',
        errorCode: 'team_whatsapp.indeterminate',
      });
      expect(chat.prepareTeamMessage.mock.calls).toHaveLength(0);
      expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
      expect(acquirePacingLock).not.toHaveBeenCalled();
    },
  );
});

describe('TeamWhatsappSendProcessor — liberação do pacing', () => {
  it('falha do envio solta o lock na hora, sem o atraso anti-ban', async () => {
    chat.sendTeamMessage.mockResolvedValue(
      failed('gozap.invalid_recipient', false),
    );
    await proc.process(makeJob(0));
    expect(releasePacingLock).not.toHaveBeenCalled();
    expect(redis.del.mock.calls).toEqual([[LOCK_KEY]]);
  });

  it('exceção antes do envio também solta o lock na hora', async () => {
    chat.prepareTeamMessage.mockRejectedValue(new Error('db'));
    await expect(proc.process(makeJob(0))).rejects.toThrow();
    expect(releasePacingLock).not.toHaveBeenCalled();
    expect(redis.del.mock.calls).toEqual([[LOCK_KEY]]);
  });

  it('envio que saiu segura o lock pelo atraso mesmo se o settle falhar', async () => {
    prisma.teamWhatsappRecipient.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('db'));
    await expect(proc.process(makeJob(0))).rejects.toThrow();
    expect(releasePacingLock).toHaveBeenCalledWith(
      redis,
      'ch1',
      expect.anything(),
    );
    expect(redis.del.mock.calls).toEqual([]);
  });
});

class PrismaClientValidationError extends Error {
  override name = 'PrismaClientValidationError';
}

describe('TeamWhatsappSendProcessor — erro relançado ao BullMQ', () => {
  it.each([[0], [2]])(
    'tentativa %s: mensagem e stack só com código, sem telefone nem texto',
    async (attempt) => {
      chat.prepareTeamMessage.mockRejectedValue(
        new PrismaClientValidationError(
          `Invalid args { content: "${TEXT}", remoteJid: "${PHONE}" }`,
        ),
      );
      const err = await proc
        .process(makeJob(attempt))
        .catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(
        'team_whatsapp.unexpected:PrismaClientValidationError',
      );
      const stored = `${(err as Error).message}\n${(err as Error).stack}`;
      expect(stored).not.toContain(TEXT);
      expect(stored).not.toContain(PHONE);
    },
  );
});

describe('TeamWhatsappSendProcessor — envio provado e supressão posterior', () => {
  it('Message SENT + telefone suprimido na retentativa → SENT, sem envio', async () => {
    withPrior({ status: 'SENT', errorCode: null });
    consent.isSuppressed.mockResolvedValue(true);
    await proc.process(makeJob(1));
    expect(statusWrites()).toEqual([
      { where: { id: 'r1', status: 'QUEUED' }, data: { status: 'SENT' } },
    ]);
    expect(chat.prepareTeamMessage.mock.calls).toHaveLength(0);
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
    expect(acquirePacingLock).not.toHaveBeenCalled();
  });
});
