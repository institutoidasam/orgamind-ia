// twilio-platform T5 — confirmação de "Submeter à aprovação": depois disso o
// template é imutável na Twilio, então o dialog avisa antes; o DomainError
// PT-BR do backend aparece INLINE (o dialog fica aberto para o operador ler).
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPError } from 'ky';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const submitMutateAsync = vi.fn();
vi.mock('../api', () => ({
  useSubmitTwilioTemplate: () => ({
    isPending: false,
    mutateAsync: submitMutateAsync,
  }),
}));

import { SubmitTwilioTemplateDialog } from './submit-twilio-template-dialog';
import type { Template } from '../schemas';

function makeDraft(overrides: Partial<Template> = {}): Template {
  return {
    id: 't1',
    metaName: 'picoa_teste_opt_in',
    language: 'pt_BR',
    body: 'Deseja receber avisos?',
    variables: [],
    status: 'PENDING',
    category: 'UTILITY',
    createdAt: new Date('2026-07-10T00:00:00Z'),
    kind: 'BUTTONS',
    interactiveConfig: null,
    twilioContentSid: 'HX0123456789abcdef0123456789abcdef',
    provider: 'TWILIO',
    twilioApprovalStatus: 'draft',
    twilioRejectionReason: null,
    lastTwilioSyncAt: null,
    ...overrides,
  };
}

function makeKyError(status: number, body: unknown): HTTPError {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  return new HTTPError(
    response as never,
    new Request('http://localhost/templates') as never,
    {} as never,
  );
}

beforeEach(() => {
  submitMutateAsync.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('SubmitTwilioTemplateDialog', () => {
  it('avisa que a submissão é irreversível e pode demorar', () => {
    render(
      <SubmitTwilioTemplateDialog
        open
        onOpenChange={vi.fn()}
        template={makeDraft()}
      />,
    );
    expect(
      screen.getByText(
        /Após submeter, o template não pode mais ser editado — a Meta pode levar horas para aprovar/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/picoa_teste_opt_in/)).toBeInTheDocument();
  });

  it('confirma → chama o twilio-submit com o id e fecha com toast', async () => {
    submitMutateAsync.mockResolvedValue({});
    const onOpenChange = vi.fn();
    render(
      <SubmitTwilioTemplateDialog
        open
        onOpenChange={onOpenChange}
        template={makeDraft()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Submeter$/ }));

    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledWith('t1'));
    expect(toastSuccess).toHaveBeenCalledWith(
      'Template submetido à aprovação da Meta',
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('mostra o DomainError PT-BR do backend inline e mantém o dialog aberto', async () => {
    submitMutateAsync.mockRejectedValue(
      makeKyError(422, {
        code: 'template.twilio_not_draft',
        title: 'Erro de validação',
        detail: 'Apenas rascunhos podem ser submetidos à aprovação.',
      }),
    );
    const onOpenChange = vi.fn();
    render(
      <SubmitTwilioTemplateDialog
        open
        onOpenChange={onOpenChange}
        template={makeDraft()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Submeter$/ }));

    expect(
      await screen.findByText('Apenas rascunhos podem ser submetidos à aprovação.'),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
