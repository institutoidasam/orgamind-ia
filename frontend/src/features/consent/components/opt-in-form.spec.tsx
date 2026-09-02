import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { OptInForm } from './opt-in-form';
import type { PublicConsentText } from '../public-optin';

const TEXT: PublicConsentText = {
  purposeKey: 'convite_atividades',
  purposeLabel: 'Convites para cursos, oficinas e eventos',
  version: 'optin-v1',
  body:
    'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp com convites para cursos, oficinas e eventos.\n' +
    'São no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.\n' +
    'Minha resposta não afeta em nada meu acesso aos projetos e serviços do IDASAM.\n' +
    'Política de privacidade: https://picoa.exemplo.org/privacidade',
};

describe('OptInForm — a landing pública (spec §3.2)', () => {
  it('exibe o texto canônico VERSIONADO: nomeia o IDASAM, a finalidade e como sair', () => {
    render(<OptInForm text={TEXT} onSubmit={vi.fn()} isPending={false} />);

    // O corpo vem do backend (ConsentText), não da copy do React — a página só
    // o renderiza. Estes três são os requisitos da Meta + LGPD.
    expect(screen.getByText(/Autorizo o IDASAM/i)).toBeInTheDocument();
    expect(screen.getByText(/convites para cursos, oficinas e eventos/i)).toBeInTheDocument();
    expect(screen.getByText(/respondendo PARAR/i)).toBeInTheDocument();
    // A frase de não-retaliação (§3.0) é salvaguarda de consentimento LIVRE.
    expect(screen.getByText(/não afeta em nada/i)).toBeInTheDocument();
  });

  it('o checkbox NASCE desmarcado — caixa pré-marcada é consentimento nulo', () => {
    render(<OptInForm text={TEXT} onSubmit={vi.fn()} isPending={false} />);
    expect(screen.getByRole('checkbox', { name: /autorizo/i })).not.toBeChecked();
  });

  it('sem o aceite não envia nada', async () => {
    const onSubmit = vi.fn();
    render(<OptInForm text={TEXT} onSubmit={onSubmit} isPending={false} />);

    await userEvent.type(screen.getByLabelText(/seu whatsapp/i), '(92) 98765-4321');
    await userEvent.click(screen.getByRole('button', { name: /autorizar/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('envia telefone, nome, finalidade, aceite e o honeypot VAZIO', async () => {
    const onSubmit = vi.fn();
    render(<OptInForm text={TEXT} onSubmit={onSubmit} isPending={false} />);

    await userEvent.type(screen.getByLabelText(/seu nome/i), 'Maria da Silva');
    await userEvent.type(screen.getByLabelText(/seu whatsapp/i), '(92) 98765-4321');
    await userEvent.click(screen.getByRole('checkbox', { name: /autorizo/i }));
    await userEvent.click(screen.getByRole('button', { name: /autorizar/i }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      phone: '(92) 98765-4321',
      name: 'Maria da Silva',
      purposeKey: 'convite_atividades',
      accepted: true,
      website: '',
    });
    // renderedAt alimenta o time-to-submit do backend (< 2s = bot) e a evidência.
    expect(onSubmit.mock.calls[0][0].renderedAt).toEqual(expect.any(String));
  });

  /**
   * O honeypot é a proteção anti-bot que substitui o captcha (PROIBIDO aqui: o
   * público é ribeirinho/rural e o captcha exclui exatamente quem a landing
   * existe para alcançar). Ele só funciona se for invisível ao humano E
   * ignorado pelo autofill/leitor de tela — daí `aria-hidden`, `tabIndex={-1}` e
   * `autoComplete="off"`.
   */
  it('tem o honeypot escondido do humano (aria-hidden, fora do foco, sem autofill)', () => {
    const { container } = render(
      <OptInForm text={TEXT} onSubmit={vi.fn()} isPending={false} />,
    );

    const honeypot = container.querySelector('input[name="website"]') as HTMLInputElement;
    expect(honeypot).toBeTruthy();
    expect(honeypot.value).toBe('');
    expect(honeypot.tabIndex).toBe(-1);
    expect(honeypot.getAttribute('autocomplete')).toBe('off');
    expect(honeypot.closest('[aria-hidden="true"]')).toBeTruthy();
  });
});
