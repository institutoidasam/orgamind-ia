// twilio-platform T5 — specs do form "Novo template Twilio" (criação de
// rascunho na Content API): payload por tipo, amostras obrigatórias inline,
// contadores/limites de botão e preview estilo WhatsApp.
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
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    info: vi.fn(),
  },
}));

const createTwilioMutateAsync = vi.fn();
const updateDraftMutateAsync = vi.fn();
vi.mock('../api', () => ({
  useCreateTwilioTemplate: () => ({
    isPending: false,
    mutateAsync: createTwilioMutateAsync,
  }),
  useUpdateTwilioDraft: () => ({
    isPending: false,
    mutateAsync: updateDraftMutateAsync,
  }),
}));

import { TwilioTemplateFormDialog } from './twilio-template-form-dialog';
import { cloneTwilioPrefill } from '../twilio-schemas';
import type { Template } from '../schemas';

/** A Radix Select trigger, targeted by id. */
function selectTrigger(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`select trigger #${id} not found`);
  return el;
}

async function pickOption(triggerId: string, label: string | RegExp) {
  fireEvent.click(selectTrigger(triggerId));
  fireEvent.click(await screen.findByRole('option', { name: label }));
}

async function fillCommon(name: string, body: string) {
  await userEvent.type(screen.getByLabelText(/^Nome$/), name);
  // fireEvent.change: userEvent.type trata `{{` como escape e corromperia
  // os tokens de variável ({{1}}).
  fireEvent.change(screen.getByLabelText(/Corpo da mensagem/), {
    target: { value: body },
  });
}

