import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const useUsers = vi.fn();
const mutate = vi.fn();
vi.mock('@/features/users/api', () => ({ useUsers: () => useUsers() }));
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
