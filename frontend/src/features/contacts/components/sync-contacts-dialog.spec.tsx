import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPError } from 'ky';

const syncMutate = vi.fn();
const useContactsMock = vi.fn();
const useSyncProgressMock = vi.fn();

vi.mock('../api', () => ({
  useSyncContacts: () => ({ mutateAsync: syncMutate, isPending: false }),
  useContacts: (q: unknown, options: unknown) => useContactsMock(q, options),
  // Achado 3 (revisão) — o tipo aqui era `(since: string | null) => …`, mas o
  // hook real recebe UM objeto `{since, total, enabled}`. Estava "certo" só
  // porque o mock repassa o argumento cru pro spy sem checar o formato — o
  // parâmetro chamava-se `since` mas carregava o objeto inteiro.
  useSyncProgress: (args: {
    since: string | null;
    total: number;
    enabled: boolean;
  }) => useSyncProgressMock(args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from 'sonner';
import {
  SyncContactsDialog,
  estimateHours,
} from './sync-contacts-dialog';

/** Same shape as `frontend/src/lib/api-error.spec.ts` — a real ky `HTTPError`
 * whose response body is the ProblemDetails the backend actually sends for
 * T11/T12's three click-time refusals. */
function makeKyError(status: number, body: unknown): HTTPError {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  return new HTTPError(
    response as never,
    new Request('http://localhost/x') as never,
    {} as never,
  );
}

describe('estimateHours', () => {
  it('2400 contatos a 40/min ≈ 1h', () => {
    expect(estimateHours(2_400)).toBe(1);
  });

  it('13.400 contatos a 40/min ≈ 6h (arredonda para cima)', () => {
    expect(estimateHours(13_400)).toBe(6);
  });

  // Nunca "≈ 0h": qualquer trabalho pendente é pelo menos "cerca de 1 hora".
  it('poucos contatos ainda mostram 1h, nunca 0', () => {
    expect(estimateHours(5)).toBe(1);
  });

  it('zero é zero', () => {
    expect(estimateHours(0)).toBe(0);
  });
});

describe('SyncContactsDialog', () => {
  beforeEach(() => {
    syncMutate.mockReset();
    syncMutate.mockResolvedValue({
      enqueued: 48,
      total: 2_400,
      mode: 'unvalidated',
      startedAt: '2026-08-24T12:00:00.000Z',
    });
    useContactsMock.mockReset();
    useContactsMock.mockReturnValue({
      data: { items: [], total: 2_400, page: 1, pageSize: 1 },
    });
    useSyncProgressMock.mockReset();
    useSyncProgressMock.mockReturnValue({ data: undefined });
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  function open() {
    return render(
      <SyncContactsDialog open onOpenChange={() => {}} />,
    );
  }

  it('pergunta a contagem de NÃO VALIDADOS ao backend, não uma lista inteira', () => {
    open();
    expect(useContactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ validity: 'unvalidated', pageSize: 1 }),
      expect.objectContaining({ enabled: true }),
    );
  });

  // Achado 3 (revisão) — o diálogo fica SEMPRE montado (o `open` do Radix só
  // o esconde visualmente), então sem `enabled: open` esta consulta disparava
  // a cada carregamento da tela de contatos, mesmo fechado.
  it('diálogo fechado: não pergunta a contagem de não validados (enabled: false)', () => {
    render(<SyncContactsDialog open={false} onOpenChange={() => {}} />);
    expect(useContactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ validity: 'unvalidated' }),
      expect.objectContaining({ enabled: false }),
    );
  });

  /**
   * ★ O AVISO DE RISCO, com o TEXTO EXATO DA SPEC. O risco é do CLIENTE (o
   * número dele pode ser bloqueado) e por isso está na tela, não num comentário
   * de código.
   */
  it('mostra o aviso de risco com ritmo, horário e estimativa', () => {
    open();
    const aviso = screen.getByTestId('sync-risk-warning');
    expect(aviso).toHaveTextContent(
      /Consultas de existência em massa por número não-oficial são um sinal conhecido de bloqueio\./,
    );
    expect(aviso).toHaveTextContent(/Ritmo lento: ~40\/min, só em horário comercial\./);
    expect(aviso).toHaveTextContent(/Estimativa: 2\.400 contatos ≈ 1h\./);
  });

  /**
   * ★ Crítico 1 (revisão) — o ritmo de ~40/min roda num ÚNICO worker e pode
   * facilmente passar da janela de envio de 12h do canal. Sem este aviso o
   * operador dispara uma validação grande sem saber que ela pode não acabar
   * no mesmo dia — e sem saber que isso é INOFENSIVO (os lotes ainda na fila
   * quando a janela fecha falham de forma limpa, nada se perde, e basta
   * clicar em "Validar não validados" de novo no dia seguinte).
   */
  it('avisa que uma validação grande pode passar da janela de 12h, sem perder nada', () => {
    open();
    const aviso = screen.getByTestId('sync-window-warning');
    expect(aviso).toHaveTextContent(/12h/);
    expect(aviso).toHaveTextContent(
      /Validar não validados/,
    );
  });

  it('o botão principal traz a contagem de não validados', () => {
    open();
    expect(
      screen.getByRole('button', { name: /Validar não validados \(2\.400\)/ }),
    ).toBeInTheDocument();
  });

  it('sem ninguém para validar, o botão fica desabilitado', () => {
    useContactsMock.mockReturnValue({
      data: { items: [], total: 0, page: 1, pageSize: 1 },
    });
    open();
    expect(
      screen.getByRole('button', { name: /Validar não validados \(0\)/ }),
    ).toBeDisabled();
  });

  it('disparar chama a API no modo unvalidated', async () => {
    open();
    await userEvent.click(
      screen.getByRole('button', { name: /Validar não validados \(2\.400\)/ }),
    );
    expect(syncMutate).toHaveBeenCalledWith('unvalidated');
  });

  it('depois de disparar, a barra de progresso aparece e usa o marco devolvido', async () => {
    useSyncProgressMock.mockReturnValue({
      data: { checked: 600, unvalidated: 1_800 },
    });
    open();
    await userEvent.click(
      screen.getByRole('button', { name: /Validar não validados \(2\.400\)/ }),
    );
    expect(useSyncProgressMock).toHaveBeenCalledWith(
      expect.objectContaining({
        since: '2026-08-24T12:00:00.000Z',
        enabled: true,
      }),
    );
    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '600');
    expect(bar).toHaveAttribute('aria-valuemax', '2400');
    expect(screen.getByTestId('sync-progress-label')).toHaveTextContent(
      /600 de 2\.400/,
    );
  });

  /**
   * ★ Crítico 2 (revisão) — o DENOMINADOR da barra é o `total` que o POST
   * devolveu (o tamanho REAL do lote que o back selecionou e vai processar),
   * não o `total` ao vivo da lista de não validados. A lista pode encolher
   * DURANTE a validação (contatos ficam validados/inválidos um a um), e usar
   * esse número como denominador faria a barra ultrapassar 100% ou o "X de Y"
   * mentir sobre quanto falta.
   */
  it('a barra usa o total DA RESPOSTA DO POST, não o total ao vivo da lista (que pode ter encolhido)', async () => {
    syncMutate.mockResolvedValueOnce({
      enqueued: 3,
      total: 120,
      mode: 'unvalidated',
      startedAt: '2026-08-24T12:00:00.000Z',
    });
    // A lista mostra 999 — MAIOR que o total do POST (120). Se a barra usasse
    // este número, "120 de 999" jamais chegaria a 100%.
    useContactsMock.mockReturnValue({
      data: { items: [], total: 999, page: 1, pageSize: 1 },
    });
    useSyncProgressMock.mockReturnValue({
      data: { checked: 30, unvalidated: 90 },
    });
    open();
    await userEvent.click(
      screen.getByRole('button', { name: /Validar não validados \(999\)/ }),
    );
    expect(useSyncProgressMock).toHaveBeenCalledWith(
      expect.objectContaining({ since: '2026-08-24T12:00:00.000Z', total: 120 }),
    );
    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemax', '120');
    expect(screen.getByTestId('sync-progress-label')).toHaveTextContent(
      /30 de 120/,
    );
  });

  it('antes de disparar, não pergunta progresso nenhum', () => {
    open();
    expect(useSyncProgressMock).toHaveBeenCalledWith(
      expect.objectContaining({ since: null, enabled: false }),
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  // "Revalidar tudo" saiu da tela (B.5): revalidar milhares de números que já
  // têm resposta é risco puro sem informação nova. O endpoint ainda aceita
  // `mode: 'all'` para quem precisar chamá-lo à mão, mas o diálogo não
  // oferece mais essa opção.
  it('não oferece mais "Revalidar tudo"', () => {
    open();
    expect(screen.queryByText(/Revalidar tudo/)).not.toBeInTheDocument();
  });

  describe('recusas em tempo de clique (T11/T12)', () => {
    it('409 sem canal capaz: mostra a mensagem PT-BR do backend como veio', async () => {
      syncMutate.mockRejectedValueOnce(
        makeKyError(409, {
          type: 'urn:picoa:error:contact.sync_not_supported',
          title: 'Nenhum canal ativo consegue verificar números no WhatsApp.',
          status: 409,
          code: 'contact.sync_not_supported',
          detail: 'no active default channel supports checkNumbersOnWhatsapp',
        }),
      );
      open();
      await userEvent.click(
        screen.getByRole('button', { name: /Validar não validados \(2\.400\)/ }),
      );
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'Nenhum canal ativo consegue verificar números no WhatsApp.',
          {
            description:
              'no active default channel supports checkNumbersOnWhatsapp',
          },
        ),
      );
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('409 canal offline: mostra a mensagem PT-BR do backend como veio', async () => {
      syncMutate.mockRejectedValueOnce(
        makeKyError(409, {
          type: 'urn:picoa:error:contact.sync_channel_offline',
          title:
            'O canal (id chan_abc123) está desconectado. A validação de números só roda com o canal online — reconecte o QR e peça de novo.',
          status: 409,
          code: 'contact.sync_channel_offline',
        }),
      );
      open();
      await userEvent.click(
        screen.getByRole('button', { name: /Validar não validados \(2\.400\)/ }),
      );
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'O canal (id chan_abc123) está desconectado. A validação de números só roda com o canal online — reconecte o QR e peça de novo.',
          { description: expect.any(String) },
        ),
      );
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('409 fora da janela de envio: mostra a mensagem PT-BR do backend como veio', async () => {
      syncMutate.mockRejectedValueOnce(
        makeKyError(409, {
          type: 'urn:picoa:error:contact.sync_outside_window',
          title:
            'Fora da janela de envio do canal (09h–18h). A validação de números respeita o mesmo horário do disparo: consulta em massa fora do expediente é um sinal de robô.',
          status: 409,
          code: 'contact.sync_outside_window',
        }),
      );
      open();
      await userEvent.click(
        screen.getByRole('button', { name: /Validar não validados \(2\.400\)/ }),
      );
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'Fora da janela de envio do canal (09h–18h). A validação de números respeita o mesmo horário do disparo: consulta em massa fora do expediente é um sinal de robô.',
          { description: expect.any(String) },
        ),
      );
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });
});
