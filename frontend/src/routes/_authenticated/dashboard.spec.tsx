import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CampaignSummary } from '@/features/campaigns/schemas';
import type { DashboardMetrics } from '@/features/dashboard/api';

// --- Router mock ----------------------------------------------------------
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
  }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

// --- LiveFlow is mocked: it spins timers / random particles we don't want ---
vi.mock('@/components/live-flow', () => ({
  LiveFlow: ({ counts }: { counts: Record<string, number> }) => (
    <div data-testid="live-flow">{JSON.stringify(counts)}</div>
  ),
}));

// --- Feature API mocks ----------------------------------------------------
const useDashboardMetricsMock = vi.fn();
const useCampaignsMock = vi.fn();
vi.mock('@/features/dashboard/api', () => ({
  useDashboardMetrics: () => useDashboardMetricsMock(),
}));
vi.mock('@/features/campaigns/api', () => ({
  useCampaigns: () => useCampaignsMock(),
}));

import { Route } from './dashboard';

const DashboardPage = (Route as unknown as { component: React.ComponentType })
  .component;

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}

function metricBlock(count: number, meta = '', sparkline: number[] = []) {
  return { count, meta, sparkline };
}

function makeMetrics(over: Partial<DashboardMetrics> = {}): DashboardMetrics {
  return {
    activeCampaigns: metricBlock(0),
    activeContacts: metricBlock(0),
    approvedTemplates: metricBlock(0),
    deliveryRate7d: metricBlock(0),
    liveFlow: { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0 },
    ...over,
  };
}

function makeCampaign(over: Partial<CampaignSummary>): CampaignSummary {
  return {
    id: 'c1',
    name: 'Campanha',
    templateId: 'tpl1',
    template: { metaName: 'tpl', language: 'pt_BR' },
    totalRecipients: 0,
    status: 'DRAFT',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    statusCounts: [],
    ...over,
  };
}

function queryResult<T>(over: Partial<Record<string, unknown>> & { data?: T }) {
  return {
    data: undefined,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  useDashboardMetricsMock.mockReset();
  useCampaignsMock.mockReset();
});

describe('DashboardPage — KPIs', () => {
  it('uses the compact KPI treatment with a single orange accent', () => {
    useDashboardMetricsMock.mockReturnValue(queryResult({ data: makeMetrics() }));
    useCampaignsMock.mockReturnValue(queryResult({ data: [] }));

    wrap(<DashboardPage />);

    const kpis = screen.getByTestId('dashboard-kpis');
    expect(kpis).toHaveClass('grid-cols-2', 'gap-3');
    expect(kpis.firstElementChild).toHaveAttribute(
      'style',
      expect.stringContaining('border-top: 3px solid var(--brand-orange)'),
    );
  });

  it('hides sparklines below the small breakpoint to keep mobile KPI labels legible', () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({
        data: makeMetrics({
          activeCampaigns: metricBlock(7, '3 agendadas', [1, 2, 3]),
        }),
      }),
    );
    useCampaignsMock.mockReturnValue(queryResult({ data: [] }));

    wrap(<DashboardPage />);

    expect(screen.getByTestId('kpi-sparkline')).toHaveClass('hidden', 'sm:block');
  });

  it('renders KPI counts and the % suffix on delivery rate', () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({
        data: makeMetrics({
          activeCampaigns: metricBlock(7, '3 agendadas'),
          activeContacts: metricBlock(1280, '+12 hoje'),
          approvedTemplates: metricBlock(15, '2 pendentes'),
          deliveryRate7d: metricBlock(94, 'média semanal'),
        }),
      }),
    );
    useCampaignsMock.mockReturnValue(queryResult({ data: [] }));

    wrap(<DashboardPage />);

    expect(screen.getByText('Campanhas em curso')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('1280')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('94')).toBeInTheDocument();
    // The % suffix is rendered only on the delivery-rate KPI.
    expect(screen.getByText('%')).toBeInTheDocument();
    // Metas are surfaced.
    expect(screen.getByText('3 agendadas')).toBeInTheDocument();
    expect(screen.getByText('média semanal')).toBeInTheDocument();
  });

  it('falls back to 0 for every KPI when metrics data is undefined', () => {
    useDashboardMetricsMock.mockReturnValue(queryResult({ data: undefined }));
    useCampaignsMock.mockReturnValue(queryResult({ data: undefined }));

    wrap(<DashboardPage />);

    // 4 KPIs all show "0" + the LiveFlow gets the zero counts fallback.
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(4);
    // Header summary: "0 campanhas registradas · 0 em curso."
    expect(
      screen.getByText(/0 campanhas registradas/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/0 em curso/i)).toBeInTheDocument();
    // LiveFlow receives the all-zero fallback object.
    expect(screen.getByTestId('live-flow')).toHaveTextContent(
      '{"queued":0,"sent":0,"delivered":0,"read":0,"failed":0}',
    );
  });

  it('summarizes registered/in-progress campaign counts in the header', () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({ data: makeMetrics({ activeCampaigns: metricBlock(2) }) }),
    );
    useCampaignsMock.mockReturnValue(
      queryResult({
        data: [makeCampaign({ id: 'a' }), makeCampaign({ id: 'b' }), makeCampaign({ id: 'c' })],
      }),
    );

    wrap(<DashboardPage />);

    expect(screen.getByText(/3 campanhas registradas/i)).toBeInTheDocument();
    expect(screen.getByText(/2 em curso/i)).toBeInTheDocument();
  });

  it('forwards liveFlow counts to LiveFlow when present', () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({
        data: makeMetrics({
          liveFlow: { queued: 1, sent: 2, delivered: 3, read: 4, failed: 5 },
        }),
      }),
    );
    useCampaignsMock.mockReturnValue(queryResult({ data: [] }));

    wrap(<DashboardPage />);

    expect(screen.getByTestId('live-flow')).toHaveTextContent(
      '{"queued":1,"sent":2,"delivered":3,"read":4,"failed":5}',
    );
  });
});

