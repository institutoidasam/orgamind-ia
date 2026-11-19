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

beforeEach(() => {
  createMutateAsync.mockReset();
  updateMutateAsync.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  toastInfo.mockReset();
});

// R15 — nenhuma escolha de provedor na UI: o template é sempre EVOLUTION.
describe('TemplateFormDialog — sem escolha de provedor', () => {
  it('não mostra seletor de provedor nem Content SID na criação', () => {
    render(<TemplateFormDialog open mode="create" onOpenChange={vi.fn()} />);

    expect(document.getElementById('provider')).toBeNull();
    expect(screen.queryByText('Provedor')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Twilio Content SID/i)).not.toBeInTheDocument();
  });

  it('cria o template como EVOLUTION', async () => {
    createMutateAsync.mockResolvedValue({});
    render(<TemplateFormDialog open mode="create" onOpenChange={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('metaName'), 'boas_vindas');
    await userEvent.type(screen.getByLabelText(/^Corpo/i), 'Olá {{1}}');
    fireEvent.click(screen.getByRole('button', { name: /Criar template/i }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(createMutateAsync.mock.calls[0][0]).toMatchObject({
      metaName: 'boas_vindas',
      provider: 'EVOLUTION',
    });
  });

  it('um template legado com Content SID abre sem seletor/SID e a edição não envia provider', async () => {
    updateMutateAsync.mockResolvedValue({});
    const tpl = makeTemplate({ provider: 'TWILIO', twilioContentSid: HX });
    render(
      <TemplateFormDialog open mode="edit" initialData={tpl} onOpenChange={vi.fn()} />,
    );

    expect(document.getElementById('provider')).toBeNull();
    expect(screen.queryByLabelText(/Twilio Content SID/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Salvar alterações/i }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const { input } = updateMutateAsync.mock.calls[0][0];
    expect('provider' in input).toBe(false);
    expect('twilioContentSid' in input).toBe(false);
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
