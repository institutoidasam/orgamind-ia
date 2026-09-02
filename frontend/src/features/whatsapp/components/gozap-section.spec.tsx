import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelSummary } from '../api';

// Stub the three dialogs — GozapSection's own tests drive them by their
// props/callbacks, not their internals (covered by their own specs).
let lastCreateDialogProps: {
  open: boolean;
  onCreated: (c: { id: string; name: string }) => void;
} | null = null;
let lastQrDialogProps: { open: boolean; channelId: string | null } | null = null;
let lastRemoveDialogProps: {
  open: boolean;
  channel: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
} | null = null;

vi.mock('./create-gozap-channel-dialog', () => ({
  CreateGozapChannelDialog: (props: {
    open: boolean;
    onCreated: (c: { id: string; name: string }) => void;
  }) => {
    lastCreateDialogProps = props;
    return props.open ? <div data-testid="create-dialog" /> : null;
  },
}));
vi.mock('./gozap-qr-dialog', () => ({
  GozapQrDialog: (props: {
    open: boolean;
    channelId: string | null;
    onOpenChange: (open: boolean) => void;
  }) => {
    lastQrDialogProps = props;
    return props.open ? <div data-testid="qr-dialog">{props.channelId}</div> : null;
  },
}));
// Confirmação de remoção (digitar o nome, DELETE real) fica inteira no
// próprio dialog — coberto em remove-gozap-channel-dialog.spec.tsx. Aqui só
// se testa a FIAÇÃO: clicar "Remover" abre o dialog com o canal certo.
vi.mock('./remove-gozap-channel-dialog', () => ({
  RemoveGozapChannelDialog: (props: {
    open: boolean;
    channel: { id: string; name: string } | null;
    onOpenChange: (open: boolean) => void;
  }) => {
    lastRemoveDialogProps = props;
    return props.open ? <div data-testid="remove-dialog">{props.channel?.name}</div> : null;
  },
}));

import { GozapSection } from './gozap-section';

const CHANNELS: ChannelSummary[] = [
  { id: 'ch1', name: 'Loja 1', phoneE164: null, isActive: true, isDefault: false, provider: 'GOZAP' },
];

function wrap(ui: React.ReactElement) {
  return render(ui);
}

beforeEach(() => {
  lastCreateDialogProps = null;
  lastQrDialogProps = null;
  lastRemoveDialogProps = null;
});

describe('GozapSection — rendering', () => {
  it('renders each GOZAP channel from `channels` (not hardcoded)', () => {
    wrap(<GozapSection role="ADMIN" channels={CHANNELS} />);
    expect(screen.getByText('Loja 1')).toBeInTheDocument();
  });

  it('shows a PT-BR empty state when there are no channels yet', () => {
    wrap(<GozapSection role="ADMIN" channels={[]} />);
    expect(screen.getByText(/Nenhum canal GoZap cadastrado/i)).toBeInTheDocument();
  });

  it('OPERATOR does not see "Nova conexão" or "Remover" — ADMIN-only actions', () => {
    wrap(<GozapSection role="OPERATOR" channels={CHANNELS} />);
    expect(screen.queryByRole('button', { name: /Nova conexão/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remover/i })).not.toBeInTheDocument();
    // "Conectar" (pairing) stays available to OPERATOR, same as EVOLUTION.
    expect(screen.getByRole('button', { name: /Conectar/i })).toBeInTheDocument();
  });
});

