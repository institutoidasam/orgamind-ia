import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConsentOverview } from '@/features/consent/overview';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({ ...opts }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const useConsentOverviewMock = vi.fn();
const useClassifyBaseMock = vi.fn();
vi.mock('@/features/consent/overview', async (orig) => ({
  ...(await orig<typeof import('@/features/consent/overview')>()),
  useConsentOverview: () => useConsentOverviewMock(),
  useClassifyBase: () => useClassifyBaseMock(),
}));

import { Route } from './consentimento';

const OptInPage = (Route as unknown as { component: React.ComponentType }).component;

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

const OVERVIEW: ConsentOverview = {
  total: 13000,
  podemReceberHoje: 87,
  semConsentimento: 12913,
  suprimidos: 41,
  suprimidosNaSemana: 6,
  porFinalidade: [
    {
      purposeKey: 'convite_atividades',
      label: 'Convites para cursos, oficinas e eventos',
      granted: 80,
      pctBase: 0.6,
    },
    {
      purposeKey: 'captacao_recursos',
      label: 'Campanhas de doação e apoio',
      granted: 7,
      pctBase: 0.1,
    },
  ],
  porFonte: [
    { source: 'WA_LINK', granted: 50 },
    { source: 'WEB_FORM', granted: 25 },
    { source: 'PAPER_FORM', granted: 12 },
  ],
  funil: [
    {
      token: 'FEIRA-MANAUS-2026',
      description: 'Cartaz da feira',
      purposeKey: 'convite_atividades',
      active: true,
      inbounds: 300,
      grants: 12,
      conversao: 4,
    },
  ],
  coortes: {
    INTERAGIU: 1200,
    DOCUMENTADA_COM_DECLARACAO: 3400,
    DOCUMENTADA_SEM_DECLARACAO: 2100,
    DESCONHECIDA: 5800,
    INVALIDO_NAO_WHATSAPP: 500,
    NAO_CLASSIFICADO: 0,
  },
  inutilizaveis: 5800,
  semChecagemWhatsapp: 9000,
  auditadoEm: new Date('2026-07-11T09:00:00Z'),
};

describe('Painel de opt-in (spec §7)', () => {
  beforeEach(() => {
    useConsentOverviewMock.mockReturnValue({
      data: OVERVIEW,
      isLoading: false,
      isError: false,
    });
    useClassifyBaseMock.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  });

  it('mostra o número que importa: "X de 13.000 podem receber campanha hoje"', () => {
    wrap(<OptInPage />);

    const headline = screen.getByTestId('podem-receber-hoje');
    expect(headline).toHaveTextContent('87');
    expect(headline).toHaveTextContent(/de\s+13\.000/);
    expect(headline).toHaveTextContent(/podem receber campanha hoje/i);
  });

  it('mostra quanto da base é INUTILIZÁVEL (sem consentimento e sem procedência)', () => {
    wrap(<OptInPage />);

    const box = screen.getByTestId('inutilizaveis');
    expect(box).toHaveTextContent('5.800');
    expect(box).toHaveTextContent(/sem consentimento e sem procedência/i);
  });

  it('mostra o consentimento por finalidade', () => {
    wrap(<OptInPage />);

    const bloco = screen.getByTestId('por-finalidade');
    expect(bloco).toHaveTextContent('Convites para cursos, oficinas e eventos');
    expect(bloco).toHaveTextContent('80');
    expect(bloco).toHaveTextContent('Campanhas de doação e apoio');
  });

  it('mostra a quebra por fonte de consentimento em português', () => {
    wrap(<OptInPage />);

    const bloco = screen.getByTestId('por-fonte');
    expect(bloco).toHaveTextContent('Link wa.me');
    expect(bloco).toHaveTextContent('Landing page');
    expect(bloco).toHaveTextContent('Ficha de papel');
  });

  it('mostra os suprimidos (opt-out) e os novos da semana', () => {
    wrap(<OptInPage />);

    const bloco = screen.getByTestId('suprimidos');
    expect(bloco).toHaveTextContent('41');
    expect(bloco).toHaveTextContent('6');
  });

  it('mostra o funil por token de origem — inbounds x GRANTs x conversão', () => {
    wrap(<OptInPage />);

    const linha = screen.getByTestId('funil-FEIRA-MANAUS-2026');
    expect(linha).toHaveTextContent('300');
    expect(linha).toHaveTextContent('12');
    expect(linha).toHaveTextContent('4%');
  });

  it('mostra a auditoria das coortes com os rótulos C1–C5', () => {
    wrap(<OptInPage />);

    const bloco = screen.getByTestId('coortes');
    expect(bloco).toHaveTextContent(/C1/);
    expect(bloco).toHaveTextContent('1.200');
    expect(bloco).toHaveTextContent(/C4/);
    expect(bloco).toHaveTextContent('5.800');
    expect(bloco).toHaveTextContent(/C5/);
  });

  it('avisa quando a base nunca foi auditada — o painel não finge saber', () => {
    useConsentOverviewMock.mockReturnValue({
      data: {
        ...OVERVIEW,
        auditadoEm: null,
        coortes: { ...OVERVIEW.coortes, NAO_CLASSIFICADO: 13000 },
      },
      isLoading: false,
      isError: false,
    });

    wrap(<OptInPage />);

    expect(screen.getByTestId('coortes')).toHaveTextContent(/nunca (foi )?auditada|não classificad/i);
  });
});
