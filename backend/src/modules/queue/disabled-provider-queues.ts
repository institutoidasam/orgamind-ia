import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from './queue.constants';

/**
 * Filas exclusivas dos provedores desligados (Meta/Twilio/GoZap/Zernio). O
 * worker deixou de agendar os repetíveis delas, mas um deploy que já rodou com
 * eles tem as chaves gravadas no Redis e cada job processado se RE-ARMA sozinho:
 * parar de chamar `add()` não apaga nada. `purgeDisabledProviderRepeatables`
 * apaga essas chaves no boot.
 */
export const DISABLED_PROVIDER_QUEUES = [
  QUEUE_NAMES.TOKEN_CHECK,
  QUEUE_NAMES.GOZAP_CONNECTION_RECONCILER,
  QUEUE_NAMES.TEMPLATE_APPROVAL_SYNC,
  QUEUE_NAMES.TWILIO_TIER_SYNC,
  QUEUE_NAMES.ZERNIO_TIER_SYNC,
  QUEUE_NAMES.ZERNIO_TEMPLATE_SYNC,
  QUEUE_NAMES.ZERNIO_INBOX_SYNC,
  QUEUE_NAMES.ZERNIO_BROADCAST_SYNC,
] as const;

export type RepeatableQueue = Pick<
  Queue,
  'getRepeatableJobs' | 'removeRepeatableByKey'
>;

/**
 * Remove TODOS os repetíveis de cada fila de `DISABLED_PROVIDER_QUEUES`.
 *
 * `getRepeatableJobs` + `removeRepeatableByKey` (e não `drain`): listar pela
 * chave dispensa copiar a tripla (`name`, `repeat`, `jobId`) de cada `add()` do
 * worker antigo, apaga também chaves de versões mais antigas e não toca em
 * nenhum outro job do Redis de produção. As duas estão depreciadas no BullMQ 5
 * em favor dos job schedulers, mas são as que enxergam repetíveis criados no
 * formato legado `add(name, data, { repeat, jobId })` — `upsertJobScheduler` /
 * `removeJobScheduler` não os veem. Daí a supressão pontual de S1874.
 *
 * Idempotente (segunda execução devolve tudo zerado). Cada fila roda no seu
 * try/catch, com o `getQueue(name)` DENTRO dele: token de fila ausente ou Redis
 * indisponível numa fila vai para `failed` e não derruba as demais.
 */
export async function purgeDisabledProviderRepeatables(
  getQueue: (name: string) => RepeatableQueue,
): Promise<{ removed: Record<string, number>; failed: string[] }> {
  const removed: Record<string, number> = {};
  const failed: string[] = [];
  for (const name of DISABLED_PROVIDER_QUEUES) {
    try {
      const queue = getQueue(name);
      const jobs = await queue.getRepeatableJobs(); // NOSONAR(S1874): formato legado add+repeat+jobId (D7); job schedulers não o enxergam
      for (const job of jobs) {
        await queue.removeRepeatableByKey(job.key); // NOSONAR(S1874): idem, par do getRepeatableJobs (D7)
      }
      removed[name] = jobs.length;
    } catch {
      failed.push(name);
    }
  }
  return { removed, failed };
}
