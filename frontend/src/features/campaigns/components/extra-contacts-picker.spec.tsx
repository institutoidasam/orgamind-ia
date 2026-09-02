import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const useContactsMock = vi.fn();
vi.mock('@/features/contacts/api', () => ({
  useContacts: (...args: unknown[]) => useContactsMock(...args),
}));

import { ExtraContactsPicker, type ExtraContact } from './extra-contacts-picker';

const CONTACT_A = { id: 'c1', name: 'Ana Souza', phoneE164: '+5592999990001' };
const CONTACT_B = { id: 'c2', name: 'Bruno Lima', phoneE164: '+5592999990002' };

beforeEach(() => {
  useContactsMock.mockReset();
  useContactsMock.mockReturnValue({
    data: { items: [CONTACT_A, CONTACT_B], total: 2, page: 1, pageSize: 8 },
    isFetching: false,
  });
});

describe('ExtraContactsPicker', () => {
  it('não mostra resultados antes de 2 caracteres digitados', async () => {
    const user = userEvent.setup();
    render(<ExtraContactsPicker selected={[]} onChange={vi.fn()} />);

    await user.type(screen.getByLabelText('Buscar contato para adicionar'), 'a');

    // Dá tempo ao debounce (250ms) rodar — mesmo assim não deve aparecer nada.
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.queryByText('Ana Souza')).not.toBeInTheDocument();
  });

  it('busca e lista os contatos encontrados a partir de 2 caracteres', async () => {
    const user = userEvent.setup();
    render(<ExtraContactsPicker selected={[]} onChange={vi.fn()} />);

    await user.type(screen.getByLabelText('Buscar contato para adicionar'), 'an');

    await waitFor(() => expect(screen.getByText('Ana Souza')).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(screen.getByText('Bruno Lima')).toBeInTheDocument();
  });

  it('clicar num resultado adiciona o contato à seleção', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ExtraContactsPicker selected={[]} onChange={onChange} />);

    await user.type(screen.getByLabelText('Buscar contato para adicionar'), 'an');
    await waitFor(() => screen.getByText('Ana Souza'));
    await user.click(screen.getByText('Ana Souza'));

    expect(onChange).toHaveBeenCalledWith([CONTACT_A]);
  });

  it('contatos já selecionados não aparecem de novo nos resultados', async () => {
    const user = userEvent.setup();
    render(<ExtraContactsPicker selected={[CONTACT_A]} onChange={vi.fn()} />);

    await user.type(screen.getByLabelText('Buscar contato para adicionar'), 'an');
    await waitFor(() => expect(screen.getByText('Bruno Lima')).toBeInTheDocument());
    // Ana já está na lista de selecionados (abaixo) — mas não deve reaparecer
    // como resultado de busca.
    expect(screen.queryAllByText('Ana Souza')).toHaveLength(1);
  });

  it('mostra a seleção como uma lista removível', async () => {
    const onChange = vi.fn();
    const selected: ExtraContact[] = [CONTACT_A];
    render(<ExtraContactsPicker selected={selected} onChange={onChange} />);

    const list = screen.getByTestId('extra-contacts-selected');
    expect(list).toHaveTextContent('Ana Souza');

    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Remover Ana Souza'));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