describe('DashboardPage — recent campaign rows', () => {
  it('computes delivered/read percentages and shows the status label', () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({ data: makeMetrics() }),
    );
    useCampaignsMock.mockReturnValue(
      queryResult({
        data: [
          makeCampaign({
            id: 'r1',
            name: 'Campanha Alfa',
            totalRecipients: 200,
            status: 'RUNNING',
            statusCounts: [
              { status: 'DELIVERED', _count: 80 },
              { status: 'READ', _count: 20 },
            ],
          }),
        ],
      }),
    );

    wrap(<DashboardPage />);

    // delivered = (80 + 20) / 200 = 50% ; read = 20 / 200 = 10%
    expect(
      screen.getByText(/50% entregue/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/10% lida/i)).toBeInTheDocument();
    // Recipients line.
    expect(screen.getByText(/200 destinat/i)).toBeInTheDocument();
    // Status label maps RUNNING -> "Em curso".
    expect(screen.getByText('Em curso')).toBeInTheDocument();
  });

  it('treats totalRecipients of 0 as denominator 1 (no divide-by-zero) -> 0%', () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({ data: makeMetrics() }),
    );
    useCampaignsMock.mockReturnValue(
      queryResult({
        data: [
          makeCampaign({
            id: 'r0',
            name: 'Campanha Vazia',
            totalRecipients: 0,
            statusCounts: [],
          }),
        ],
      }),
    );

    wrap(<DashboardPage />);

    expect(screen.getByText(/0% entregue/i)).toBeInTheDocument();
    expect(screen.getByText(/0% lida/i)).toBeInTheDocument();
  });

  it('falls back to the raw status value when not in the label map', () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({ data: makeMetrics() }),
    );
    useCampaignsMock.mockReturnValue(
      queryResult({
        data: [
          makeCampaign({
            id: 'rX',
            name: 'Campanha Estranha',
            // cast: deliberately an unmapped status to lock the ?? fallback.
            status: 'WEIRD_STATUS' as CampaignSummary['status'],
          }),
        ],
      }),
    );

    wrap(<DashboardPage />);

    expect(screen.getByText('WEIRD_STATUS')).toBeInTheDocument();
  });

  it('caps the delivered progress bar width at 100%', () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({ data: makeMetrics() }),
    );
    useCampaignsMock.mockReturnValue(
      queryResult({
        data: [
          makeCampaign({
            id: 'rOver',
            name: 'Campanha Over',
            totalRecipients: 10,
            // delivered count exceeds total -> ratio > 1, width must clamp.
            statusCounts: [
              { status: 'DELIVERED', _count: 30 },
              { status: 'READ', _count: 5 },
            ],
          }),
        ],
      }),
    );

    const { container } = wrap(<DashboardPage />);

    // The progress fill uses the dashboard's orange accent and carries an inline width.
    const fill = Array.from(
      container.querySelectorAll<HTMLElement>('[style*="brand-orange"]'),
    ).find((el) => el.style.width !== '');
    expect(fill).toBeDefined();
    expect(fill!.style.width).toBe('100%');
    // (30 + 5) / 10 = 350% entregue, but the bar caps at 100%.
    expect(screen.getByText(/350% entregue/i)).toBeInTheDocument();
  });

  it('renders the empty state when there are no campaigns', () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({ data: makeMetrics() }),
    );
    useCampaignsMock.mockReturnValue(queryResult({ data: [] }));

    wrap(<DashboardPage />);

    expect(
      screen.getByText(/Nenhuma campanha ainda/i),
    ).toBeInTheDocument();
  });

  it('limits the recent list to the first 5 campaigns', () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({ data: makeMetrics() }),
    );
    useCampaignsMock.mockReturnValue(
      queryResult({
        data: Array.from({ length: 8 }, (_, i) =>
          makeCampaign({ id: `c${i}`, name: `Campanha ${i}` }),
        ),
      }),
    );

    wrap(<DashboardPage />);

    expect(screen.getByText('Campanha 0')).toBeInTheDocument();
    expect(screen.getByText('Campanha 4')).toBeInTheDocument();
    expect(screen.queryByText('Campanha 5')).not.toBeInTheDocument();
  });
});

describe('DashboardPage — error guards', () => {
  it('renders the metrics error fallback when metrics.isError', async () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({ isError: true, error: new Error('metrics boom') }),
    );
    useCampaignsMock.mockReturnValue(queryResult({ data: [] }));

    wrap(<DashboardPage />);

    expect(
      await screen.findByRole('button', { name: /tentar novamente/i }),
    ).toBeInTheDocument();
    // KPI labels must NOT render in the error state.
    expect(screen.queryByText('Campanhas em curso')).not.toBeInTheDocument();
  });

  it('renders the campaigns error fallback when campaigns.isError (and metrics ok)', async () => {
    useDashboardMetricsMock.mockReturnValue(
      queryResult({ data: makeMetrics() }),
    );
    useCampaignsMock.mockReturnValue(
      queryResult({ isError: true, error: new Error('campaigns boom') }),
    );

    wrap(<DashboardPage />);

    expect(
      await screen.findByRole('button', { name: /tentar novamente/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Campanhas em curso')).not.toBeInTheDocument();
  });
});
