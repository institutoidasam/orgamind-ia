import { describe, it, expect } from 'vitest';
import { HISTORY_TRUNCATED_TEXT, historyLine, historyTime } from './history-text';
import type { ConversationHistoryItem } from './schemas';

function item(over: Partial<ConversationHistoryItem>): ConversationHistoryItem {
  return {
    id: 'h1', action: 'ASSUMED', createdAt: '2026-11-21T18:30:00.000Z',
    actorId: 'u1', actorName: 'Ana',
    fromUserId: null, fromUserName: null, toUserId: null, toUserName: null, note: null,
    ...over,
  };
}

describe('historyLine (DK19)', () => {
  it('ASSUMED — "{autor} assumiu a conversa"', () => {
    expect(historyLine(item({ action: 'ASSUMED' }))).toBe('Ana assumiu a conversa');
  });

  it('ASSUMED_ON_REPLY — "{autor} assumiu ao responder"', () => {
    expect(historyLine(item({ action: 'ASSUMED_ON_REPLY' }))).toBe('Ana assumiu ao responder');
  });

  it('TRANSFERRED — "{autor} transferiu para {para}" e, com de, "transferiu de {de} para {para}"', () => {
    const base = { action: 'TRANSFERRED' as const, toUserId: 'u3', toUserName: 'Caio' };
    expect(historyLine(item(base))).toBe('Ana transferiu para Caio');
    expect(historyLine(item({ ...base, fromUserId: 'u2', fromUserName: 'Bia' }))).toBe('Ana transferiu de Bia para Caio');
  });

  it('UNASSIGNED — "{autor} removeu o atendente {de}"', () => {
    expect(historyLine(item({ action: 'UNASSIGNED', fromUserId: 'u2', fromUserName: 'Bia' }))).toBe('Ana removeu o atendente Bia');
  });

  it('RESOLVED — "{autor} resolveu a conversa"', () => {
    expect(historyLine(item({ action: 'RESOLVED' }))).toBe('Ana resolveu a conversa');
  });

  it('REOPENED — com autor, "{autor} reabriu a conversa"', () => {
    expect(historyLine(item({ action: 'REOPENED' }))).toBe('Ana reabriu a conversa');
  });

  it('SHIFT_HANDOVER — "{autor} passou o turno de {de} para {para}"', () => {
    const shift = item({
      action: 'SHIFT_HANDOVER', fromUserId: 'u2', fromUserName: 'Bia', toUserId: 'u3', toUserName: 'Caio',
    });
    expect(historyLine(shift)).toBe('Ana passou o turno de Bia para Caio');
  });
});

describe('historyLine — Sistema e usuário removido', () => {
  it('aceite 4: REOPENED sem autor — Sistema reabriu a conversa (nova mensagem recebida)', () => {
    expect(historyLine(item({ action: 'REOPENED', actorId: null, actorName: null })))
      .toBe('Sistema reabriu a conversa (nova mensagem recebida)');
  });

  it('autor nulo nas demais ações — "Sistema" no lugar do autor', () => {
    expect(historyLine(item({ action: 'RESOLVED', actorId: null, actorName: null }))).toBe('Sistema resolveu a conversa');
  });

  it('nome nulo com id — Usuário removido (autor, de e para)', () => {
    const gone = item({
      action: 'TRANSFERRED', actorId: 'u1', actorName: null,
      fromUserId: 'u2', fromUserName: null, toUserId: 'u3', toUserName: null,
    });
    expect(historyLine(gone)).toBe('Usuário removido transferiu de Usuário removido para Usuário removido');
  });
});

describe('historyTime e rodapé (DK19, M8)', () => {
  it('historyTime em America/Manaus, dd/MM HH:mm', () => {
    expect(historyTime('2026-11-21T18:30:00.000Z')).toBe('21/11 14:30');
    expect(historyTime('2026-11-22T02:05:00.000Z')).toBe('21/11 22:05');
    expect(historyTime('2026-01-01T03:00:00.000Z')).toBe('31/12 23:00');
  });

  it('texto do rodapé quando há mais de 200 mudanças', () => {
    expect(HISTORY_TRUNCATED_TEXT).toBe('Mostrando as 200 mudanças mais recentes.');
  });
});
