import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { OptInLinkCard } from './optin-link-card';
import type { OptInLink } from '../optin-links';

const LINK: OptInLink = {
  id: 'l1',
  token: 'FEIRA-MANAUS-2026',
  purposeKey: 'convite_atividades',
  purposeLabel: 'Convites para cursos, oficinas e eventos',
  consentTextVersion: 'optin-v1',
  expectedText:
    'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp com convites para cursos, oficinas e eventos. [FEIRA-MANAUS-2026]',
  url: 'https://wa.me/559231550103?text=Autorizo%20o%20IDASAM%20%5BFEIRA-MANAUS-2026%5D',
  senderDigits: '559231550103',
  channelName: 'Principal',
  channelId: 'ch1',
  description: 'Cartaz da feira de Manaus',
  active: true,
  grants: 7,
  createdAt: new Date('2026-07-01'),
};

describe('OptInLinkCard', () => {
  /**
   * O QR é o entregável físico: ele vai para o cartaz, a prancheta do agente de
   * campo e o adesivo. Se ele não renderiza, a coleta em campo não existe.
   */
  it('renderiza o QR Code do link como imagem', async () => {
    render(<OptInLinkCard link={LINK} onToggleActive={() => {}} />);

    const img = await screen.findByRole('img', {
      name: /qr code.*feira-manaus-2026/i,
    });
    await waitFor(() => expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/));
  });

  it('mostra o funil: quantos consentimentos já vieram deste token', () => {
    render(<OptInLinkCard link={LINK} onToggleActive={() => {}} />);
    expect(screen.getByText(/7/)).toBeInTheDocument();
    expect(screen.getByText(/consentimento/i)).toBeInTheDocument();
  });

  /**
   * O texto pré-preenchido É a prova. O operador precisa VER o que o titular
   * vai enviar — é isso que ele está mandando imprimir.
   */
  it('exibe a declaração que o link pré-preenche e a versão do texto canônico', () => {
    render(<OptInLinkCard link={LINK} onToggleActive={() => {}} />);
    expect(screen.getByText(/Autorizo o IDASAM/)).toBeInTheDocument();
    expect(screen.getByText(/optin-v1/)).toBeInTheDocument();
  });

  it('copia o link para a área de transferência', async () => {
    // userEvent.setup() instala o stub de clipboard do jsdom — lemos dele.
    const user = userEvent.setup();
    render(<OptInLinkCard link={LINK} onToggleActive={() => {}} />);

    await user.click(screen.getByRole('button', { name: /copiar link/i }));

    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(LINK.url),
    );
  });

  it('desativa o link (nunca exclui — o ponto de coleta é trilha de prova)', async () => {
    const user = userEvent.setup();
    const onToggleActive = vi.fn();
    render(<OptInLinkCard link={LINK} onToggleActive={onToggleActive} />);

    await user.click(screen.getByRole('button', { name: /desativar/i }));

    expect(onToggleActive).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('button', { name: /excluir/i })).not.toBeInTheDocument();
  });

  it('um link inativo aparece marcado e oferece reativar', () => {
    render(<OptInLinkCard link={{ ...LINK, active: false }} onToggleActive={() => {}} />);
    expect(screen.getByText(/inativo/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reativar/i })).toBeInTheDocument();
  });
});
