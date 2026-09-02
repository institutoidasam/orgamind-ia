import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPError } from 'ky';

// jsdom lacks ResizeObserver, which the Radix Checkbox (opt-out, edit mode) needs.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as never);

// --- Mocks -----------------------------------------------------------------
const createMutateAsync = vi.fn();
const updateMutateAsync = vi.fn();
const createPending = vi.fn();
const updatePending = vi.fn();
vi.mock('../api', () => ({
  useCreateContact: () => ({
    mutateAsync: createMutateAsync,
    isPending: createPending(),
  }),
  useUpdateContact: () => ({
    mutateAsync: updateMutateAsync,
    isPending: updatePending(),
  }),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

// Facetas que alimentam os combobox de cidade/grupo/tags — cada teste ajusta
// o que precisar; por padrão, base vazia (nenhuma sugestão).
type FacetEntry = { value: string; count: number };
let facetsData: { cities: FacetEntry[]; groups: FacetEntry[]; tags: FacetEntry[] } = {
  cities: [],
  groups: [],
  tags: [],
};
vi.mock('../facets-api', () => ({
  useContactFacets: () => ({ data: facetsData }),
}));

import { ContactFormDialog } from './contact-form-dialog';
import type { Contact } from '../schemas';

const baseContact = {
  id: 'c1',
  phoneE164: '+5592987654321',
  name: 'Maria',
  city: 'Manaus',
  group: 'alunos',
  tags: ['vip', 'prio'],
  optedOut: false,
} as unknown as Contact;

/** Build a real ky HTTPError whose response.clone().json() resolves to `body`. */
function httpError(body: unknown): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, {
    name: 'HTTPError',
    response: {
      clone: () => ({ json: () => Promise.resolve(body) }),
    },
  });
  return err;
}

beforeEach(() => {
  createMutateAsync.mockReset();
  updateMutateAsync.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  createPending.mockReset();
  updatePending.mockReset();
  createPending.mockReturnValue(false);
  updatePending.mockReturnValue(false);
  createMutateAsync.mockResolvedValue({ id: 'c1' });
  updateMutateAsync.mockResolvedValue({ id: 'c1' });
  facetsData = { cities: [], groups: [], tags: [] };
});

/** Digita `text` no combobox de tags e confirma com Enter (vira um chip). */
function addTag(input: HTMLElement, text: string) {
  fireEvent.input(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('ContactFormDialog — rendering: create mode', () => {
  it('shows the "Novo contato" title and the "Criar contato" submit', () => {
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    expect(screen.getByText('Novo contato')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Criar contato' }),
    ).toBeInTheDocument();
  });

  it('renders an enabled phone field with the create-mode helper text', () => {
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    expect(screen.getByLabelText('Telefone *')).toBeEnabled();
    expect(
      screen.getByText(/Aceita E\.164 ou DDD brasileiro/i),
    ).toBeInTheDocument();
  });

  it('does NOT render the opt-out checkbox in create mode', () => {
    render(<ContactFormDialog open onOpenChange={() => {}} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('ContactFormDialog — rendering: edit mode', () => {
  it('shows the "Editar contato" title and the "Salvar alterações" submit', () => {
    render(
      <ContactFormDialog open onOpenChange={() => {}} contact={baseContact} />,
    );

    expect(screen.getByText('Editar contato')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Salvar alterações' }),
    ).toBeInTheDocument();
  });

  it('disables the phone field and shows the edit-mode helper text', () => {
    render(
      <ContactFormDialog open onOpenChange={() => {}} contact={baseContact} />,
    );

    expect(screen.getByLabelText('Telefone *')).toBeDisabled();
    expect(
      screen.getByText(/não pode ser alterado/i),
    ).toBeInTheDocument();
  });

  it('pre-fills the fields from the contact (phone, name, city, group, tags)', () => {
    render(
      <ContactFormDialog open onOpenChange={() => {}} contact={baseContact} />,
    );

    expect(screen.getByLabelText('Telefone *')).toHaveValue('+5592987654321');
    expect(screen.getByLabelText('Nome')).toHaveValue('Maria');
    expect(screen.getByLabelText('Cidade')).toHaveValue('Manaus');
    expect(screen.getByLabelText('Grupo')).toHaveValue('alunos');
    // Tags viram chips (a caixa de digitar fica vazia, pronta para a
    // próxima tag) — não mais um texto "vip, prio" num input só.
    expect(screen.getByLabelText('Tags')).toHaveValue('');
    expect(screen.getByText('vip')).toBeInTheDocument();
    expect(screen.getByText('prio')).toBeInTheDocument();
  });

  it('renders the opt-out checkbox reflecting the contact value', () => {
    const optedOut = { ...baseContact, optedOut: true } as unknown as Contact;
    render(<ContactFormDialog open onOpenChange={() => {}} contact={optedOut} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});

describe('ContactFormDialog — submit payload: create', () => {
  it('sends phone + trimmed/split tags and coerces empty strings to undefined', async () => {
    const onOpenChange = vi.fn();
    render(<ContactFormDialog open onOpenChange={onOpenChange} />);

    fireEvent.input(screen.getByLabelText('Telefone *'), {
      target: { value: '+5592987654321' },
    });
    fireEvent.input(screen.getByLabelText('Nome'), {
      target: { value: 'João' },
    });
    const tagsInput = screen.getByLabelText('Tags');
    addTag(tagsInput, ' vip ');
    addTag(tagsInput, ' prio ');
    addTag(tagsInput, ' 2024 ');

    fireEvent.click(screen.getByRole('button', { name: 'Criar contato' }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    expect(createMutateAsync).toHaveBeenCalledWith({
      phone: '+5592987654321',
      name: 'João',
      // empty city/group become undefined
      city: undefined,
      group: undefined,
      tags: ['vip', 'prio', '2024'],
    });
    expect(toastSuccess).toHaveBeenCalledWith('Contato criado');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('omits the tags key entirely when no tags are entered', async () => {
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    fireEvent.input(screen.getByLabelText('Telefone *'), {
      target: { value: '+5592987654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar contato' }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    expect(createMutateAsync).toHaveBeenCalledWith({
      phone: '+5592987654321',
      name: undefined,
      city: undefined,
      group: undefined,
      tags: undefined,
    });
  });
});

describe('ContactFormDialog — submit payload: edit', () => {
  it('sends id + input with the always-present tags array', async () => {
    const onOpenChange = vi.fn();
    render(
      <ContactFormDialog open onOpenChange={onOpenChange} contact={baseContact} />,
    );

    fireEvent.input(screen.getByLabelText('Nome'), {
      target: { value: 'Maria Silva' },
    });
    // Remove os dois chips pré-existentes (vip, prio) e digita a e b no lugar.
    fireEvent.click(screen.getByRole('button', { name: 'Remover tag vip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remover tag prio' }));
    const tagsInput = screen.getByLabelText('Tags');
    addTag(tagsInput, 'a');
    addTag(tagsInput, 'b');

    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith({
      id: 'c1',
      input: {
        name: 'Maria Silva',
        city: 'Manaus',
        group: 'alunos',
        tags: ['a', 'b'],
        // The edit form schema carries `optedOut` through the resolver, so the
        // contact's current value (false) is sent unchanged when untouched.
        optedOut: false,
      },
    });
    expect(toastSuccess).toHaveBeenCalledWith('Contato atualizado');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it('sends optedOut=true after toggling the checkbox on (from false)', async () => {
    // The checkbox drives `form.watch('optedOut')` and the edit form schema
    // keeps `optedOut` in the resolved data, so toggling it actually persists.
    render(
      <ContactFormDialog open onOpenChange={() => {}} contact={baseContact} />,
    );

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());
    expect(updateMutateAsync.mock.calls[0][0].input.optedOut).toBe(true);
  });

  it('sends optedOut=false after toggling the checkbox off (from true)', async () => {
    const optedOut = { ...baseContact, optedOut: true } as unknown as Contact;
    render(
      <ContactFormDialog open onOpenChange={() => {}} contact={optedOut} />,
    );

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());
    expect(updateMutateAsync.mock.calls[0][0].input.optedOut).toBe(false);
  });

  it('clears emptied name/city/group to undefined in the edit payload', async () => {
    render(
      <ContactFormDialog open onOpenChange={() => {}} contact={baseContact} />,
    );

    fireEvent.input(screen.getByLabelText('Cidade'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());
    expect(updateMutateAsync.mock.calls[0][0].input.city).toBeUndefined();
  });
});

describe('ContactFormDialog — validation', () => {
  it('blocks submit and shows the min-length error for a short phone', async () => {
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    fireEvent.input(screen.getByLabelText('Telefone *'), {
      target: { value: '123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar contato' }));

    await waitFor(() =>
      expect(screen.getByText(/mínimo 8 dígitos/i)).toBeInTheDocument(),
    );
    expect(createMutateAsync).not.toHaveBeenCalled();
  });
});

describe('ContactFormDialog — error ladder', () => {
  it('maps contact.phone_conflict to a phone field error (no toast)', async () => {
    createMutateAsync.mockRejectedValue(
      httpError({ code: 'contact.phone_conflict' }),
    );
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    fireEvent.input(screen.getByLabelText('Telefone *'), {
      target: { value: '+5592987654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar contato' }));

    await waitFor(() =>
      expect(
        screen.getByText('Já existe um contato com esse telefone'),
      ).toBeInTheDocument(),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it('maps contact.invalid_phone using the server detail (no toast)', async () => {
    createMutateAsync.mockRejectedValue(
      httpError({ code: 'contact.invalid_phone', detail: 'DDD inexistente' }),
    );
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    fireEvent.input(screen.getByLabelText('Telefone *'), {
      target: { value: '+5592987654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar contato' }));

    await waitFor(() =>
      expect(screen.getByText('DDD inexistente')).toBeInTheDocument(),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it('falls back to the default invalid_phone message when detail is missing', async () => {
    createMutateAsync.mockRejectedValue(
      httpError({ code: 'contact.invalid_phone' }),
    );
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    fireEvent.input(screen.getByLabelText('Telefone *'), {
      target: { value: '+5592987654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar contato' }));

    await waitFor(() =>
      expect(screen.getByText('Telefone inválido')).toBeInTheDocument(),
    );
  });

  it('shows the generic create error toast for an unmapped HTTPError code', async () => {
    createMutateAsync.mockRejectedValue(httpError({ code: 'other' }));
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    fireEvent.input(screen.getByLabelText('Telefone *'), {
      target: { value: '+5592987654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar contato' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Erro ao criar contato'),
    );
  });

  it('shows the generic update error toast for a non-HTTP error in edit mode', async () => {
    updateMutateAsync.mockRejectedValue(new Error('network'));
    render(
      <ContactFormDialog open onOpenChange={() => {}} contact={baseContact} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Erro ao atualizar contato'),
    );
  });
});

describe('ContactFormDialog — pending state', () => {
  it('disables both buttons and shows "Criando…" while a create is pending', () => {
    createPending.mockReturnValue(true);
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    expect(screen.getByRole('button', { name: 'Criando…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
  });

  it('shows "Salvando…" while an update is pending', () => {
    updatePending.mockReturnValue(true);
    render(
      <ContactFormDialog open onOpenChange={() => {}} contact={baseContact} />,
    );
    expect(screen.getByRole('button', { name: 'Salvando…' })).toBeDisabled();
  });
});

describe('ContactFormDialog — cancel', () => {
  it('calls onOpenChange(false) when Cancelar is clicked', () => {
    const onOpenChange = vi.fn();
    render(<ContactFormDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

/**
 * Pedido do cliente (2026-08-25): cidade/grupo/tags viram combobox
 * alimentado pelo que já existe em outros contatos, e "Manaus"/"manaus" não
 * podem virar dois registros — a comparação ignora caixa/acento/espaço, mas
 * o valor GRAVADO reaproveita o rótulo já cadastrado.
 */
describe('ContactFormDialog — combobox de cidade/grupo/tags (facetas)', () => {
  it('lista sugestões de cidade já cadastradas e permite escolher uma', () => {
    facetsData.cities = [{ value: 'Manaus', count: 12 }];
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    fireEvent.focus(screen.getByLabelText('Cidade'));
    fireEvent.click(screen.getByRole('option', { name: /Manaus/ }));

    expect(screen.getByLabelText('Cidade')).toHaveValue('Manaus');
  });

  it('reaproveita o rótulo existente ao sair do campo com caixa/acento diferentes (Manaus vs manaus)', async () => {
    facetsData.cities = [{ value: 'Manaus', count: 12 }];
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    const city = screen.getByLabelText('Cidade');
    fireEvent.input(city, { target: { value: '  manaus  ' } });
    fireEvent.blur(city);

    expect(city).toHaveValue('Manaus');

    fireEvent.input(screen.getByLabelText('Telefone *'), {
      target: { value: '+5592987654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar contato' }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    expect(createMutateAsync.mock.calls[0][0].city).toBe('Manaus');
  });

  it('mantém o texto digitado quando não bate com nenhuma cidade já cadastrada', () => {
    facetsData.cities = [{ value: 'Manaus', count: 12 }];
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    const city = screen.getByLabelText('Cidade');
    fireEvent.input(city, { target: { value: 'Parintins' } });
    fireEvent.blur(city);

    expect(city).toHaveValue('Parintins');
  });

  it('reaproveita uma tag já cadastrada em vez de criar quase-duplicata (vip vs VIP)', async () => {
    facetsData.tags = [{ value: 'vip', count: 3 }];
    render(<ContactFormDialog open onOpenChange={() => {}} />);

    const tagsInput = screen.getByLabelText('Tags');
    addTag(tagsInput, '  VIP  ');

    // Um chip só (não "vip" e "VIP" como duas tags separadas).
    expect(screen.getAllByText('vip')).toHaveLength(1);
    expect(screen.queryByText('VIP')).not.toBeInTheDocument();

    fireEvent.input(screen.getByLabelText('Telefone *'), {
      target: { value: '+5592987654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar contato' }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    expect(createMutateAsync.mock.calls[0][0].tags).toEqual(['vip']);
  });
});
