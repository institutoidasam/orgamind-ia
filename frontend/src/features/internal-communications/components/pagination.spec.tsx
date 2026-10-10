import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from './pagination';

describe('Pagination', () => {
  it('expõe total, página atual e navegação sem pedir uma página vazia', async () => {
    const onPageChange = vi.fn();
    const user = userEvent.setup();

    render(<Pagination page={2} pageSize={25} total={51} onPageChange={onPageChange} />);

    expect(screen.getByText('Página 2 de 3 · 51 no total')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Anterior' }));
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(onPageChange).toHaveBeenNthCalledWith(1, 1);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 3);
  });

  it('desabilita a próxima ação na última página, inclusive quando ela está cheia', () => {
    render(<Pagination page={2} pageSize={25} total={50} onPageChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled();
  });
});
