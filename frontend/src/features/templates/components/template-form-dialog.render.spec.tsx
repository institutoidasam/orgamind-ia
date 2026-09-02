import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// jsdom lacks the APIs the Radix Select primitive relies on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    info: (...a: unknown[]) => toastInfo(...a),
  },
}));

const createMutateAsync = vi.fn();
const updateMutateAsync = vi.fn();
vi.mock('../api', () => ({
  useCreateTemplate: () => ({ isPending: false, mutateAsync: createMutateAsync }),
  useUpdateTemplate: () => ({ isPending: false, mutateAsync: updateMutateAsync }),
}));

// Multi-provider channels — TemplateFormDialog reads the current global scope
// to seed the provider select for a new template. Keep the real
// PROVIDER_LABEL export (plain, hook-free) and only mock the hook itself,
// which requires the context provider mounted at the authenticated root.
const useProviderScopeMock = vi.fn();
vi.mock('@/features/whatsapp/provider-scope', async () => {
  const actual = await vi.importActual<
    typeof import('@/features/whatsapp/provider-scope')
  >('@/features/whatsapp/provider-scope');
  return {
    ...actual,
    useProviderScope: () => useProviderScopeMock(),
  };
});

import { TemplateFormDialog } from './template-form-dialog';
import type { Template } from '../schemas';

const HX = 'HX0123456789abcdef0123456789abcdef';

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: 't1',
    metaName: 'welcome_message',
    language: 'pt_BR',
    body: 'Olá',
    variables: [],
    status: 'APPROVED',
    category: 'UTILITY',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    kind: 'TEXT',
    interactiveConfig: null,
    twilioContentSid: null,
    provider: 'EVOLUTION',
    ...overrides,
  };
}

/** The provider `<Select>` trigger — targeted by id to disambiguate it from
 * the category/kind selects also rendered in the form. */
function providerTrigger(): HTMLElement {
  const el = document.getElementById('provider');
  if (!el) throw new Error('provider select trigger not found');
  return el;
}

beforeEach(() => {
  createMutateAsync.mockReset();
  updateMutateAsync.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  toastInfo.mockReset();
  useProviderScopeMock.mockReset();
  useProviderScopeMock.mockReturnValue({ scope: 'all', setScope: vi.fn() });
});

// Pedido do cliente (2026-08-25): Twilio saiu das opções do form genérico —
// GOZAP é o provedor ativo e passa a ser o default de criação.
describe('TemplateFormDialog — provider field (create mode)', () => {
  it('defaults the provider to GOZAP when the global scope has no single provider', () => {
    render(<TemplateFormDialog open mode="create" onOpenChange={vi.fn()} />);
    expect(
      screen.queryByLabelText(/Twilio Content SID/i),
    ).not.toBeInTheDocument();
    expect(providerTrigger()).toHaveTextContent('GoZap');
  });

  it('defaults the provider to the current global scope when it is a single offered provider', () => {
    useProviderScopeMock.mockReturnValue({ scope: 'EVOLUTION', setScope: vi.fn() });
    render(<TemplateFormDialog open mode="create" onOpenChange={vi.fn()} />);

    expect(providerTrigger()).toHaveTextContent('Evolution');
  });

  it('falls back to GOZAP when the global scope is TWILIO (no longer offered here)', () => {
    useProviderScopeMock.mockReturnValue({ scope: 'TWILIO', setScope: vi.fn() });
    render(<TemplateFormDialog open mode="create" onOpenChange={vi.fn()} />);

    expect(providerTrigger()).toHaveTextContent('GoZap');
    expect(
      screen.queryByLabelText(/Twilio Content SID/i),
    ).not.toBeInTheDocument();
  });

  it('does not offer Twilio as a provider option when creating a template', async () => {
    render(<TemplateFormDialog open mode="create" onOpenChange={vi.fn()} />);
    fireEvent.click(providerTrigger());

    expect(
      await screen.findByRole('option', { name: 'Evolution' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'Twilio' }),
    ).not.toBeInTheDocument();
  });
});

