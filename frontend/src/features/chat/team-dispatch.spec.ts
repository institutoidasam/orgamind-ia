import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

import { invalidateChat } from './api';
import { chatMessageSchema } from './schemas';
import {
  conversationLastDispatchSchema,
  lastDispatchText,
  teamTagText,
  useConversationLastDispatch,
} from './team-dispatch';

// 02:05 UTC de 22/11 = 22:05 de 21/11 em Manaus (a virada do dia mostra se o fuso foi aplicado).
const LATE_UTC = '2026-11-22T02:05:00.000Z';
const MORNING_UTC = '2026-11-21T12:30:00.000Z';

const oldMessage = {
  id: 'm1', conversationId: 'c1', direction: 'OUTBOUND', kind: 'text', content: 'oi', status: 'SENT',
  providerMessageId: null, quotedWaMessageId: null, quotedPreview: null, createdAt: MORNING_UTC,
  sentAt: null, deliveredAt: null, readAt: null, receivedAt: null, media: null,
};

describe('teamTagText', () => {
  it('teamTagText — dispatch, dispatch sem finalidade, reminder, alert_reply em hora de Manaus', () => {
    expect(teamTagText({ kind: 'dispatch', purpose: 'urgency', sentAt: LATE_UTC })).toBe(
      'Envio à equipe: Urgência · 21/11 22:05',
    );
    expect(teamTagText({ kind: 'dispatch', purpose: null, sentAt: LATE_UTC })).toBe('Envio à equipe · 21/11 22:05');
    expect(teamTagText({ kind: 'reminder' })).toBe('Lembrete do alerta');
    expect(teamTagText({ kind: 'alert_reply', alertSentAt: MORNING_UTC })).toBe('Resposta ao alerta de 08:30');
  });
});

describe('lastDispatchText', () => {
  const base = { purpose: 'meeting', sentAt: LATE_UTC, isReminder: false, dispatchId: null, pendency: null } as const;

  it('lastDispatchText — com e sem pendência; lembrete; nunca contém origem', () => {
    const texts = [
      lastDispatchText(base),
      lastDispatchText({ ...base, purpose: 'urgency', pendency: { situation: 'OVERDUE' } }),
      lastDispatchText({ ...base, purpose: null }),
      lastDispatchText({ ...base, isReminder: true, sentAt: MORNING_UTC, dispatchId: 'd1' }),
    ];
    expect(texts).toEqual([
      'Último envio à equipe nesta conversa: Reunião · 21/11 22:05',
      'Último envio à equipe nesta conversa: Urgência · 21/11 22:05 · Pendência: Em tratativa — atrasada',
      'Último envio à equipe nesta conversa: Envio à equipe · 21/11 22:05',
      'Último envio à equipe nesta conversa: Lembrete do alerta · 21/11 08:30',
    ]);
    for (const text of texts) expect(text).not.toMatch(/origem/i);
  });
});

describe('contrato tolerante', () => {
  it('schema tolera resposta antiga sem teamTag', () => {
    const old = chatMessageSchema.safeParse(oldMessage);
    expect(old.success).toBe(true);
    expect(chatMessageSchema.safeParse({ ...oldMessage, teamTag: null }).success).toBe(true);
    const tagged = chatMessageSchema.parse({ ...oldMessage, teamTag: { kind: 'dispatch', purpose: null, sentAt: LATE_UTC } });
    expect(tagged.teamTag).toEqual({ kind: 'dispatch', purpose: null, sentAt: LATE_UTC });
    const reply = chatMessageSchema.parse({ ...oldMessage, teamTag: { kind: 'alert_reply', alertSentAt: MORNING_UTC } });
    expect(reply.teamTag).toEqual({ kind: 'alert_reply', alertSentAt: MORNING_UTC });
    // Último envio sem os campos opcionais (dispatchId, pendency) e sem envio nenhum.
    expect(conversationLastDispatchSchema.safeParse({ last: { purpose: null, sentAt: LATE_UTC, isReminder: false } }).success).toBe(true);
    expect(conversationLastDispatchSchema.safeParse({ last: null }).success).toBe(true);
  });
});

describe('useConversationLastDispatch', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
    get.mockReset();
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);

  it('lê a rota do último envio da conversa; invalidateChat recarrega; resposta fora do contrato vira sem envio', async () => {
    get.mockReturnValue({ json: () => Promise.resolve({ last: { purpose: 'meeting', sentAt: LATE_UTC, isReminder: false } }) });
    const { result } = renderHook(() => useConversationLastDispatch('c1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('internal/team-whatsapp/conversations/c1/last-dispatch');
    expect(result.current.data?.last?.purpose).toBe('meeting');

    get.mockReturnValue({ json: () => Promise.resolve({ last: 'lixo' }) });
    invalidateChat(qc, 'c1');
    await waitFor(() => expect(result.current.data).toEqual({ last: null }));
  });
});
