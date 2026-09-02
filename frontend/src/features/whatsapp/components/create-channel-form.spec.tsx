import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreateChannelForm } from './create-channel-form';

// jsdom não tem as APIs de que o Select do Radix depende.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const mutateAsync = vi.fn();
/**
 * Estado do `useZernioAccounts()` por teste. O default é "Zernio indisponível" —
 * que é justamente o caminho de FALLBACK (input manual), o mesmo comportamento
 * que os testes pré-existentes deste arquivo exercitam.
 */
let zernioAccountsState: {
  data?: { accounts: unknown[]; unavailable: boolean };
  isLoading: boolean;
} = { data: { accounts: [], unavailable: true }, isLoading: false };

/**
 * Canais já cadastrados (useProviders) — é com isto que o seletor marca uma
 * conta Zernio como "já cadastrada" ANTES do submit, em vez de deixar o
 * operador descobrir no erro do backend.
 */
let providersState: {
  data?: { providers: Array<{ provider: string; channels: Array<{ id: string; name: string; isActive: boolean; zernioAccountId?: string | null }> }> };
} = { data: { providers: [] } };

vi.mock('../api', () => ({
  useCreateChannel: () => ({ mutateAsync, isPending: false }),
  useZernioAccounts: () => zernioAccountsState,
  useProviders: () => providersState,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

// Mirrors the REAL extractApiError mapping for a backend DomainError response:
// `title` = the PT-BR phrase (DomainError.message), `message` = the technical
// `detail` (e.g. "channelId=..."). The form must display `title` — a previous
// version displayed `message` and leaked the technical detail to the operator.
vi.mock('@/lib/api-error', () => ({
  extractApiError: vi.fn(async (err: unknown) => ({
    title: err instanceof Error ? err.message : 'Erro',
    message: 'channelId=tech-detail-123',
  })),
}));

vi.mock('../provider-scope', () => ({
  PROVIDER_LABEL: { EVOLUTION: 'Evolution', TWILIO: 'Twilio', ZERNIO: 'Zernio', META: 'Meta' },
}));

beforeEach(() => {
  mutateAsync.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  zernioAccountsState = {
    data: { accounts: [], unavailable: true },
    isLoading: false,
  };
  providersState = { data: { providers: [] } };
});

const CONTAS = [
  {
    id: 'a1b2c3d4e5f6a7b8c9d0e1f2',
    displayName: 'Canal CONTINUUM',
    phoneE164: '+5592999998888',
    qualityRating: 'GREEN',
    messagingLimitTier: 'TIER_1K',
    nameStatus: 'APPROVED',
  },
  {
    id: 'a1b2c3d4e5f6a7b8c9d0000c',
    displayName: 'Canal Matheus',
    phoneE164: '+5592777776666',
    qualityRating: 'UNKNOWN',
    nameStatus: 'DECLINED',
  },
];

/**
 * O incidente: o operador DIGITOU um zernioAccountId que não existe. O canal foi
 * criado sem atrito, e todo webhook daquela conta passou a ser descartado em
 * silêncio — um disparo de ~100 mensagens perdido. Com um seletor das contas
 * REAIS, digitar o id errado deixa de ser possível.
 */
describe('CreateChannelForm — seletor de conta Zernio', () => {
  it('lista as contas reais do Zernio num seletor, em vez de um campo de texto livre', async () => {
    zernioAccountsState = {
      data: { accounts: CONTAS, unavailable: false },
      isLoading: false,
    };
    render(<CreateChannelForm provider="ZERNIO" />);

    // O texto livre some: o seletor é o caminho padrão.
    expect(screen.queryByLabelText(/ID da conta Zernio/i)).not.toBeInTheDocument();
    const trigger = screen.getByRole('combobox', { name: /Conta Zernio/i });
    expect(trigger).toBeInTheDocument();

    fireEvent.click(trigger);

    // Cada opção mostra número + nome para o operador RECONHECER a conta dele.
    expect(
      await screen.findByRole('option', { name: /\+5592999998888.*Canal CONTINUUM/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /\+5592777776666.*Canal Matheus/ }),
    ).toBeInTheDocument();
  });

  it('escolher uma conta no seletor envia o accountId correspondente', async () => {
    zernioAccountsState = {
      data: { accounts: CONTAS, unavailable: false },
      isLoading: false,
    };
    mutateAsync.mockResolvedValue({ id: 'c1' });
    render(<CreateChannelForm provider="ZERNIO" />);

    await userEvent.type(screen.getByLabelText('Nome do canal'), 'Vendas Zernio');
    fireEvent.click(screen.getByRole('combobox', { name: /Conta Zernio/i }));
    fireEvent.click(
      await screen.findByRole('option', { name: /Canal CONTINUUM/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Cadastrar canal/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ZERNIO',
        name: 'Vendas Zernio',
        zernioAccountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
      }),
    );
  });

  it('submeter sem escolher conta é bloqueado com dica inline', async () => {
    zernioAccountsState = {
      data: { accounts: CONTAS, unavailable: false },
      isLoading: false,
    };
    render(<CreateChannelForm provider="ZERNIO" />);

    await userEvent.type(screen.getByLabelText('Nome do canal'), 'Vendas Zernio');
    fireEvent.click(screen.getByRole('button', { name: /Cadastrar canal/i }));

    await waitFor(() =>
      expect(screen.getByText(/Escolha a conta Zernio/i)).toBeInTheDocument(),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('Zernio indisponível → cai no input manual (a configuração nunca fica travada)', () => {
    zernioAccountsState = {
      data: { accounts: [], unavailable: true },
      isLoading: false,
    };
    render(<CreateChannelForm provider="ZERNIO" />);

    expect(screen.getByLabelText(/ID da conta Zernio/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: /Conta Zernio/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Não foi possível listar as contas do Zernio/i),
    ).toBeInTheDocument();
  });

  it('com o seletor disponível, ainda permite alternar para entrada manual (fallback)', async () => {
    zernioAccountsState = {
      data: { accounts: CONTAS, unavailable: false },
      isLoading: false,
    };
    render(<CreateChannelForm provider="ZERNIO" />);

    fireEvent.click(screen.getByRole('button', { name: /informar o ID manualmente/i }));

    expect(await screen.findByLabelText(/ID da conta Zernio/i)).toBeInTheDocument();
  });

  it('enquanto as contas carregam, mostra o seletor desabilitado — sem "flash" do input manual', () => {
    // Antes: durante o loading o form renderizava o input manual e depois
    // TROCAVA para o seletor — o operador via a tela mudar de forma sozinha.
    zernioAccountsState = { data: undefined, isLoading: true };
    render(<CreateChannelForm provider="ZERNIO" />);

    const trigger = screen.getByRole('combobox', { name: /Conta Zernio/i });
    expect(trigger).toBeDisabled();
    expect(screen.getByText(/Carregando contas do Zernio/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/ID da conta Zernio/i)).not.toBeInTheDocument();
  });

  it('conta que já tem canal ATIVO aparece marcada e desabilitada — a duplicata morre antes do submit', async () => {
    zernioAccountsState = {
      data: { accounts: CONTAS, unavailable: false },
      isLoading: false,
    };
    providersState = {
      data: {
        providers: [
          {
            provider: 'ZERNIO',
            channels: [
              { id: 'ch1', name: 'Matheus Garcia', isActive: true, zernioAccountId: CONTAS[0].id },
              // Canal DESATIVADO não bloqueia: recadastrar a conta é legítimo.
              { id: 'ch2', name: 'Antigo', isActive: false, zernioAccountId: CONTAS[1].id },
            ],
          },
        ],
      },
    };
    render(<CreateChannelForm provider="ZERNIO" />);

    fireEvent.click(screen.getByRole('combobox', { name: /Conta Zernio/i }));

    const taken = await screen.findByRole('option', { name: /Canal CONTINUUM.*já cadastrada/ });
    expect(taken).toHaveAttribute('data-disabled');
    const free = screen.getByRole('option', { name: /Canal Matheus/ });
    expect(free).not.toHaveAttribute('data-disabled');
    expect(free).not.toHaveTextContent(/já cadastrada/);
  });

  it('escolher a conta preenche o nome do canal vazio (e não sobrescreve um nome digitado)', async () => {
    zernioAccountsState = {
      data: { accounts: CONTAS, unavailable: false },
      isLoading: false,
    };
    render(<CreateChannelForm provider="ZERNIO" />);

    // Nome vazio → escolher a conta sugere o displayName dela.
    fireEvent.click(screen.getByRole('combobox', { name: /Conta Zernio/i }));
    fireEvent.click(await screen.findByRole('option', { name: /Canal CONTINUUM/ }));
    expect(screen.getByLabelText('Nome do canal')).toHaveValue('Canal CONTINUUM');

    // Nome já digitado → trocar a conta NÃO mexe no que o operador escreveu.
    await userEvent.clear(screen.getByLabelText('Nome do canal'));
    await userEvent.type(screen.getByLabelText('Nome do canal'), 'Meu nome');
    fireEvent.click(screen.getByRole('combobox', { name: /Conta Zernio/i }));
    fireEvent.click(await screen.findByRole('option', { name: /Canal Matheus/ }));
    expect(screen.getByLabelText('Nome do canal')).toHaveValue('Meu nome');
  });
});

describe('CreateChannelForm — E.164 validation', () => {
  it('blocks submit and shows an inline hint for a non-E.164 number', async () => {
    render(<CreateChannelForm provider="TWILIO" />);
    await userEvent.type(screen.getByLabelText('Nome do canal'), 'Vendas');
    await userEvent.type(screen.getByLabelText(/Número/i), '11987654321'); // missing '+'
    fireEvent.click(screen.getByRole('button', { name: /Cadastrar canal/i }));

    await waitFor(() => expect(screen.getByText(/formato E\.164/i)).toBeInTheDocument());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('accepts a valid +E.164 number, submits, and fires a success toast', async () => {
    mutateAsync.mockResolvedValue({ id: 'c1' });
    render(<CreateChannelForm provider="TWILIO" />);
    await userEvent.type(screen.getByLabelText('Nome do canal'), 'Vendas');
    await userEvent.type(screen.getByLabelText(/Número/i), '+5592988887777');
    fireEvent.click(screen.getByRole('button', { name: /Cadastrar canal/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'TWILIO',
        name: 'Vendas',
        phoneE164: '+5592988887777',
      }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Canal cadastrado'));
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('CreateChannelForm — backend errors', () => {
  it('shows the backend PT-BR message inline (not a toast) when the request rejects', async () => {
    mutateAsync.mockRejectedValue(new Error('Número já cadastrado em outro canal'));
    render(<CreateChannelForm provider="TWILIO" />);
    await userEvent.type(screen.getByLabelText('Nome do canal'), 'Vendas');
    await userEvent.type(screen.getByLabelText(/Número/i), '+5592988887777');
    fireEvent.click(screen.getByRole('button', { name: /Cadastrar canal/i }));

    await waitFor(() =>
      expect(screen.getByText('Número já cadastrado em outro canal')).toBeInTheDocument(),
    );
    // The technical `detail` must never surface to the operator.
    expect(screen.queryByText('channelId=tech-detail-123')).not.toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('CreateChannelForm — provider-specific fields', () => {
  it('offers the Messaging Service SID field only for Twilio', () => {
    const { rerender } = render(<CreateChannelForm provider="TWILIO" />);
    expect(screen.getByLabelText(/Messaging Service SID/i)).toBeInTheDocument();
    rerender(<CreateChannelForm provider="ZERNIO" />);
    expect(screen.queryByLabelText(/Messaging Service SID/i)).not.toBeInTheDocument();
  });

  it('TWILIO shows the phone number field but hides the Zernio account id field', () => {
    render(<CreateChannelForm provider="TWILIO" />);
    expect(screen.getByLabelText(/Número/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/ID da conta Zernio/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Messaging Service SID/i)).toBeInTheDocument();
  });

  it('ZERNIO shows the account id field (with help text) and hides phone number + Messaging Service SID', () => {
    // Zernio ALCANÇÁVEL, porém sem nenhuma WABA conectada: não há o que
    // selecionar, então o input manual segue sendo o caminho — e a dica é a
    // original ("está no dashboard"), não a de indisponibilidade.
    zernioAccountsState = {
      data: { accounts: [], unavailable: false },
      isLoading: false,
    };
    render(<CreateChannelForm provider="ZERNIO" />);
    expect(screen.getByLabelText(/ID da conta Zernio/i)).toBeInTheDocument();
    expect(
      screen.getByText(/ID da conta conectada no dashboard do Zernio/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Número/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Messaging Service SID/i)).not.toBeInTheDocument();
  });
});

describe('CreateChannelForm — ZERNIO validation', () => {
  it('blocks submit and shows an inline hint when zernioAccountId is missing', async () => {
    render(<CreateChannelForm provider="ZERNIO" />);
    await userEvent.type(screen.getByLabelText('Nome do canal'), 'Vendas Zernio');
    fireEvent.click(screen.getByRole('button', { name: /Cadastrar canal/i }));

    await waitFor(() =>
      expect(screen.getByText(/ID da conta Zernio é obrigatório/i)).toBeInTheDocument(),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('accepts a zernioAccountId, submits without phoneE164, and fires a success toast', async () => {
    mutateAsync.mockResolvedValue({ id: 'c1' });
    render(<CreateChannelForm provider="ZERNIO" />);
    await userEvent.type(screen.getByLabelText('Nome do canal'), 'Vendas Zernio');
    await userEvent.type(screen.getByLabelText(/ID da conta Zernio/i), 'a1b2c3d4abc');
    fireEvent.click(screen.getByRole('button', { name: /Cadastrar canal/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ZERNIO',
        name: 'Vendas Zernio',
        zernioAccountId: 'a1b2c3d4abc',
        phoneE164: undefined,
      }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Canal cadastrado'));
  });

  it('shows the backend PT-BR message inline for a duplicate Zernio account (channel.duplicate_zernio_account)', async () => {
    mutateAsync.mockRejectedValue(
      new Error('Já existe um canal ativo com a conta Zernio a1b2c3d4abc.'),
    );
    render(<CreateChannelForm provider="ZERNIO" />);
    await userEvent.type(screen.getByLabelText('Nome do canal'), 'Vendas Zernio');
    await userEvent.type(screen.getByLabelText(/ID da conta Zernio/i), 'a1b2c3d4abc');
    fireEvent.click(screen.getByRole('button', { name: /Cadastrar canal/i }));

    await waitFor(() =>
      expect(
        screen.getByText('Já existe um canal ativo com a conta Zernio a1b2c3d4abc.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('channelId=tech-detail-123')).not.toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