describe('TemplateFormDialog — provider field (edit mode)', () => {
  it('preselects the provider and shows the filled SID field for a TWILIO template', () => {
    const tpl = makeTemplate({ provider: 'TWILIO', twilioContentSid: HX });
    render(
      <TemplateFormDialog open mode="edit" initialData={tpl} onOpenChange={vi.fn()} />,
    );

    expect(providerTrigger()).toHaveTextContent('Twilio');
    expect(screen.getByLabelText(/Twilio Content SID/i)).toHaveValue(HX);
  });

  it('does not show the SID field for a non-TWILIO template', () => {
    const tpl = makeTemplate({ provider: 'EVOLUTION' });
    render(
      <TemplateFormDialog open mode="edit" initialData={tpl} onOpenChange={vi.fn()} />,
    );

    expect(
      screen.queryByLabelText(/Twilio Content SID/i),
    ).not.toBeInTheDocument();
  });

  // Twilio saiu do select (ver acima) — uma row TWILIO legada continua
  // editável, só travada: sem opção de "voltar" pra Twilio nem de trocar
  // para outro provedor por aqui (mesmo tratamento já dado ao ZERNIO).
  it('locks the provider select for a legacy TWILIO template', () => {
    const tpl = makeTemplate({ provider: 'TWILIO', twilioContentSid: HX });
    render(
      <TemplateFormDialog open mode="edit" initialData={tpl} onOpenChange={vi.fn()} />,
    );

    expect(providerTrigger()).toHaveTextContent('Twilio');
    expect(providerTrigger()).toBeDisabled();
  });
});

describe('TemplateFormDialog — TWILIO requires Content SID (blocked before hitting the backend)', () => {
  // Twilio não é mais selecionável na criação (ver acima); a validação segue
  // valendo para quem edita uma row TWILIO legada.
  it('blocks submit with a PT field error when editing a TWILIO template with an empty Content SID', async () => {
    const tpl = makeTemplate({ provider: 'TWILIO', twilioContentSid: HX });
    render(
      <TemplateFormDialog open mode="edit" initialData={tpl} onOpenChange={vi.fn()} />,
    );

    await userEvent.clear(screen.getByLabelText(/Twilio Content SID/i));
    fireEvent.click(screen.getByRole('button', { name: /Salvar alterações/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/Templates do provedor Twilio exigem o campo Content SID/i),
      ).toBeInTheDocument(),
    );
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it('allows submit when editing a TWILIO template with a valid Content SID', async () => {
    updateMutateAsync.mockResolvedValue({});
    const tpl = makeTemplate({ provider: 'TWILIO', twilioContentSid: HX });
    render(
      <TemplateFormDialog open mode="edit" initialData={tpl} onOpenChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Salvar alterações/i }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    expect(updateMutateAsync.mock.calls[0][0]).toMatchObject({
      input: expect.objectContaining({
        provider: 'TWILIO',
        twilioContentSid: HX,
      }),
    });
  });
});

// Pedido do cliente (2026-08-25): idioma virou um SELECT — antes era texto
// livre e não ficava claro o que era aceito.
describe('TemplateFormDialog — language field', () => {
  function languageTrigger(): HTMLElement {
    const el = document.getElementById('language');
    if (!el) throw new Error('language select trigger not found');
    return el;
  }

  it('defaults to pt_BR on a new template', () => {
    render(<TemplateFormDialog open mode="create" onOpenChange={vi.fn()} />);
    expect(languageTrigger()).toHaveTextContent('pt_BR');
  });

  it('offers pt_BR, en_US and es_ES as options', async () => {
    render(<TemplateFormDialog open mode="create" onOpenChange={vi.fn()} />);
    fireEvent.click(languageTrigger());

    expect(await screen.findByRole('option', { name: /pt_BR/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /en_US/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /es_ES/i })).toBeInTheDocument();
  });

  it('selecting a different language updates the trigger', async () => {
    render(<TemplateFormDialog open mode="create" onOpenChange={vi.fn()} />);
    fireEvent.click(languageTrigger());
    fireEvent.click(await screen.findByRole('option', { name: /en_US/i }));

    expect(languageTrigger()).toHaveTextContent('en_US');
  });

  // Um template legado (sync do Meta) pode carregar um idioma fora da
  // lista curta — o select não pode simplesmente perder o valor.
  it('keeps a legacy language outside the short list as an extra option', () => {
    const tpl = makeTemplate({ language: 'fr_FR' });
    render(
      <TemplateFormDialog open mode="edit" initialData={tpl} onOpenChange={vi.fn()} />,
    );

    expect(languageTrigger()).toHaveTextContent('fr_FR');
  });
});

// Pedido do cliente (2026-08-25): informativo em PT-BR sobre {{1}}, {{2}},
// visível na tela (nunca tooltip/popover).
describe('TemplateFormDialog — variables info block', () => {
  it('shows the PT-BR explainer about {{1}}, {{2}} on the create form', () => {
    render(<TemplateFormDialog open mode="create" onOpenChange={vi.fn()} />);

    expect(
      screen.getByText(/Como funcionam as variáveis/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/é a primeira variável/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/mensagem sai com esse trecho em branco/i),
    ).toBeInTheDocument();
  });
});
