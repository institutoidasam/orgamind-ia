import { Injectable } from '@nestjs/common';
import type { ZernioSyncRun } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { ZernioInboxSyncResult } from './zernio-inbox-sync.service';

/** Estados em que o run ainda tem trabalho pela frente. */
const ACTIVE_STATUSES = ['PENDING', 'RUNNING', 'PAUSED'] as const;

export type ZernioSyncProgressPatch = {
  totalConversations: number;
  processedConversations: number;
  importedMessages: number;
  failedConversations: number;
  cursor?: string | null;
};

/**
 * O livro-caixa do sync do inbox: uma linha por execução, com progresso.
 *
 * Existe porque o sync deixou de ser uma request síncrona (que percorria ~100
 * conversas e devolvia 500 quando o Zernio recusava a 61ª) e virou um JOB. Um
 * job sem registro é uma caixa-preta: o operador clica e não sabe se roda, se
 * travou ou se acabou. Estas linhas são o que a tela lê.
 */
@Injectable()
export class ZernioSyncRunsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * O run do clique. Se já existe um em curso para o canal, DEVOLVE ESSE.
   *
   * Não é conveniência: dois syncs simultâneos no mesmo canal dobram o consumo
   * do balde de 60 req/min — exatamente o que derrubou a produção. Duplo clique,
   * F5 ou aba repetida não podem virar dois jobs.
   */
  async startOrReuse(
    channelId: string,
  ): Promise<{ run: ZernioSyncRun; created: boolean }> {
    const active = await this.prisma.zernioSyncRun.findFirst({
      where: { channelId, status: { in: [...ACTIVE_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    });
    if (active) return { run: active, created: false };

    const run = await this.prisma.zernioSyncRun.create({
      data: { channelId, status: 'PENDING' },
    });
    return { run, created: true };
  }

  get(runId: string): Promise<ZernioSyncRun | null> {
    return this.prisma.zernioSyncRun.findUnique({ where: { id: runId } });
  }

  /** O run mais recente do canal — o que a tela consulta no polling. */
  latest(channelId: string): Promise<ZernioSyncRun | null> {
    return this.prisma.zernioSyncRun.findFirst({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markRunning(runId: string): Promise<void> {
    await this.prisma.zernioSyncRun.update({
      where: { id: runId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
  }

  /**
   * Progresso parcial, gravado conversa a conversa. É também o ponto de
   * RETOMADA: `cursor` guarda a página onde o run está — se ele morrer aqui, a
   * próxima execução continua daí em vez de refazer tudo.
   */
  async saveProgress(
    runId: string,
    patch: ZernioSyncProgressPatch,
  ): Promise<void> {
    await this.prisma.zernioSyncRun.update({
      where: { id: runId },
      data: {
        totalConversations: patch.totalConversations,
        processedConversations: patch.processedConversations,
        importedMessages: patch.importedMessages,
        failedConversations: patch.failedConversations,
        cursor: patch.cursor ?? null,
      },
    });
  }

  /** Cedeu o balde para uma campanha — ver `ZernioInboxSyncService`. */
  async markPaused(runId: string): Promise<void> {
    await this.prisma.zernioSyncRun.update({
      where: { id: runId },
      data: { status: 'PAUSED' },
    });
  }

  /**
   * Fim de linha feliz — inclusive com falha PARCIAL.
   *
   * Conversas que falharam não fazem o run virar FAILED: elas viram um número
   * (`failedConversations`) que a tela mostra ("98 entraram, 2 falharam"). O
   * operador merece a verdade parcial, não um erro que apaga as 98.
   */
  async finish(runId: string, result: ZernioInboxSyncResult): Promise<void> {
    await this.prisma.zernioSyncRun.update({
      where: { id: runId },
      data: {
        status: 'SUCCEEDED',
        processedConversations: result.conversations,
        importedMessages: result.messages,
        failedConversations: result.failed,
        finishedAt: new Date(),
        cursor: null, // acabou: não há de onde retomar
      },
    });
  }

  /** O run inteiro caiu (401, canal sem conta, Zernio fora). */
  async fail(runId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.prisma.zernioSyncRun.update({
      where: { id: runId },
      data: {
        status: 'FAILED',
        error: message.slice(0, 500),
        finishedAt: new Date(),
      },
    });
  }
}
