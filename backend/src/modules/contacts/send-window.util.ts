import { toZonedTime } from 'date-fns-tz';
import { TIMEZONE_DEFAULT } from '../../schemas/contracts/schedule.schema';

/**
 * A JANELA DE HORÁRIO DO CANAL, para a validação ativa de números (B.5).
 *
 * O aviso que a tela mostra ao operador diz "ritmo lento: ~40/min, só em
 * horário comercial". Ou isso é verdade, ou o aviso é uma mentira que ensina o
 * operador a desconfiar dos outros avisos. Por isso a janela é ENFORÇADA aqui.
 *
 * ⚠️ DUPLICAÇÃO CONSCIENTE de `send-message.processor.ts` (§"Anti-ban: send
 * window", linhas 679-696). Unificar exigiria extrair o helper para o módulo
 * `queue`, que está fora da fronteira desta fase (Fase A e B correm em
 * paralelo em worktrees). A regra é a mesma, inclusive o caso que vira o dia;
 * quem for unificar, unifique os dois de uma vez.
 */
export function isWithinSendWindow(
  now: Date,
  channel: {
    sendWindowEnabled: boolean;
    sendWindowStartHour: number;
    sendWindowEndHour: number;
  },
  timezone: string = TIMEZONE_DEFAULT,
): boolean {
  if (!channel.sendWindowEnabled) return true;
  const start = channel.sendWindowStartHour;
  const end = channel.sendWindowEndHour;
  // Config degenerada (recusada na escrita): tratar como sem restrição é o que
  // impede o laço de adiamento perpétuo.
  if (start === end) return true;
  const hour = toZonedTime(now, timezone).getHours();
  return start < end
    ? hour >= start && hour < end
    : // Janela que vira o dia (22h–06h): "dentro" é depois do início OU antes
      // do fim.
      hour >= start || hour < end;
}
