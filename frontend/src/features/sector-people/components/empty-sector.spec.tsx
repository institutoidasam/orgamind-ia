import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { EmptySector } from './empty-sector';

it('mostra a tela vazia e "Adicionar pessoas" chama onAddPeople', async () => {
  const onAddPeople = vi.fn();
  render(<EmptySector onAddPeople={onAddPeople} />);
  expect(screen.getByText('Ninguém neste setor ainda.')).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar pessoas' }));
  expect(onAddPeople).toHaveBeenCalledTimes(1);
});
