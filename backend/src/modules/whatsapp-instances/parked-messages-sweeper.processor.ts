import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ReconnectReplayService } from './reconnect-replay.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * A varredura das mensagens ESTACIONADAS, pelo lado das MENSAGENS.
 *
 * Existe porque todo replay, até aqui, era disparado pelo lado do CANAL: o
 * laço de cada provedor percorre os canais DELE e pergunta, para cada um
 * aberto, "tem mensagem parada aqui?". Esses laços têm filtros — o do GoZap só
 * visita canal ATIVO e COM token — e uma mensagem parada num canal que o laço
 * pula fica invisível PARA SEMPRE.
 *
 * Foi exatamente isso em 2026-08-14: 488 mensagens passaram dois dias paradas
 * com o número reconectado, porque o canal delas não era visitado por ninguém.
 * Reconectar não resolvia e não tinha como resolver.
 *
 * Este tick fecha o buraco por construção: parte das mensagens paradas, não
 * dos canais, então nenhum filtro de provedor pode escondê-las. Cada volta
 * também LOGA o que encontrou — é a única janela para um estado que, por
 * definição, ninguém está olhando.
 *
 * 5 minutos: a fila só se move quando um canal volta, e a volta já é tratada
 * na hora pelo caminho do provedor. Este aqui é a rede, não o mecanismo
 * principal — não precisa ser agressivo.
 */
@Processor(QUEUE_NAMES.PARKED_MESSAGES_SWEEP, { concurrency: 1 })
export class ParkedMessagesSweeperProcessor extends WorkerHost {
  constructor(private readonly replay: ReconnectReplayService) {
    super();
  }

  async process(): Promise<void> {
    await this.replay.sweepParked();
  }
}
