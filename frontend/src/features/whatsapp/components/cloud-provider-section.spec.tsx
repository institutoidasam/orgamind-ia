import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelProvider, ChannelSummary } from '../api';
import { CloudProviderSection } from './cloud-provider-section';

// CloudChannelList (real) renders a ProviderBadge; stub it to avoid pulling the
// provider-scope → api chain. Stub the form to a marker so we assert placement
// without exercising react-hook-form here (covered in create-channel-form.spec).
vi.mock('../provider-scope', () => ({
  ProviderBadge: ({ provider }: { provider: ChannelProvider }) => <span>{provider}</span>,
  ConnectionStateBadge: () => null,
}));
vi.mock('./create-channel-form', () => ({
  CreateChannelForm: ({ provider }: { provider: ChannelProvider }) => (
    <div data-testid="create-form">form:{provider}</div>
  ),
}));

const syncMutate = vi.fn();
/** O que o polling de `GET .../sync-inbox/status` devolveria agora. */
let syncStatus: unknown = undefined;

/**
 * ZB — a saúde dos canais. Stub por padrão (sem canais): o `useChannelHealth`
 * real é um `useQuery` e exigiria um QueryClientProvider aqui. Cada teste que
 * se importa com a saúde escreve neste estado.
 */
let channelHealthState: { data?: { channels: unknown[] } } = {
  data: { channels: [] },
};

const setActiveMutate = vi.fn();

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  useSyncZernioInbox: () => ({ mutateAsync: syncMutate, isPending: false }),
  useZernioSyncStatus: () => ({ data: syncStatus }),
  useUpdateChannel: () => ({ mutateAsync: setActiveMutate, isPending: false }),
  // Fiel ao react-query: query desabilitada NÃO tem `data`. Sem isso o teste do
  // gate de OPERATOR passaria por acidente (estado vazio), em vez de provar que
  // o componente não pede a saúde.
  useChannelHealth: (enabled: boolean) =>
    enabled ? channelHealthState : { data: undefined },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const channels: ChannelSummary[] = [
  {
    id: 'c1',
    name: 'Vendas Twilio',
    phoneE164: '+5592988887777',
    isActive: true,
    isDefault: true,
    provider: 'TWILIO',
  },
];

const zernioChannels: ChannelSummary[] = [
  {
    id: 'z1',
    name: 'Canal Zernio',
    phoneE164: '+5592988886666',
    isActive: true,
    isDefault: true,
    provider: 'ZERNIO',
  },
];

/** A seção invalida a inbox no fim do job — precisa de um QueryClient. */
function render(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (node: React.ReactElement) => (
    <QueryClientProvider client={qc}>{node}</QueryClientProvider>
  );
  const res = rtlRender(wrap(ui));
  // O rerender tem de manter o provider — senão os testes que trocam de provider
  // (TWILIO → ZERNIO) explodiriam com "No QueryClient set".
  return { ...res, rerender: (next: React.ReactElement) => res.rerender(wrap(next)) };
}

const status = (over: Record<string, unknown> = {}) => ({
  runId: 'run1',
  status: 'RUNNING',
  total: 100,
  processed: 42,
  imported: 137,
  failed: 0,
  error: null,
  ...over,
});

beforeEach(() => {
  syncMutate.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  syncStatus = undefined;
  syncMutate.mockResolvedValue({ runId: 'run1', status: 'PENDING', enqueued: true });
  channelHealthState = { data: { channels: [] } };
});

