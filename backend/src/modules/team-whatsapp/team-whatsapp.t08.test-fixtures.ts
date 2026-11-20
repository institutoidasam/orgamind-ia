import { vi } from 'vitest';
import { DelayedError } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { TeamAudiencePreview } from '../../schemas/contracts/team-whatsapp.schema';
import { ChatRepository } from '../chat/chat.repository';
import { ChatService } from '../chat/chat.service';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';
import type {
  LiveCheck,
  LiveCheckChannel,
  LiveState,
} from '../whatsapp-providers/channel-live-state.service';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';
import type { SendChatTextArgs } from '../whatsapp-providers/ports/message-provider.port';
import { TeamRecipientTrackingService } from './tracking/team-recipient-tracking.service';
import { TeamStuckReconcilerService } from './team-stuck-reconciler.service';
import { TeamStuckRecipientsRepository } from './team-stuck-recipients.repository';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import { TeamWhatsappRetryService } from './team-whatsapp-retry.service';
import { TeamWhatsappSendProcessor } from './team-whatsapp-send.processor';
import {
  noticeAt,
  seedPerson,
  seedWorld,
  type RecheckDeps,
} from './team-whatsapp.schedule-recheck.test-fixtures';

/**
 * Harness da suíte T08 (H6, DH11): o envio da equipe ponta a ponta contra
 * Postgres real, só com as portas externas falsas (nunca WhatsApp de verdade).
 * Reais: serviço de envio e de público (os de `RecheckDeps`), repositório,
 * "Repetir", o processor de envio e o `ChatService` com o `ChatRepository`
 * (Message e claim de verdade). Falsos: a porta do provedor (o que o
 * `ChatService` chama no `WhatsappProvidersService`), a porta ao vivo, a fila
 * (imita o BullMQ no que importa) e o Redis do pacing. Reusado pela T8
 * (cenários 4 a 6), que só importa. Não é spec: não roda sozinho.
 *
 * Tempo explícito: a conferência da porta ao vivo e o aceite do provedor têm
 * hora fixa, nunca o relógio.
 */

/** Hora da conferência que a porta ao vivo devolve (`checkedAt`). */
export const T08_CHECKED_AT = new Date('2026-11-20T15:00:00.000Z');
/** Hora de aceite que a porta do provedor devolve (`Message.sentAt`). */
export const T08_ACCEPTED_AT = new Date('2026-11-20T15:00:05.000Z');
/** `attempts` do `defaultJobOptions` da fila de envio da equipe (queue.module). */
export const TEAM_SEND_ATTEMPTS = 3;

/** Roteiro: um passo por chamada, o último se repete; sem roteiro, o padrão. */
function createScript<T>(fallback: T) {
  let steps: T[] = [];
  return {
    respond: (...next: T[]): void => {
      steps = [...next];
    },
    next: (): T => (steps.length > 1 ? steps.shift() : steps[0]) ?? fallback,
  };
}

// ---------------------------------------------------------------------------
// Fila em memória
// ---------------------------------------------------------------------------

export type JobState = 'waiting' | 'delayed' | 'completed' | 'failed';

/**
 * O que o processor lê do job do BullMQ: `data`, `opts.attempts`, `attemptsMade`,
 * `moveToDelayed`; o verificador de presos lê `getState`.
 */
export type MemoryJob = {
  id: string;
  name: string;
  data: TeamWhatsappSendJob;
  opts: { jobId: string; attempts: number };
  attemptsMade: number;
  state: JobState;
  failedReason?: string;
  moveToDelayed: () => Promise<void>;
  getState: () => Promise<JobState>;
};

type AddedJob = {
  name: string;
  data: TeamWhatsappSendJob;
  opts: { jobId: string };
};

/** Só o que a fila usa do processor. */
export type JobRunner = Pick<TeamWhatsappSendProcessor, 'process'>;

/**
 * Uma execução do job com `attemptsMade` igual ao número de falhas até aqui
 * (0 na 1ª): o que o BullMQ faz com `attempts: 3`. `DelayedError` deixa o job
 * adiado (sem nova tentativa); qualquer outro erro conta uma falha e, na
 * última tentativa, o job termina `failed`.
 */
