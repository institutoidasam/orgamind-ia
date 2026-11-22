import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ConversationStatusFilter } from './conversation-status-filter';

describe('ConversationStatusFilter', () => {
  it('Abertas marcada por padrão; clicar Resolvidas chama onChange', () => {
    const onChange = vi.fn();
    render(<ConversationStatusFilter value="open" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Abertas' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Resolvidas' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Resolvidas' }));
    expect(onChange).toHaveBeenCalledWith('resolved');
  });
});

describe('ConversationStatusFilter — acessibilidade (Fix R1)', () => {
  it('os botões ficam num grupo rotulado "Situação"', () => {
    render(<ConversationStatusFilter value="open" onChange={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Situação' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Abertas', 'Resolvidas']);
  });
});
