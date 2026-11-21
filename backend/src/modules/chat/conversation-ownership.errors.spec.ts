import { describe, expect, it } from 'vitest';
import { DomainError } from '../../shared/errors/domain.error';
import {
  assignedToOther,
  assigneeDetail,
  conversationChanged,
  notAssignee,
} from './conversation-ownership.errors';

const ANA = { id: 'u-ana', name: 'Atendente A', active: true };

describe('erros do núcleo de propriedade', () => {
  it('notAssignee — 403 chat.not_assignee', () => {
    const error = notAssignee();
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: 'chat.not_assignee',
      status: 403,
      message: 'Só o atendente ou um administrador pode fazer isso.',
    });
    expect(error.detail).toBeUndefined();
  });

  it('conversationChanged — 409, detail JSON com assignee ou null', () => {
    const withAssignee = conversationChanged(ANA);
    expect(withAssignee).toMatchObject({
      code: 'chat.conversation_changed',
      status: 409,
      message: 'A conversa mudou.',
    });
    expect(JSON.parse(withAssignee.detail as string)).toEqual({
      assignee: ANA,
    });
    const without = conversationChanged(null);
    expect(JSON.parse(without.detail as string)).toEqual({ assignee: null });
  });

  it('assignedToOther — 409 chat.assigned_to_other, detail com id, nome e active', () => {
    const inactive = { ...ANA, active: false };
    const error = assignedToOther(inactive);
    expect(error).toMatchObject({
      code: 'chat.assigned_to_other',
      status: 409,
      message: 'Outra pessoa está atendendo esta conversa.',
    });
    expect(error.detail).toBe(assigneeDetail(inactive));
    expect(JSON.parse(error.detail as string)).toEqual({ assignee: inactive });
  });
});