async function runJob(job: MemoryJob, processor: JobRunner): Promise<void> {
  for (let made = 0; made < job.opts.attempts; made++) {
    job.attemptsMade = made;
    try {
      await processor.process(job as never, 'memory-token');
      job.state = 'completed';
      return;
    } catch (err) {
      if (err instanceof DelayedError) {
        job.state = 'delayed';
        return;
      }
      job.failedReason = err instanceof Error ? err.message : String(err);
    }
  }
  job.attemptsMade = job.opts.attempts;
  job.state = 'failed';
}

/** Job recém-adicionado: `attempts` do `defaultJobOptions` e `moveToDelayed` que só adia. */
function newJob(added: AddedJob): MemoryJob {
  const job: MemoryJob = {
    id: added.opts.jobId,
    name: added.name,
    data: added.data,
    opts: { ...added.opts, attempts: TEAM_SEND_ATTEMPTS },
    attemptsMade: 0,
    state: 'waiting',
    moveToDelayed: () => {
      job.state = 'delayed';
      return Promise.resolve();
    },
    getState: () => Promise.resolve(job.state),
  };
  return job;
}

/**
 * Fila que imita o BullMQ no que o envio da equipe depende: `addBulk` guarda
 * por `jobId` e ignora o repetido (como o BullMQ 5 com um job retido);
 * `drain` roda os jobs em espera, na ordem, com até `attempts` tentativas.
 */
export function createMemoryQueue() {
  const jobs = new Map<string, MemoryJob>();
  const store = (added: AddedJob): MemoryJob => {
    const job = newJob(added);
    jobs.set(job.id, job);
    return job;
  };
  return {
    addBulk: (added: AddedJob[]): Promise<MemoryJob[]> =>
      Promise.resolve(
        added.map((one) => jobs.get(one.opts.jobId) ?? store(one)),
      ),
    /** Roda cada job em espera, um de cada vez; devolve os ids que rodaram. */
    async drain(processor: JobRunner): Promise<string[]> {
      const ran: string[] = [];
      for (const job of jobs.values()) {
        if (job.state !== 'waiting') continue;
        await runJob(job, processor);
        ran.push(job.id);
      }
      return ran;
    },
    /**
     * Uma execução do job com `attemptsMade` dado, a que o BullMQ faz ao
     * reexecutar um job (worker que caiu): não mexe no estado do job e deixa
     * subir o que o processor lançar.
     */
    async runAttempt(
      processor: JobRunner,
      jobId: string,
      attemptsMade: number,
    ): Promise<void> {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`job inexistente: ${jobId}`);
      job.attemptsMade = attemptsMade;
      await processor.process(job as never, 'memory-token');
    },
    getJob: (id: string): Promise<MemoryJob | undefined> =>
      Promise.resolve(jobs.get(id)),
    getState: (id: string): Promise<JobState | 'unknown'> =>
      Promise.resolve(jobs.get(id)?.state ?? 'unknown'),
    /** Ids dos jobs na ordem em que entraram. */
    jobIds: (): string[] => [...jobs.keys()],
    /** Job perdido (Redis limpo, worker que nunca o pegou): `getJob` devolve `undefined`. */
    lose: (id: string): boolean => jobs.delete(id),
  };
}
export type MemoryQueue = ReturnType<typeof createMemoryQueue>;

// ---------------------------------------------------------------------------
// Redis do pacing
// ---------------------------------------------------------------------------

/**
 * Redis falso do pacing. O `pacing.helper` só usa dois comandos:
 * `SET pacing:send:lock:<canal> 1 PX <ttl> NX` (`acquirePacingLock`; `null` se
 * o lock está preso) e `DEL pacing:send:lock:<canal>` (`releasePacingLock` e a
 * falha do processor). O atraso anti-ban de 10 a 45 s do `releasePacingLock`
 * não é do Redis: o spec troca só o `sleepFn` dele (vi.mock com o original).
 */
