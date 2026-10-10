import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const useInternalDashboardMock = vi.fn();
vi.mock('@/features/internal-communications/api', () => ({ useInternalDashboard: () => useInternalDashboardMock() }));

import { InternalDashboardPage } from '@/features/internal-communications/components/internal-dashboard-page';
import { Route } from './dashboard';

const result = (data?: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
const dashboard = { needsAction: 4, nearDeadline: 2, waitingOthers: 1, unassigned: 3, completedThisWeek: 5, sector: null, priorities: [], recentUpdates: [] };

describe('dashboard interno', () => {
  it('registra a visão geral interna na rota', () => {
    expect((Route as { component: unknown }).component).toBe(InternalDashboardPage);
  });

  it('mostra quatro KPIs reais e os estados vazios de prioridade e feed', () => {
    useInternalDashboardMock.mockReturnValue(result(dashboard));
    render(<InternalDashboardPage />);
    expect(screen.getByTestId('internal-dashboard-kpis').children).toHaveLength(4);
    expect(screen.getByText(/Precisam de ação/)).toBeInTheDocument();
    expect(screen.getAllByText(/Não há/)).toHaveLength(2);
  });

  it('oferece nova tentativa quando a API falha', () => {
    const refetch = vi.fn();
    useInternalDashboardMock.mockReturnValue({ ...result(), isError: true, refetch });
    render(<InternalDashboardPage />);
    screen.getByRole('button', { name: 'Tentar novamente' }).click();
    expect(refetch).toHaveBeenCalledOnce();
  });
});
