import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const previewMutateAsync = vi.fn();
const preflightMutateAsync = vi.fn();
let previewPending = false;

vi.mock('../api', () => ({
  usePreviewCampaign: () => ({
    mutateAsync: previewMutateAsync,
    isPending: previewPending,
  }),
  usePreflightByFilters: () => ({ mutateAsync: preflightMutateAsync }),
}));

import { LivePreview } from './live-preview';
import type { FilterGroup } from '../schemas';

const FILTERS: FilterGroup = {
  combinator: 'and',
  rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
};

beforeEach(() => {
  previewMutateAsync.mockReset();
  preflightMutateAsync.mockReset();
  previewPending = false;
});

describe('LivePreview — error state', () => {
  it('renders an inline error when the preview request fails', async () => {
    previewMutateAsync.mockRejectedValue(new Error('400 invalid filter'));
    preflightMutateAsync.mockRejectedValue(new Error('400 invalid filter'));

    render(<LivePreview filters={FILTERS} />);

    await waitFor(
      () =>
        expect(
          screen.getByText(/não foi possível|inválid|erro/i),
        ).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it('renders the count (no error) on a successful preview', async () => {
    previewMutateAsync.mockResolvedValue({ count: 4, sample: [] });
    preflightMutateAsync.mockResolvedValue({
      total: 4,
      reachable: 4,
      invalid: 0,
      unknown: 0,
    });

    render(<LivePreview filters={FILTERS} />);

    await waitFor(
      () => expect(screen.getAllByText('4').length).toBeGreaterThan(0),
      { timeout: 2000 },
    );
    expect(
      screen.queryByText(/não foi possível/i),
    ).not.toBeInTheDocument();
  });
});

/**
 * O contador da regra "ninguém recebe o mesmo template duas vezes"
 * (spec 2026-08-12). O dono escolheu a regra SEMPRE LIGADA, sem botão de
 * desligar — e em troca a tela tem de dizer o que aconteceu.
 *
 * Sem isto o operador vê 88 onde esperava 500 e não faz ideia do porquê. Foi
 * exatamente esse silêncio (uma recusa sem explicação) que custou a tarde de
 * 2026-08-11 e oito tentativas cegas.
 */
describe('LivePreview — excluídos por já estarem em campanha do mesmo template', () => {
  it('mostra quantos saíram e o motivo', async () => {
    previewMutateAsync.mockResolvedValue({
      count: 88,
      sample: [],
      excludedSameTemplate: 412,
    });
    preflightMutateAsync.mockResolvedValue({
      total: 88,
      reachable: 88,
      invalid: 0,
      unknown: 0,
    });

    render(<LivePreview filters={FILTERS} templateId="tpl-T" />);

    // O bloco inteiro, não o <span> do número: o motivo mora no texto ao redor.
    const aviso = await screen.findByRole('status');
    expect(aviso).toHaveTextContent('412');
    expect(aviso).toHaveTextContent(/mesmo template/i);
  });

  it('não polui a tela quando ninguém foi excluído', async () => {
    previewMutateAsync.mockResolvedValue({
      count: 500,
      sample: [],
      excludedSameTemplate: 0,
    });
    preflightMutateAsync.mockResolvedValue({
      total: 500,
      reachable: 500,
      invalid: 0,
      unknown: 0,
    });

    render(<LivePreview filters={FILTERS} templateId="tpl-T" />);

    await screen.findByText(/contatos selecionados/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('leva o templateId ao backend — sem ele a prévia mentiria', async () => {
    previewMutateAsync.mockResolvedValue({ count: 1, sample: [] });
    preflightMutateAsync.mockResolvedValue({
      total: 1,
      reachable: 1,
      invalid: 0,
      unknown: 0,
    });

    render(<LivePreview filters={FILTERS} templateId="tpl-T" />);

    await waitFor(() =>
      expect(previewMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: 'tpl-T' }),
      ),
    );
  });
});

/**
 * ★ Pedido do cliente 2026-08-25 — "excluir quem já recebeu parece não
 * funcionar": o backend ganhou `excludeAnyPreviousCampaign`
 * (`campaign.schema.ts`), mas nenhuma chamada do frontend o enviava — toda
 * campanha nascia com o campo ausente/false e a correção era inalcançável
 * pelo operador. A prévia tem de levar o MESMO valor que o create vai levar.
 */
describe('LivePreview — excludeAnyPreviousCampaign', () => {
  it('omitido, a prévia vai com excludeAnyPreviousCampaign: false (default conservador)', async () => {
    previewMutateAsync.mockResolvedValue({ count: 1, sample: [] });
    preflightMutateAsync.mockResolvedValue({
      total: 1,
      reachable: 1,
      invalid: 0,
      unknown: 0,
    });

    render(<LivePreview filters={FILTERS} templateId="tpl-T" />);

    await waitFor(() =>
      expect(previewMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ excludeAnyPreviousCampaign: false }),
      ),
    );
  });

  it('ligado, a prévia leva excludeAnyPreviousCampaign: true ao backend', async () => {
    previewMutateAsync.mockResolvedValue({ count: 1, sample: [] });
    preflightMutateAsync.mockResolvedValue({
      total: 1,
      reachable: 1,
      invalid: 0,
      unknown: 0,
    });

    render(
      <LivePreview
        filters={FILTERS}
        templateId="tpl-T"
        excludeAnyPreviousCampaign
      />,
    );

    await waitFor(() =>
      expect(previewMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ excludeAnyPreviousCampaign: true }),
      ),
    );
  });
});

// Fase B, Task 16 (spec A.2/B.4) — a MESMA linha de exclusões ganha o item dos
// inválidos confirmados. `previewMock`/`renderLivePreview` do brief não
// existem neste arquivo: os nomes reais são `previewMutateAsync` /
// `preflightMutateAsync`, e cada teste renderiza `<LivePreview />` direto.
describe('LivePreview — inválidos confirmados excluídos (A.2/B.4)', () => {
  it('mostra a contagem de inválidos excluídos na linha de exclusões', async () => {
    previewMutateAsync.mockResolvedValue({
      count: 13_000,
      sample: [],
      excludedSameTemplate: 300,
      excludedInvalid: 120,
    });
    preflightMutateAsync.mockResolvedValue({
      total: 13_000,
      reachable: 13_000,
      invalid: 0,
      unknown: 0,
    });

    render(<LivePreview filters={FILTERS} />);

    // O componente separa a contagem (num <strong>) do rótulo (texto irmão)
    // — `findByText` só casa texto que seja filho direto do MESMO elemento,
    // então "120" e "inválidos confirmados excluídos" nunca formam uma única
    // string por esse caminho. `toHaveTextContent` olha o texto concatenado
    // do bloco inteiro (mesmo padrão já usado acima para o aviso de "mesmo
    // template", via `toHaveTextContent('412')`).
    const linha = await screen.findByTestId('audience-exclusions');
    expect(linha).toHaveTextContent('120');
    expect(linha).toHaveTextContent(/inválidos confirmados excluídos/i);
  });

  it('zero inválidos não vira uma linha vazia', async () => {
    previewMutateAsync.mockResolvedValue({
      count: 13_000,
      sample: [],
      excludedSameTemplate: 0,
      excludedInvalid: 0,
    });
    preflightMutateAsync.mockResolvedValue({
      total: 13_000,
      reachable: 13_000,
      invalid: 0,
      unknown: 0,
    });

    render(<LivePreview filters={FILTERS} />);

    await screen.findByText(/contatos selecionados/i);
    expect(
      screen.queryByText(/inválidos confirmados excluídos/i),
    ).not.toBeInTheDocument();
  });
});
