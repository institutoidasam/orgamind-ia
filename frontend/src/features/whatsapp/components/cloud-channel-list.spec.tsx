import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import type { ChannelSummary } from '../api';
import { CloudChannelList } from './cloud-channel-list';

// Sem mock de '../provider-scope': ProviderBadge e ConnectionStateBadge são
// componentes puros (sem hooks) e é justamente a integração REAL entre
// CloudChannelList e ConnectionStateBadge que falta cobertura hoje —
// cloud-provider-section.spec.tsx mocka ConnectionStateBadge para `() =>
// null`, então nenhum teste do repo prova o que a lista de fato mostra.

function channel(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: 'c1',
    name: 'Vendas Twilio',
    phoneE164: '+5592988887777',
    isActive: true,
    isDefault: true,
    provider: 'TWILIO',
    ...over,
  };
}

describe('CloudChannelList', () => {
  it('mostra o estado vazio quando não há canais', () => {
    render(<CloudChannelList channels={[]} />);
    expect(screen.getByText(/Nenhum canal cadastrado/i)).toBeInTheDocument();
  });

  it('mostra nome, número e o selo do provedor de cada canal', () => {
    render(<CloudChannelList channels={[channel()]} />);
    expect(screen.getByText('Vendas Twilio')).toBeInTheDocument();
    expect(screen.getByText('+5592988887777')).toBeInTheDocument();
    expect(screen.getByText('Twilio')).toBeInTheDocument();
  });

  it('mostra "—" quando o canal não tem phoneE164', () => {
    render(<CloudChannelList channels={[channel({ phoneE164: null })]} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('marca "default" só no canal isDefault', () => {
    render(
      <CloudChannelList
        channels={[
          channel({ id: 'c1', isDefault: true }),
          channel({ id: 'c2', name: 'Outro canal', isDefault: false }),
        ]}
      />,
    );
    expect(screen.getAllByText('default')).toHaveLength(1);
  });

  it('marca "inativo" no canal com isActive=false, e não marca num canal ativo', () => {
    const { rerender } = render(<CloudChannelList channels={[channel({ isActive: false })]} />);
    expect(screen.getByText('inativo')).toBeInTheDocument();

    rerender(<CloudChannelList channels={[channel({ isActive: true })]} />);
    expect(screen.queryByText('inativo')).not.toBeInTheDocument();
  });

  it('botão de sincronizar só aparece quando onSyncInbox é passado, e chama com o id do canal', async () => {
    const onSyncInbox = vi.fn();
    const user = userEvent.setup();
    render(
      <CloudChannelList
        channels={[channel({ provider: 'ZERNIO' })]}
        onSyncInbox={onSyncInbox}
      />,
    );
    await user.click(screen.getByRole('button', { name: /sincronizar inbox/i }));
    expect(onSyncInbox).toHaveBeenCalledWith('c1');
  });

  it('sem onSyncInbox, nenhum botão de sync aparece', () => {
    render(<CloudChannelList channels={[channel()]} />);
    expect(screen.queryByRole('button', { name: /sincronizar inbox/i })).not.toBeInTheDocument();
  });

  it('botão de ativar/desativar alterna o rótulo conforme isActive e chama onSetActive invertendo o estado', async () => {
    const onSetActive = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <CloudChannelList channels={[channel({ isActive: true })]} onSetActive={onSetActive} />,
    );
    await user.click(screen.getByRole('button', { name: 'Desativar' }));
    expect(onSetActive).toHaveBeenCalledWith('c1', false);

    rerender(<CloudChannelList channels={[channel({ isActive: false })]} onSetActive={onSetActive} />);
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeInTheDocument();
  });

  it('sem onSetActive, nenhum botão de ativar/desativar aparece', () => {
    render(<CloudChannelList channels={[channel()]} />);
    expect(screen.queryByRole('button', { name: /desativar|reativar/i })).not.toBeInTheDocument();
  });

  it.each([
    ['open', 'Conectado'],
    ['connecting', 'Conectando…'],
    ['close', 'Desconectado'],
  ] as const)('mostra o selo de conexão "%s" quando connectionState é "%s"', (state, label) => {
    render(<CloudChannelList channels={[channel({ connectionState: state })]} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // Contrato (instance.schema.ts): connectionState null é o caso do canal
  // OFICIAL (TWILIO/ZERNIO/META — sempre "no ar" enquanto ativo, sem
  // pareamento por QR). A lista não pode inventar um "desconectado" que o
  // backend nunca afirmou.
  it('canal oficial (connectionState null) não exibe nenhum selo de conexão', () => {
    render(<CloudChannelList channels={[channel({ provider: 'TWILIO', connectionState: null })]} />);
    expect(screen.queryByText(/Conectado|Conectando|Desconectado/)).not.toBeInTheDocument();
  });
});
