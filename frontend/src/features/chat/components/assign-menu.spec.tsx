import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const useUsers = vi.fn();
const mutate = vi.fn();
vi.mock('@/features/users/api', () => ({ useUsers: (...args: unknown[]) => useUsers(...args) }));
vi.mock('../api', () => ({ useAssignConversation: () => ({ mutate, isPending: false }) }));

import { AssignMenu } from './assign-menu';

describe('AssignMenu trigger label', () => {
  it('shows "Atribuir" when unassigned', () => {
    useUsers.mockReturnValue({ data: { data: [] } });
    render(<AssignMenu conversationId="c1" assignedUserId={null} assignedUserName={null} />);
    expect(screen.getByText('Atribuir')).toBeInTheDocument();
  });

  it('shows the assignee name when assigned', () => {
    useUsers.mockReturnValue({ data: { data: [] } });
    render(<AssignMenu conversationId="c1" assignedUserId="u9" assignedUserName="Ana Lima" />);
    expect(screen.getByText('Ana Lima')).toBeInTheDocument();
  });
});

describe('AssignMenu lista de pessoas', () => {
  it('pede ao servidor só quem tem acesso (hasAccess=true), sem filtrar no cliente', () => {
    useUsers.mockReturnValue({ data: { data: [{ id: 'u1', name: 'Ana', email: 'ana@x.com' }] } });
    render(<AssignMenu conversationId="c1" assignedUserId={null} assignedUserName={null} />);
    expect(useUsers).toHaveBeenLastCalledWith(1, 100, { hasAccess: true });
  });
});
