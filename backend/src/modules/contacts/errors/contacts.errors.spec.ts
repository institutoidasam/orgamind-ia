import { describe, it, expect } from 'vitest';
import { ChannelOfflineForSyncError } from './contacts.errors';

/**
 * Fix round 2 (revisão pós-commit, minor) — `ChannelOfflineForSyncError`
 * interpolava `channel.name` na mensagem. `name` é um rótulo que o OPERADOR
 * digita ao criar o canal, sem validação — em produção alguns operadores
 * digitam o próprio número de telefone ali (é o jeito mais natural de
 * identificar "qual número é esse"). Essa mensagem volta para a tela e pode
 * acabar em log/Sentry ([[picoa-pii-em-log-e-sentry]]), então PII não pode
 * passar por ela.
 *
 * A classe em si só formata o que recebe — não tem como saber se o
 * chamador passou um id ou um telefone. A garantia real é do CHAMADOR: os
 * três pontos de construção (`contacts.service.ts`, `contact-sync.processor.ts`
 * ×2) agora passam `channel.id` (um cuid, nunca um telefone), não mais
 * `channel.name`. O teste de ponta a ponta — canal com `name` telefônico,
 * offline, e a mensagem do erro sem nenhum dígito ≥ 8 — mora em
 * `contact-sync.processor.spec.ts`, onde o aborto de verdade acontece.
 */
describe('ChannelOfflineForSyncError', () => {
  it('embute o id recebido na mensagem, para o operador (e o log) identificarem qual canal', () => {
    const err = new ChannelOfflineForSyncError('ch-abc123');
    expect(err.message).toContain('ch-abc123');
  });

  it('mantém code e status (409) inalterados', () => {
    const err = new ChannelOfflineForSyncError('ch-abc123');
    expect(err.code).toBe('contact.sync_channel_offline');
    expect(err.status).toBe(409);
  });
});