beforeEach(() => {
  createTwilioMutateAsync.mockReset();
  updateDraftMutateAsync.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('TwilioTemplateFormDialog — criação twilio/text', () => {
  it('cria um rascunho de texto com variável e amostra e mostra o toast', async () => {
    createTwilioMutateAsync.mockResolvedValue({});
    const onOpenChange = vi.fn();
    render(
      <TwilioTemplateFormDialog mode="create" open onOpenChange={onOpenChange} />,
    );

    await fillCommon('boas_vindas', 'Olá {{1}}, tudo bem?');
    await userEvent.type(
      await screen.findByLabelText('Amostra {{1}}'),
      'João',
    );

    fireEvent.click(screen.getByRole('button', { name: /Criar rascunho/ }));

    await waitFor(() =>
      expect(createTwilioMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(createTwilioMutateAsync.mock.calls[0][0]).toEqual({
      name: 'boas_vindas',
      language: 'pt_BR',
      category: 'UTILITY',
      contentType: 'twilio/text',
      body: 'Olá {{1}}, tudo bem?',
      variables: { '1': 'João' },
    });
    expect(toastSuccess).toHaveBeenCalledWith('Rascunho criado na Twilio');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('bloqueia o submit com erro inline quando a amostra da variável falta', async () => {
    render(
      <TwilioTemplateFormDialog mode="create" open onOpenChange={vi.fn()} />,
    );

    await fillCommon('boas_vindas', 'Olá {{1}}, tudo bem?');
    // amostra fica vazia de propósito
    fireEvent.click(screen.getByRole('button', { name: /Criar rascunho/ }));

    expect(
      await screen.findByText(
        'Amostra obrigatória para {{1}} — informe um valor de exemplo.',
      ),
    ).toBeInTheDocument();
    expect(createTwilioMutateAsync).not.toHaveBeenCalled();
  });

  it('avisa o custo ao escolher a categoria MARKETING', async () => {
    render(
      <TwilioTemplateFormDialog mode="create" open onOpenChange={vi.fn()} />,
    );
    expect(
      screen.queryByText(/Marketing custa ~8x mais que Utility/),
    ).not.toBeInTheDocument();

    await pickOption('twilio-category', 'MARKETING');

    expect(
      screen.getByText(/Marketing custa ~8x mais que Utility/),
    ).toBeInTheDocument();
  });
});

describe('TwilioTemplateFormDialog — quick-reply', () => {
  it('mostra o contador do título e o erro inline acima do limite de 20', async () => {
    render(
      <TwilioTemplateFormDialog mode="create" open onOpenChange={vi.fn()} />,
    );

    await fillCommon('com_botoes', 'Podemos confirmar sua visita?');
    await pickOption('twilio-content-type', 'Botões de resposta rápida');

    const title = screen.getByLabelText('Título do botão 1');
    await userEvent.type(title, 'x'.repeat(21));

    expect(screen.getByText('21/20')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Criar rascunho/ }));

    expect(
      await screen.findByText('Título excede 20 caracteres (atual: 21).'),
    ).toBeInTheDocument();
    expect(createTwilioMutateAsync).not.toHaveBeenCalled();
  });

  it('deriva o id/payload do título e envia as actions {title, id}', async () => {
    createTwilioMutateAsync.mockResolvedValue({});
    render(
      <TwilioTemplateFormDialog mode="create" open onOpenChange={vi.fn()} />,
    );

    await fillCommon('com_botoes', 'Podemos confirmar sua visita?');
    await pickOption('twilio-content-type', 'Botões de resposta rápida');

    await userEvent.type(screen.getByLabelText('Título do botão 1'), 'Sim, pode');
    expect(screen.getByLabelText('Payload do botão 1')).toHaveValue('sim_pode');

    fireEvent.click(screen.getByRole('button', { name: /Criar rascunho/ }));

    await waitFor(() =>
      expect(createTwilioMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(createTwilioMutateAsync.mock.calls[0][0]).toMatchObject({
      contentType: 'twilio/quick-reply',
      actions: [{ title: 'Sim, pode', id: 'sim_pode' }],
    });
  });
});

describe('TwilioTemplateFormDialog — call-to-action', () => {
  it('envia URL + PHONE_NUMBER no payload de CTA', async () => {
    createTwilioMutateAsync.mockResolvedValue({});
    render(
      <TwilioTemplateFormDialog mode="create" open onOpenChange={vi.fn()} />,
    );

    await fillCommon('cta_contato', 'Fale com a nossa equipe.');
    await pickOption('twilio-content-type', 'Call-to-action');

    await userEvent.type(screen.getByLabelText('Título do link 1'), 'Abrir site');
    await userEvent.type(
      screen.getByLabelText('URL do link 1'),
      'https://exemplo.com',
    );

    fireEvent.click(screen.getByRole('button', { name: /Adicionar telefone/ }));
    await userEvent.type(screen.getByLabelText('Título do telefone'), 'Ligar');
    await userEvent.type(
      screen.getByLabelText('Telefone (E.164)'),
      '+5592995550101',
    );

    fireEvent.click(screen.getByRole('button', { name: /Criar rascunho/ }));

    await waitFor(() =>
      expect(createTwilioMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(createTwilioMutateAsync.mock.calls[0][0]).toMatchObject({
      contentType: 'twilio/call-to-action',
      actions: [
        { type: 'URL', title: 'Abrir site', url: 'https://exemplo.com' },
        { type: 'PHONE_NUMBER', title: 'Ligar', phone: '+5592995550101' },
      ],
    });
  });

  it('valida telefone fora do E.164 com a mensagem do backend', async () => {
    render(
      <TwilioTemplateFormDialog mode="create" open onOpenChange={vi.fn()} />,
    );

    await fillCommon('cta_contato', 'Fale com a nossa equipe.');
    await pickOption('twilio-content-type', 'Call-to-action');
    await userEvent.type(screen.getByLabelText('Título do link 1'), 'Abrir');
    await userEvent.type(
      screen.getByLabelText('URL do link 1'),
      'https://exemplo.com',
    );
    fireEvent.click(screen.getByRole('button', { name: /Adicionar telefone/ }));
    await userEvent.type(screen.getByLabelText('Título do telefone'), 'Ligar');
    await userEvent.type(screen.getByLabelText('Telefone (E.164)'), '92999');

    fireEvent.click(screen.getByRole('button', { name: /Criar rascunho/ }));

    expect(
      await screen.findByText(
        'Telefone deve estar em formato E.164 (ex.: +5592999999999).',
      ),
    ).toBeInTheDocument();
    expect(createTwilioMutateAsync).not.toHaveBeenCalled();
  });
});

describe('TwilioTemplateFormDialog — clonar e corrigir (prefill)', () => {
  it('pré-preenche o form com os valores do rejeitado e nome sufixado _v2', async () => {
    const rejected: Template = {
      id: 't9',
      metaName: 'primeiro_contato',
      language: 'pt_BR',
      body: 'Deseja continuar recebendo avisos?',
      variables: [],
      status: 'REJECTED',
      category: 'MARKETING',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      kind: 'BUTTONS',
      interactiveConfig: {
        'twilio/quick-reply': {
          body: 'Deseja continuar recebendo avisos?',
          actions: [{ title: 'Parar', id: 'optout' }],
        },
      },
      twilioContentSid: 'HX0123456789abcdef0123456789abcdef',
      provider: 'TWILIO',
      twilioApprovalStatus: 'rejected',
      twilioRejectionReason: 'INVALID_FORMAT',
      lastTwilioSyncAt: null,
    };

    render(
      <TwilioTemplateFormDialog
        mode="create"
        initialValues={cloneTwilioPrefill(rejected)}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/^Nome$/)).toHaveValue('primeiro_contato_v2');
    expect(screen.getByLabelText(/Corpo da mensagem/)).toHaveValue(
      'Deseja continuar recebendo avisos?',
    );
    expect(screen.getByLabelText('Título do botão 1')).toHaveValue('Parar');
    expect(screen.getByLabelText('Payload do botão 1')).toHaveValue('optout');
    // é um NOVO draft: o submit vai para POST /templates/twilio
    expect(
      screen.getByRole('button', { name: /Criar rascunho/ }),
    ).toBeInTheDocument();
  });
});

describe('TwilioTemplateFormDialog — preview estilo WhatsApp', () => {
  it('substitui as variáveis pelas amostras no balão do preview', async () => {
    render(
      <TwilioTemplateFormDialog mode="create" open onOpenChange={vi.fn()} />,
    );

    await fillCommon('boas_vindas', 'Olá {{1}}, tudo bem?');
    await userEvent.type(await screen.findByLabelText('Amostra {{1}}'), 'João');

    const preview = screen.getByTestId('twilio-preview');
    expect(preview).toHaveTextContent('Olá João, tudo bem?');
  });

  it('desenha os botões de quick-reply no preview', async () => {
    render(
      <TwilioTemplateFormDialog mode="create" open onOpenChange={vi.fn()} />,
    );

    await fillCommon('com_botoes', 'Podemos confirmar?');
    await pickOption('twilio-content-type', 'Botões de resposta rápida');
    await userEvent.type(screen.getByLabelText('Título do botão 1'), 'Sim');

    const preview = screen.getByTestId('twilio-preview');
    expect(preview).toHaveTextContent('Sim');
  });
});
