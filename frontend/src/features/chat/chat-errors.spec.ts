import { describe, it, expect } from 'vitest';
import { HTTPError } from 'ky';
import { chatActionErrorText, chatActionFailure, parseAssigneeDetail } from './chat-errors';

/** HTTPError no formato do ky 2: corpo já lido em `data`. */
function httpError(body: unknown, status: number): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, { name: 'HTTPError', message: `status ${status}`, data: body, response: { status } });
  return err;
}

describe('chatActionErrorText', () => {
  it('textos de chat.not_assignee, chat.conversation_changed, user.not_found e o genérico', () => {
    expect(chatActionErrorText('chat.not_assignee')).toBe(
      'Só quem está atendendo a conversa ou um administrador pode fazer isso.',
    );
    expect(chatActionErrorText('chat.conversation_changed')).toBe(
      'A conversa mudou enquanto você olhava. Ela foi recarregada; confira e tente de novo.',
    );
    expect(chatActionErrorText('user.not_found')).toBe('Esta pessoa não pode receber a conversa. Escolha outra.');
    const generic = 'Não foi possível concluir a ação. Tente de novo.';
    expect(chatActionErrorText('chat.outro')).toBe(generic);
    expect(chatActionErrorText(undefined)).toBe(generic);
    expect(chatActionErrorText('constructor')).toBe(generic);
  });
});

describe('parseAssigneeDetail', () => {
  it('JSON válido; ausente, inválido ou sem assignee — null', () => {
    const detail = JSON.stringify({ assignee: { id: 'u2', name: 'Bia', active: false } });
    expect(parseAssigneeDetail(detail)).toEqual({ id: 'u2', name: 'Bia', active: false });
    expect(parseAssigneeDetail(undefined)).toBeNull();
    expect(parseAssigneeDetail('não é json')).toBeNull();
    expect(parseAssigneeDetail(JSON.stringify({ assignee: null }))).toBeNull();
    expect(parseAssigneeDetail(JSON.stringify({ assignee: { id: 'u2' } }))).toBeNull();
    expect(parseAssigneeDetail('null')).toBeNull();
  });
});

describe('chatActionFailure', () => {
  it('lê o code do corpo (ky 2) e recarrega só em 403 e 409', async () => {
    const changed = await chatActionFailure(httpError({ code: 'chat.conversation_changed' }, 409));
    expect(changed).toEqual({ text: chatActionErrorText('chat.conversation_changed'), reload: true });
    const denied = await chatActionFailure(httpError({ code: 'chat.not_assignee' }, 403));
    expect(denied.reload).toBe(true);
    const notFound = await chatActionFailure(httpError({ code: 'user.not_found' }, 404));
    expect(notFound).toEqual({ text: chatActionErrorText('user.not_found'), reload: false });
    expect(await chatActionFailure(new Error('rede'))).toEqual({ text: chatActionErrorText(undefined), reload: false });
  });
});
