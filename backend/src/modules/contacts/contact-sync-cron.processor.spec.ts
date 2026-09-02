import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { ContactSyncCronProcessor } from './contact-sync-cron.processor';
import { ContactsRepository } from './contacts.repository';
import { AuditService } from '../../shared/audit/audit.service';
import type { Env } from '../../shared/config/env.schema';
import type { Queue } from 'bullmq';

// Mesmo padrão de `check-token-expiry.processor.spec.ts`: um fake mínimo em
// vez de mockar o ConfigService inteiro — só a chave que o processor lê.
function makeConfig(cronEnabled: boolean): ConfigService<Env> {
  return {
    get: (key: string) =>
      key === 'CONTACT_SYNC_CRON_ENABLED' ? cronEnabled : undefined,
  } as unknown as ConfigService<Env>;
}

describe('ContactSyncCronProcessor', () => {
  let repo: MockProxy<ContactsRepository>;
  let audit: MockProxy<AuditService>;
  let queue: { add: ReturnType<typeof vi.fn> };
  let proc: ContactSyncCronProcessor;

  beforeEach(() => {
    repo = mockDeep<ContactsRepository>();
    audit = mockDeep<AuditService>();
    queue = { add: vi.fn().mockResolvedValue({ id: 'j1' }) };
    // Ligado por padrão nos testes de comportamento existente — o teste do
    // kill switch (abaixo) constrói o próprio processor com `makeConfig(false)`.
    proc = new ContactSyncCronProcessor(
      repo,
      audit,
      queue as unknown as Queue,
      makeConfig(true),
    );
  });

  it('chunks selected ids into 50-sized sync jobs', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `c${i}`);
    repo.findIdsForSync.mockResolvedValue(ids);

    await proc.process();

    expect(repo.findIdsForSync).toHaveBeenCalledWith('stale', 5000);
    expect(queue.add).toHaveBeenCalledTimes(3); // 50 + 50 + 20
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'sync',
      expect.objectContaining({
        contactIds: ids.slice(0, 50),
        triggeredBy: 'periodic',
      }),
    );
    expect(queue.add).toHaveBeenNthCalledWith(
      3,
      'sync',
      expect.objectContaining({
        contactIds: ids.slice(100, 120),
        triggeredBy: 'periodic',
      }),
    );
  });

  it('emits contact.sync_periodic_kickoff audit event', async () => {
    repo.findIdsForSync.mockResolvedValue(['c1', 'c2']);
    await proc.process();
    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_periodic_kickoff',
      'Contact',
      undefined,
      expect.objectContaining({ selectedCount: 2 }),
    );
  });

  it('no-ops cleanly when nothing is stale', async () => {
    repo.findIdsForSync.mockResolvedValue([]);
    await proc.process();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('continues the loop and audit-logs partial success when one enqueue fails', async () => {
    // Regression: previously a Redis blip on the 2nd add() aborted the loop
    // and skipped the audit event entirely.
    const ids = Array.from({ length: 150 }, (_, i) => `c${i}`); // 3 chunks
    repo.findIdsForSync.mockResolvedValue(ids);
    queue.add = vi
      .fn()
      .mockResolvedValueOnce({ id: 'j1' })
      .mockRejectedValueOnce(new Error('Redis blip'))
      .mockResolvedValueOnce({ id: 'j3' });
    proc = new ContactSyncCronProcessor(
      repo,
      audit,
      queue as never,
      makeConfig(true),
    );

    await proc.process();

    expect(queue.add).toHaveBeenCalledTimes(3);
    expect(audit.log).toHaveBeenCalledWith(
      'contact.sync_periodic_kickoff',
      'Contact',
      undefined,
      { selectedCount: 150, enqueuedBatches: 2 },
    );
  });

  // Hardening (defesa em profundidade) — o boot (`worker.ts:scheduleContactSyncCron`)
  // já tenta desarmar o repetível quando `CONTACT_SYNC_CRON_ENABLED` é falso,
  // mas aquele `removeRepeatable` roda dentro de um try/catch que ENGOLE erro
  // (`worker.ts:~233`): se falhar, o repetível `0 6 * * *` já armado em
  // produção sobrevive e o BullMQ dispara este `process()` mesmo assim. A
  // flag precisa ser checada de novo AQUI, na entrada do job, não só no boot.
  it('cron desligado (CONTACT_SYNC_CRON_ENABLED=false) — job ignorado mesmo que o repetível já esteja armado', async () => {
    proc = new ContactSyncCronProcessor(
      repo,
      audit,
      queue as unknown as Queue,
      makeConfig(false),
    );

    await proc.process();

    expect(repo.findIdsForSync).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
