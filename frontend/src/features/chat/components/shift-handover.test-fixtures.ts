import { HTTPError } from 'ky';
import type { ConversationSummary } from '../schemas';

/** Conversa aberta em atendimento com `u1` (nomes e telefone fictícios). */
export function handoverConv(id: string, displayName: string, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, instanceId: 'i1', instanceName: 'A', remoteJid: `${id}@s.whatsapp.net`, phoneE164: '+5592991110001',
    contactId: null, displayName, waName: null, profilePicUrl: null, lastMessageAt: null,
    lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0,
    assignedUserId: 'u1', assignedUserName: 'Atendente A', assignedUserActive: true,
    status: 'IN_PROGRESS', lastInboundAt: '2026-11-21T14:00:00.000Z',
    ...over,
  };
}

export const HANDOVER_CONVS = [handoverConv('c1', 'Maria'), handoverConv('c2', 'João')];

/** `GET chat/assignees` como o servidor devolve: quem olha também vem, a tela tira quem sai. */
export const HANDOVER_ASSIGNEES = {
  items: [{ id: 'u1', name: 'Atendente A' }, { id: 'u2', name: 'Pessoa B' }, { id: 'u3', name: 'Pessoa C' }],
};

export const json = (value: unknown) => ({ json: () => Promise.resolve(value) });

/** `api.get` por rota: destinos em `chat/assignees`, o resto é a página de conversas. */
export function routeGet(items: ConversationSummary[], total = items.length, assignees: unknown = HANDOVER_ASSIGNEES) {
  return (url: string) => json(url.startsWith('chat/assignees') ? assignees : { items, total, page: 1, pageSize: 100 });
}

/** HTTPError no formato do ky 2: corpo já lido em `data`. */
export function httpError(body: unknown, status: number): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, { name: 'HTTPError', message: `status ${status}`, data: body, response: { status } });
  return err;
}
