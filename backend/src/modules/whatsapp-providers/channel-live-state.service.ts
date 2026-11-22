import { Injectable, Logger } from '@nestjs/common';
import type { ChannelProvider } from '@prisma/client';
import { GozapInstancesService } from './gozap-instances.service';
import { EvolutionApiAdapter } from './adapters/evolution-api.adapter';
import type { ConnectionState } from './ports/message-provider.port';

/**
 * Estado ao vivo de um número, observado no provedor. `unknown` = não deu para
 * observar (provedor sem consulta, sem instância, erro ou resposta vazia):
 * NUNCA equivale a `open` — só `open` libera o envio.
 */
export type LiveState = ConnectionState | 'unknown';

export type LiveCheck = {
  channelId: string;
  state: LiveState;
  /** Hora da consulta ao provedor (em cache, a da consulta original). */
  checkedAt: Date;
};

export type LiveCheckChannel = {
  id: string;
  provider: ChannelProvider;
  evolutionInstanceName: string | null;
};

/** Validade do estado observado, por canal (cache por processo). */
export const LIVE_STATE_TTL_MS = 15_000;

/**
 * Porta do estado ao vivo do número: pergunta ao provedor, em vez de confiar no
 * último evento gravado. Usada pela prévia, pelo POST de envio e pelo processor.
 *
 * - GOZAP: `reconcileConnection` (só `GET /instance/status`). NUNCA
 *   `getConnectionInfo`, que pode abrir sessão no GoZap.
 * - EVOLUTION: `getLiveConnectionState(instância do canal)`. Sem nome, não
 *   chama: sem argumento o adaptador cairia na instância padrão (outro número).
 * - Demais provedores: sem consulta ao vivo, logo `unknown`.
 *
 * O cache guarda só estados OBSERVADOS (`open`/`connecting`/`close`); `unknown`
 * nunca entra, para que a próxima chamada tente de novo.
 */
@Injectable()
export class ChannelLiveStateService {
  private readonly logger = new Logger(ChannelLiveStateService.name);
  private readonly cache = new Map<string, LiveCheck>();

  constructor(
    private readonly gozap: GozapInstancesService,
    private readonly evolution: EvolutionApiAdapter,
  ) {}

  async check(channel: LiveCheckChannel): Promise<LiveCheck> {
    const cached = this.cache.get(channel.id);
    if (cached && Date.now() - cached.checkedAt.getTime() < LIVE_STATE_TTL_MS) {
      return cached;
    }
    const state = await this.observe(channel);
    const result: LiveCheck = {
      channelId: channel.id,
      state,
      checkedAt: new Date(),
    };
    if (state === 'unknown') {
      this.cache.delete(channel.id);
    } else {
      this.cache.set(channel.id, result);
    }
    return result;
  }

  /** Um canal por id (o primeiro da lista), consultados em paralelo. */
  async checkMany(
    channels: readonly LiveCheckChannel[],
  ): Promise<Map<string, LiveCheck>> {
    const unique = new Map<string, LiveCheckChannel>();
    for (const channel of channels) {
      if (!unique.has(channel.id)) unique.set(channel.id, channel);
    }
    const checks = await Promise.all(
      [...unique.values()].map((channel) => this.check(channel)),
    );
    return new Map(checks.map((check) => [check.channelId, check]));
  }

  private async observe(channel: LiveCheckChannel): Promise<LiveState> {
    try {
      return (await this.query(channel)) ?? 'unknown';
    } catch (err) {
      this.logger.warn(
        {
          channelId: channel.id,
          provider: channel.provider,
          err: err instanceof Error ? err.message : String(err),
        },
        'channel-live-state: falha ao consultar o estado ao vivo do número',
      );
      return 'unknown';
    }
  }

  private async query(
    channel: LiveCheckChannel,
  ): Promise<ConnectionState | null> {
    if (channel.provider === 'GOZAP') {
      return this.gozap.reconcileConnection(channel.id);
    }
    if (channel.provider === 'EVOLUTION' && channel.evolutionInstanceName) {
      return this.evolution.getLiveConnectionState(
        channel.evolutionInstanceName,
      );
    }
    return null;
  }
}