describe('GozapSection — connect / create flow', () => {
  it('clicking "Conectar" on an existing channel opens the QR dialog for that channel id', () => {
    wrap(<GozapSection role="ADMIN" channels={CHANNELS} />);
    fireEvent.click(screen.getByRole('button', { name: /Conectar/i }));
    expect(screen.getByTestId('qr-dialog')).toHaveTextContent('ch1');
  });

  it('"Nova conexão" opens the create dialog', () => {
    wrap(<GozapSection role="ADMIN" channels={CHANNELS} />);
    expect(screen.queryByTestId('create-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Nova conexão/i }));
    expect(screen.getByTestId('create-dialog')).toBeInTheDocument();
  });

  it('creating a channel opens the QR dialog for the newly created channel', () => {
    wrap(<GozapSection role="ADMIN" channels={CHANNELS} />);
    fireEvent.click(screen.getByRole('button', { name: /Nova conexão/i }));

    act(() => {
      lastCreateDialogProps?.onCreated({ id: 'new1', name: 'Loja Nova' });
    });

    expect(screen.getByTestId('qr-dialog')).toHaveTextContent('new1');
    // The create dialog closes once the QR step takes over.
    expect(lastCreateDialogProps?.open).toBe(false);
  });

  it('closing the QR dialog clears the connect state — reopening any channel starts fresh', () => {
    wrap(<GozapSection role="ADMIN" channels={CHANNELS} />);
    fireEvent.click(screen.getByRole('button', { name: /Conectar/i }));
    expect(lastQrDialogProps?.open).toBe(true);
    expect(lastQrDialogProps?.channelId).toBe('ch1');

    act(() => {
      lastQrDialogProps?.onOpenChange(false);
    });

    expect(screen.queryByTestId('qr-dialog')).not.toBeInTheDocument();
    expect(lastQrDialogProps?.open).toBe(false);
  });
});

describe('GozapSection — remove handling', () => {
  // A remoção real (DELETE + confirmação digitada) foi pedida pelo cliente
  // depois de um incidente de conta com limite de 1 instância — mora inteira
  // no RemoveGozapChannelDialog agora, para que um clique não dispare a
  // exclusão sem confirmação. Aqui só se prova a fiação.
  it('clicking "Remover" opens the confirm dialog for that channel — does NOT delete immediately', () => {
    wrap(<GozapSection role="ADMIN" channels={CHANNELS} />);
    expect(screen.queryByTestId('remove-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Remover/i }));

    expect(screen.getByTestId('remove-dialog')).toHaveTextContent('Loja 1');
    expect(lastRemoveDialogProps?.channel).toEqual({ id: 'ch1', name: 'Loja 1' });
  });

  it('closing the confirm dialog clears the remove target', () => {
    wrap(<GozapSection role="ADMIN" channels={CHANNELS} />);
    fireEvent.click(screen.getByRole('button', { name: /Remover/i }));
    expect(lastRemoveDialogProps?.open).toBe(true);

    act(() => {
      lastRemoveDialogProps?.onOpenChange(false);
    });

    expect(screen.queryByTestId('remove-dialog')).not.toBeInTheDocument();
  });
});

describe('GozapSection — canal removido some da lista (não fica "inativo" para sempre)', () => {
  // Regressão do "Remover conexão não remove" relatado pelo cliente: a
  // remoção GOZAP é soft-delete (isActive:false) no banco, mas
  // GET /whatsapp/providers devolve TODO canal (ativo e inativo) — sem este
  // filtro a linha continuava na tela para sempre, e o clique em "Remover"
  // parecia não ter feito nada.
  it('a channel with isActive: false is not rendered', () => {
    const removed: ChannelSummary[] = [
      { id: 'ch1', name: 'Loja 1', phoneE164: null, isActive: false, isDefault: false, provider: 'GOZAP' },
    ];
    wrap(<GozapSection role="ADMIN" channels={removed} />);

    expect(screen.queryByText('Loja 1')).not.toBeInTheDocument();
    expect(screen.getByText(/Nenhum canal GoZap cadastrado/i)).toBeInTheDocument();
  });

  it('a mixed list shows only the still-active channel', () => {
    const mixed: ChannelSummary[] = [
      { id: 'ch1', name: 'Loja 1', phoneE164: null, isActive: true, isDefault: false, provider: 'GOZAP' },
      { id: 'ch2', name: 'Loja Removida', phoneE164: null, isActive: false, isDefault: false, provider: 'GOZAP' },
    ];
    wrap(<GozapSection role="ADMIN" channels={mixed} />);

    expect(screen.getByText('Loja 1')).toBeInTheDocument();
    expect(screen.queryByText('Loja Removida')).not.toBeInTheDocument();
  });
});

describe('GozapSection — estado de conexão', () => {
  it('shows "Conectado" for a channel with connectionState: open', () => {
    const connected: ChannelSummary[] = [
      { id: 'ch1', name: 'Loja 1', phoneE164: '+5592987654321', isActive: true, isDefault: false, provider: 'GOZAP', connectionState: 'open' },
    ];
    wrap(<GozapSection role="ADMIN" channels={connected} />);
    expect(screen.getByText('Conectado')).toBeInTheDocument();
  });

  it('shows "Desconectado" for a channel with connectionState: close', () => {
    const closed: ChannelSummary[] = [
      { id: 'ch1', name: 'Loja 1', phoneE164: null, isActive: true, isDefault: false, provider: 'GOZAP', connectionState: 'close' },
    ];
    wrap(<GozapSection role="ADMIN" channels={closed} />);
    expect(screen.getByText('Desconectado')).toBeInTheDocument();
  });

  it('shows nothing (no fabricated status) when connectionState is absent', () => {
    wrap(<GozapSection role="ADMIN" channels={CHANNELS} />);
    expect(screen.queryByText('Conectado')).not.toBeInTheDocument();
    expect(screen.queryByText('Desconectado')).not.toBeInTheDocument();
    expect(screen.queryByText(/Conectando/)).not.toBeInTheDocument();
  });
});