export function createPacingRedis() {
  const locks = new Map<string, string>();
  return {
    set: vi.fn((key: string, value: string, ...flags: unknown[]) => {
      if (flags.includes('NX') && locks.has(key)) return Promise.resolve(null);
      locks.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => Promise.resolve(locks.delete(key) ? 1 : 0)),
    /** Chaves de lock que ficaram presas. */
    held: (): string[] => [...locks.keys()],
  };
}
export type PacingRedis = ReturnType<typeof createPacingRedis>;

// ---------------------------------------------------------------------------
// Porta ao vivo
// ---------------------------------------------------------------------------

/**
 * `ChannelLiveStateService` falso: `check` (processor) e `checkMany` (POST de
 * envio) respondem pelo roteiro de `respond(...estados)`, um por conferência, o
 * último se repete; sem roteiro, `open`. Todo estado vem com `checkedAt` fixo.
 */
export function createLivePort() {
  const script = createScript<LiveState>('open');
  const observe = (channel: LiveCheckChannel): LiveCheck => ({
    channelId: channel.id,
    state: script.next(),
    checkedAt: T08_CHECKED_AT,
  });
  return {
    respond: script.respond,
    check: vi.fn((channel: LiveCheckChannel) =>
      Promise.resolve(observe(channel)),
    ),
    checkMany: vi.fn((channels: readonly LiveCheckChannel[]) =>
      Promise.resolve(
        new Map(channels.map((c) => [c.id, observe(c)] as const)),
      ),
    ),
  };
}
export type LivePort = ReturnType<typeof createLivePort>;

// ---------------------------------------------------------------------------
// Porta do provedor
// ---------------------------------------------------------------------------

/** `Message.providerMessageId` é @unique: o contador vale para o arquivo todo, não por porta. */
let acceptedSeq = 0;

export type ProviderOutcome = 'accept' | 'not_connected' | 'timeout';
export type ProviderCall = { messageId: string; toE164: string };

/** Os erros do `evolution-error-mapper`: ambos `fatal: false`. */
const PROVIDER_ERRORS = {
  not_connected: [
    'evolution.not_connected',
    'WhatsApp ainda não conectou. Acesse /connect e escaneie o QR Code antes de disparar.',
  ],
  timeout: ['evolution.timeout', 'Timeout ao falar com a Evolution API.'],
} as const;

/**
 * A Message que o `ChatService` acabou de pôr em SENDING para este envio. O
 * `sendChatText` não recebe o `messageId`: ele sai da linha SENDING da conversa
 * do telefone (o claim de verdade vem antes da chamada; sem ele, o teste falha).
 */
async function sendingMessageOf(
  prisma: PrismaClient,
  args: SendChatTextArgs,
): Promise<string> {
  const message = await prisma.message.findFirstOrThrow({
    where: {
      status: 'SENDING',
      conversation: {
        instance: { evolutionInstanceName: args.instanceName },
        OR: [{ phoneE164: args.toE164 }, { remoteJid: args.toE164 }],
      },
    },
    select: { id: true },
  });
  return message.id;
}

/**
 * `WhatsappProvidersService` falso, o que o `ChatService` usa para o canal
 * EVOLUTION (`supportsInboxChatFor` e `sendChatText`). Anota cada chamada por
 * `messageId` e responde pelo roteiro de `respond(...desfechos)`, um por
 * chamada, o último se repete; sem roteiro, aceita. Nunca fala com a Evolution.
 */
export function createProviderPort(prisma: PrismaClient) {
  const calls: ProviderCall[] = [];
  const script = createScript<ProviderOutcome>('accept');
  return {
    respond: script.respond,
    supportsInboxChatFor: vi.fn(() => true),
    sendChatText: vi.fn(async (args: SendChatTextArgs) => {
      const messageId = await sendingMessageOf(prisma, args);
      calls.push({ messageId, toE164: args.toE164 });
      const outcome = script.next();
      if (outcome !== 'accept') {
        const [code, message] = PROVIDER_ERRORS[outcome];
        throw new WhatsappSendError(message, code, 'provedor falso', false);
      }
      return {
        providerMessageId: `wamid-falso-${++acceptedSeq}`,
        acceptedAt: T08_ACCEPTED_AT,
      };
    }),
    /** Todas as chamadas, na ordem. */
    calls,
    /** Quantas vezes o provedor foi chamado para esta Message. */
    callsOf: (messageId: string): number =>
      calls.filter((call) => call.messageId === messageId).length,
  };
}
export type ProviderPort = ReturnType<typeof createProviderPort>;

// ---------------------------------------------------------------------------
// O mundo
// ---------------------------------------------------------------------------

function buildChat(prisma: PrismaClient, provider: ProviderPort): ChatService {
  return new ChatService(
    new ChatRepository(prisma as never),
    { publish: vi.fn().mockResolvedValue(undefined) } as never,
    provider as never,
    prisma as never,
    { log: vi.fn() } as never,
  );
}

function buildProcessor(
  deps: RecheckDeps,
  chat: ChatService,
  live: LivePort,
  pacing: PacingRedis,
): TeamWhatsappSendProcessor {
  const processor = new TeamWhatsappSendProcessor(
    deps.prisma as never,
    chat,
    { isSuppressed: vi.fn().mockResolvedValue(false) } as never,
    pacing as never,
  );
  // `repo` e `liveState` são injetados por propriedade no Nest; aqui, à mão.
  Object.assign(processor, { repo: deps.repo, liveState: live });
  return processor;
}

/** Setor com número EVOLUTION, um ADMIN e três pessoas autorizadas, do 1º turno. */
async function seedSite(deps: RecheckDeps) {
  const site = await seedWorld(deps);
  const people = await Promise.all(
    ['Ana', 'Bia', 'Caio'].map((name) => seedPerson(deps, site, name)),
  );
  const sector = await deps.prisma.sector.findUniqueOrThrow({
    where: { id: site.sectorId },
    select: { channelId: true },
  });
  if (!sector.channelId) throw new Error('setor semeado sem número');
  return { site, people, channelId: sector.channelId };
}

/**
 * Um mundo novo por cenário: setor, número e pessoas próprios no banco do
 * `deps` (os cenários não se enxergam), e fakes novos. O `TeamWhatsappService`
 * de `deps` é um só: o mundo religa nele a fila e a porta ao vivo dele, então
 * os testes de um arquivo rodam em série (como o `it` de um spec).
 */
export async function buildT08World(deps: RecheckDeps) {
  const { site, people, channelId } = await seedSite(deps);
  const queue = createMemoryQueue();
  const live = createLivePort();
  const provider = createProviderPort(deps.prisma);
  const pacing = createPacingRedis();
  const chat = buildChat(deps.prisma, provider);
  const processor = buildProcessor(deps, chat, live, pacing);
  const retry = new TeamWhatsappRetryService(
    deps.repo,
    deps.audit as never,
    queue as never,
  );
  Object.assign(deps.service, { live, queue });
  /** Aviso de turno para agora, o público inteiro do setor. */
  const request = noticeAt(site, { when: 'now', at: undefined });
  const preview = () => deps.audience.preview(site.adminId, request);
  const confirm = (shown: Pick<TeamAudiencePreview, 'audienceKey'>) =>
    deps.service.dispatch(site.adminId, {
      ...request,
      audienceKey: shown.audienceKey,
    });
  return {
    deps,
    site,
    people,
    channelId,
    queue,
    live,
    provider,
    pacing,
    chat,
    processor,
    retry,
    /** Prévia do público (a tela, antes de confirmar). */
    preview,
    /** Confirmação do envio com a impressão da prévia (o POST). */
    confirm,
    /** Prévia e confirmação em seguida: o caminho feliz da tela. */
    sendNow: async () => confirm(await preview()),
    /** "Repetir" todas as falhas certas do envio, como o ADMIN do setor. */
    retryAll: (dispatchId: string) =>
      retry.retry(site.adminId, dispatchId, { all: true }),
    recipients: (dispatchId: string) => recipientRows(deps.prisma, dispatchId),
    messages: () => messageRows(deps.prisma, channelId),
  };
}
export type T08World = Awaited<ReturnType<typeof buildT08World>>;

/** Destinatários do envio como o banco guarda, na ordem do nome. */
export const recipientRows = (prisma: PrismaClient, dispatchId: string) =>
  prisma.teamWhatsappRecipient.findMany({
    where: { dispatchId },
    orderBy: { userName: 'asc' },
    select: {
      id: true,
      userName: true,
      status: true,
      errorCode: true,
      skipReason: true,
      attempts: true,
      manualRetries: true,
      messageId: true,
      acceptedAt: true,
      channelCheckedAt: true,
    },
  });
export type RecipientRow = Awaited<ReturnType<typeof recipientRows>>[number];

/** Mensagens do número, na ordem em que foram criadas. */
export const messageRows = (prisma: PrismaClient, channelId: string) =>
  prisma.message.findMany({
    where: { instanceId: channelId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      status: true,
      errorCode: true,
      sentAt: true,
      providerMessageId: true,
    },
  });
export type MessageRow = Awaited<ReturnType<typeof messageRows>>[number];

// ---------------------------------------------------------------------------
// Rastreio, verificador de presos e visão da API (T8, cenários 4 a 6)
// ---------------------------------------------------------------------------

/** Minutos parado do preso: mais que o limiar de 30 min do verificador (H2). */
const STRANDED_MINUTES = 31;

/**
 * O que o harness não expõe, de verdade e sobre o mesmo banco: o rastreio dos
 * recibos e o verificador de presos (`TeamStuckReconcilerService` sobre o
 * `TeamStuckRecipientsRepository`), com a fila em memória do mundo (`getJob`,
 * `getState`) e o `ChatService` real (`isRedispatchableFailure`). A trilha do
 * verificador cai no `deps.audit.log` falso.
 */
export function buildStuckTools(w: T08World) {
  const prisma = w.deps.prisma as never;
  const tracking = new TeamRecipientTrackingService(prisma);
  const reconciler = new TeamStuckReconcilerService(
    new TeamStuckRecipientsRepository(prisma),
    w.chat,
    w.deps.audit as never,
    w.queue as never,
  );
  return { tracking, reconciler };
}

/**
 * Deixa o destinatário como a queda do worker o deixa: `QUEUED`, sem desfecho
 * nem aceite gravados, parado há 31 min antes de `now` (SQL cru: o @updatedAt
 * do Prisma sobrescreve). A Message e o resto da tentativa ficam como estão.
 */
export async function strand(
  prisma: PrismaClient,
  id: string,
  now: Date,
): Promise<void> {
  const since = new Date(now.getTime() - STRANDED_MINUTES * 60_000);
  await prisma.$executeRaw`
    UPDATE "TeamWhatsappRecipient"
    SET "status" = 'QUEUED', "errorCode" = NULL, "acceptedAt" = NULL,
        "updatedAt" = ${since}
    WHERE "id" = ${id}`;
}

/** Outro worker segura o lock de pacing do número: os jobs do envio ficam `delayed` (`waitPacing`). */
export async function holdChannel(
  w: Pick<T08World, 'pacing' | 'channelId'>,
): Promise<void> {
  await w.pacing.set(
    `pacing:send:lock:${w.channelId}`,
    'outro-worker',
    'PX',
    600_000,
    'NX',
  );
}

/** Os destinatários como a API de resultado os devolve ao ADMIN do setor (nome e telefone completos). */
export async function listedRecipients(w: T08World, dispatchId: string) {
  const results = new TeamWhatsappResultsService(w.deps.repo);
  const page = await results.recipients(w.site.adminId, dispatchId, {
    page: 1,
    pageSize: 50,
  });
  return page.items;
}

/** O destinatário como o banco o guarda (falha se ele não é do envio). */
export async function recipientOf(
  w: T08World,
  dispatchId: string,
  id: string,
): Promise<RecipientRow> {
  const row = (await w.recipients(dispatchId)).find((r) => r.id === id);
  if (!row) throw new Error(`destinatário ${id} fora do envio`);
  return row;
}

/** O destinatário como a API de resultado o mostra (falha se ele não é do envio). */
export async function itemOf(w: T08World, dispatchId: string, id: string) {
  const item = (await listedRecipients(w, dispatchId)).find((i) => i.id === id);
  if (!item) throw new Error(`destinatário ${id} fora do envio`);
  return item;
}
