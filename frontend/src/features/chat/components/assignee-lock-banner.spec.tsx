import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AssigneeLockBanner } from './assignee-lock-banner';

describe('AssigneeLockBanner', () => {
  it('texto {Nome} está atendendo esta conversa. e botão Assumir conversa', () => {
    const onAssume = vi.fn();
    render(<AssigneeLockBanner name="Ana" onAssume={onAssume} pending={false} />);
    expect(screen.getByText('Ana está atendendo esta conversa.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Assumir conversa' }));
    expect(onAssume).toHaveBeenCalledTimes(1);
  });

  it('nome inativo com (inativo); pendente desliga o botão', () => {
    render(<AssigneeLockBanner name="Bia (inativo)" onAssume={vi.fn()} pending />);
    expect(screen.getByText('Bia (inativo) está atendendo esta conversa.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Assumir conversa' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