describe('CloudProviderSection', () => {
  it('lists the registered channels (name + number)', () => {
    render(<CloudProviderSection provider="TWILIO" channels={channels} role="ADMIN" />);
    expect(screen.getByText('Vendas Twilio')).toBeInTheDocument();
    expect(screen.getByText('+5592988887777')).toBeInTheDocument();
  });

  it('shows an empty state when there are no channels', () => {
    render(<CloudProviderSection provider="TWILIO" channels={[]} role="ADMIN" />);
    expect(screen.getByText(/Nenhum canal cadastrado/i)).toBeInTheDocument();
  });

  it('renders the Zernio WABA placeholder only for ZERNIO', () => {
    const { rerender } = render(
      <CloudProviderSection provider="TWILIO" channels={[]} role="ADMIN" />,
    );
    expect(screen.queryByText(/dashboard do Zernio/i)).not.toBeInTheDocument();
    rerender(<CloudProviderSection provider="ZERNIO" channels={[]} role="ADMIN" />);
    expect(screen.getByText(/dashboard do Zernio/i)).toBeInTheDocument();
  });

  it('offers the registration form to admins but not operators', () => {
    const { rerender } = render(
      <CloudProviderSection provider="TWILIO" channels={[]} role="ADMIN" />,
    );
    expect(screen.getByTestId('create-form')).toBeInTheDocument();
    rerender(<CloudProviderSection provider="TWILIO" channels={[]} role="OPERATOR" />);
    expect(screen.queryByTestId('create-form')).not.toBeInTheDocument();
  });

  // O botão só existe onde há o que sincronizar: o backfill do inbox é uma
  // capacidade do Zernio (a Twilio não tem endpoint de histórico de conversa).
  it('mostra "Sincronizar inbox" só em canal ZERNIO e só para ADMIN', () => {
    const { rerender } = render(
      <CloudProviderSection provider="TWILIO" channels={channels} role="ADMIN" />,
    );
    expect(screen.queryByRole('button', { name: /sincronizar inbox/i })).not.toBeInTheDocument();

    rerender(<CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="OPERATOR" />);
    expect(screen.queryByRole('button', { name: /sincronizar inbox/i })).not.toBeInTheDocument();

    rerender(<CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />);
    expect(screen.getByRole('button', { name: /sincronizar inbox/i })).toBeInTheDocument();
  });

  /**
   * O clique não sincroniza mais NA REQUEST. Ele enfileira e volta na hora — era
   * a request síncrona de ~100 conversas que estourava o balde do Zernio, tomava
   * 429 e devolvia HTTP 500 com a tela travada há minutos.
   */
  it('o clique ENFILEIRA (não segura a tela esperando o sync)', async () => {
    render(<CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />);

    await userEvent.click(screen.getByRole('button', { name: /sincronizar inbox/i }));

    expect(syncMutate).toHaveBeenCalledWith('z1');
  });

  it('mostra o PROGRESSO enquanto o job roda ("42 de 100 conversas")', async () => {
    syncStatus = status({ status: 'RUNNING', processed: 42, total: 100 });
    render(<CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />);

    await userEvent.click(screen.getByRole('button', { name: /sincronizar inbox/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /42 de 100/i })).toBeInTheDocument(),
    );
  });

  it('ao terminar, mostra o resultado (conversas e mensagens importadas)', async () => {
    syncStatus = status({
      status: 'SUCCEEDED',
      processed: 100,
      total: 100,
      imported: 137,
      failed: 0,
    });
    render(<CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />);

    await userEvent.click(screen.getByRole('button', { name: /sincronizar inbox/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [title, opts] = toastSuccess.mock.calls[0] as [string, { description?: string }];
    expect(`${title} ${opts?.description ?? ''}`).toMatch(/137/);
  });

  /**
   * Falha PARCIAL não é erro: 98 conversas entraram. Dizer "deu erro" apagaria as
   * 98 — que é exatamente o que o HTTP 500 fazia.
   */
  it('erro parcial não vira erro: diz quantas entraram e quantas falharam', async () => {
    syncStatus = status({
      status: 'SUCCEEDED',
      processed: 100,
      total: 100,
      imported: 300,
      failed: 2,
    });
    render(<CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />);

    await userEvent.click(screen.getByRole('button', { name: /sincronizar inbox/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [, opts] = toastSuccess.mock.calls[0] as [string, { description?: string }];
    expect(opts?.description ?? '').toMatch(/2/); // as que falharam, ditas
    expect(toastError).not.toHaveBeenCalled();
  });

  it('job que falhou mostra o MOTIVO (não um 500 mudo)', async () => {
    syncStatus = status({ status: 'FAILED', error: 'chave do Zernio revogada (401)' });
    render(<CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />);

    await userEvent.click(screen.getByRole('button', { name: /sincronizar inbox/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const [, opts] = toastError.mock.calls[0] as [string, { description?: string }];
    expect(opts?.description ?? '').toMatch(/401|revogada/i);
  });

  // O sync cedeu o balde para uma campanha — não é erro nem travamento.
  it('sync pausado por campanha ativa diz que está esperando o envio', async () => {
    syncStatus = status({ status: 'PAUSED', processed: 12, total: 100 });
    render(<CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />);

    await userEvent.click(screen.getByRole('button', { name: /sincronizar inbox/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /aguardando|pausado/i })).toBeInTheDocument(),
    );
  });

  it('mostra erro quando o enfileiramento falha', async () => {
    syncMutate.mockRejectedValue(new Error('boom'));
    render(<CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />);

    await userEvent.click(screen.getByRole('button', { name: /sincronizar inbox/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  // ZB — a saúde aparece no canal ao qual pertence, casada por channelId.
  it('mostra o card de saúde do canal ZERNIO', () => {
    channelHealthState = {
      data: {
        channels: [
          {
            channelId: 'z1',
            channelName: 'Canal Zernio',
            provider: 'ZERNIO',
            zernioAccountId: 'acc_1',
            messagingLimitTier: 'TIER_2K',
            tierLimit: 2000,
            uniqueRecipients24h: 1700,
            tierUsagePct: 85,
            nearTierLimit: true,
            qualityRating: 'GREEN',
            nameStatus: 'DECLINED',
            stale: false,
            syncedAt: new Date(),
          },
        ],
      },
    };

    render(
      <CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />,
    );

    expect(screen.getByText(/TIER_2K/)).toBeInTheDocument();
    expect(screen.getByTestId('quality-rating')).toHaveTextContent('Boa');
    // Os dois alertas que motivam a tela: perto do teto e nome reprovado.
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent ?? '');
    expect(alerts.some((t) => /teto do tier/i.test(t))).toBe(true);
    expect(alerts.some((t) => /o destinatário vê o número/i.test(t))).toBe(true);
  });

  // O endpoint de saúde é ADMIN-only: pedi-lo como OPERATOR renderia um 403. O
  // estado de saúde aqui está POPULADO de propósito — se o componente não
  // desabilitasse a query, o card apareceria e este teste falharia.
  it('não busca saúde para OPERATOR', () => {
    channelHealthState = {
      data: {
        channels: [
          {
            channelId: 'z1',
            channelName: 'Canal Zernio',
            provider: 'ZERNIO',
            zernioAccountId: 'acc_1',
            tierLimit: 2000,
            uniqueRecipients24h: 10,
            tierUsagePct: 1,
            nearTierLimit: false,
            qualityRating: 'GREEN',
            stale: false,
            syncedAt: new Date(),
          },
        ],
      },
    };

    render(
      <CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="OPERATOR" />,
    );

    expect(screen.queryByTestId('quality-rating')).not.toBeInTheDocument();
  });
});

/**
 * CANAL ÚNICO — o operador precisa DESLIGAR um canal pela tela.
 *
 * A base tem mais de uma conta Zernio e só UMA pode disparar. Enquanto a
 * proibida aparecer como opção no assistente de campanha, um clique errado manda
 * a campanha inteira pelo número errado — e não existe despublicar mensagem de
 * WhatsApp. Desativar é a trava.
 */
describe('CloudProviderSection — ligar/desligar canal', () => {
  beforeEach(() => setActiveMutate.mockReset());

  it('ADMIN vê "Desativar" num canal ativo e o clique desliga o canal', async () => {
    const user = userEvent.setup();
    render(
      <CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />,
    );

    await user.click(screen.getByRole('button', { name: /desativar/i }));

    expect(setActiveMutate).toHaveBeenCalledWith({ id: 'z1', active: false });
  });

  it('canal DESATIVADO oferece "Reativar" — desativar não apaga, é reversível', async () => {
    const user = userEvent.setup();
    const inativo = [{ ...zernioChannels[0], isActive: false, isDefault: false }];
    render(<CloudProviderSection provider="ZERNIO" channels={inativo} role="ADMIN" />);

    await user.click(screen.getByRole('button', { name: /reativar/i }));

    expect(setActiveMutate).toHaveBeenCalledWith({ id: 'z1', active: true });
  });

  /**
   * A tela tem de DIZER o que desativar significa. "Desativar" sozinho é ambíguo
   * — o operador precisa saber que o histórico fica e que o canal só some dos
   * seletores, senão ele não clica (ou clica achando que apaga tudo).
   */
  it('a tela EXPLICA o que desativar faz — histórico fica, canal some dos seletores', () => {
    render(
      <CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />,
    );

    const explicacao = screen.getByTestId('deactivate-explainer').textContent ?? '';
    expect(explicacao).toMatch(/não apaga|nao apaga/i);
    expect(explicacao).toMatch(/hist[óo]rico|conversas/i);
  });

  it('OPERATOR não pode ligar/desligar canal', () => {
    render(
      <CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="OPERATOR" />,
    );

    expect(screen.queryByRole('button', { name: /desativar/i })).not.toBeInTheDocument();
  });
});

/**
 * BROADCAST DO ZERNIO — as duas colunas que decidem se a campanha vira um
 * broadcast NATIVO (aparece no painel do Zernio) ou sai pelo 1-a-1.
 *
 * Até agora só dava para ligá-las com SQL direto em PRODUÇÃO. O operador precisa
 * disso hoje.
 *
 * O TEXTO É A PARTE CRÍTICA. O broadcast do Zernio NÃO PERSONALIZA: o
 * `/recipients` só aceita telefones, e as variáveis são resolvidas contra o CRM
 * DELES (onde o contato auto-criado nasce sem nome). Uma campanha cujo template
 * usa variável de CAMPO cai automaticamente no 1-a-1, mesmo com a flag ligada.
 * Se a tela não disser isso, o operador liga, dispara, e não entende por que nada
 * apareceu no painel do Zernio.
 */
describe('CloudProviderSection — broadcast do Zernio', () => {
  beforeEach(() => setActiveMutate.mockReset());

  it('liga o broadcast pelo MESMO endpoint do ativar/desativar', async () => {
    const user = userEvent.setup();
    render(
      <CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />,
    );

    await user.click(screen.getByRole('button', { name: /ligar broadcast/i }));

    expect(setActiveMutate).toHaveBeenCalledWith({
      id: 'z1',
      zernioBroadcastEnabled: true,
    });
  });

  it('grava os destinatários por requisição', async () => {
    const user = userEvent.setup();
    const ligado = [{ ...zernioChannels[0], zernioBroadcastEnabled: true }];
    render(<CloudProviderSection provider="ZERNIO" channels={ligado} role="ADMIN" />);

    const chunk = screen.getByTestId('broadcast-chunk');
    await user.clear(chunk);
    await user.type(chunk, '80');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    expect(setActiveMutate).toHaveBeenCalledWith({
      id: 'z1',
      zernioBroadcastChunk: 80,
    });
  });

  it('a tela DIZ que o broadcast não personaliza e cai no 1-a-1', () => {
    render(
      <CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="ADMIN" />,
    );

    const texto = screen.getByTestId('broadcast-explainer').textContent ?? '';
    expect(texto).toMatch(/painel do zernio/i);
    expect(texto).toMatch(/não personaliza|nao personaliza/i);
    expect(texto).toMatch(/1-a-1|um a um/i);
    expect(texto).toMatch(/vari[áa]vel/i);
  });

  it('canal TWILIO não mostra broadcast — é capacidade do Zernio', () => {
    render(<CloudProviderSection provider="TWILIO" channels={channels} role="ADMIN" />);

    expect(screen.queryByTestId('broadcast-explainer')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /ligar broadcast/i }),
    ).not.toBeInTheDocument();
  });

  it('OPERATOR não configura broadcast', () => {
    render(
      <CloudProviderSection provider="ZERNIO" channels={zernioChannels} role="OPERATOR" />,
    );

    expect(
      screen.queryByRole('button', { name: /ligar broadcast/i }),
    ).not.toBeInTheDocument();
  });
});
