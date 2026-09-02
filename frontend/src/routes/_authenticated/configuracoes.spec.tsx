import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Organization } from '@/features/organization/api';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
  }),
  redirect: (opts: unknown) => opts,
}));

const useOrganizationMock = vi.fn();
const updateMutateAsync = vi.fn();
vi.mock('@/features/organization/api', async (orig) => ({
  ...(await orig<typeof import('@/features/organization/api')>()),
  useOrganization: () => useOrganizationMock(),
  useUpdateOrganization: () => ({
    mutateAsync: updateMutateAsync,
    isPending: false,
  }),
}));

import { Route } from './configuracoes';

const ConfiguracoesPage = (
  Route as unknown as { component: React.ComponentType }
).component;

const ORG: Organization = {
  id: 'singleton',
  name: 'CONTINUUM',
  legalName: 'Canal do Matheus Garcia - CONTINUUM',
  privacyPolicyUrl: null,
  supportContact: null,
};

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

describe('/configuracoes — identidade da organização', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMutateAsync.mockResolvedValue(ORG);
    useOrganizationMock.mockReturnValue({
      data: ORG,
      isLoading: false,
      isError: false,
    });
  });

  it('carrega a identidade configurada no formulário', () => {
    wrap(<ConfiguracoesPage />);

    expect(screen.getByLabelText(/Nome curto/i)).toHaveValue('CONTINUUM');
    expect(screen.getByLabelText(/Razão social/i)).toHaveValue(
      'Canal do Matheus Garcia - CONTINUUM',
    );
  });

  it('persiste a identidade nova', async () => {
    const user = userEvent.setup();
    wrap(<ConfiguracoesPage />);

    const legalName = screen.getByLabelText(/Razão social/i);
    await user.clear(legalName);
    await user.type(legalName, 'Matheus Garcia Comunicação LTDA');
    await user.click(screen.getByRole('button', { name: /Salvar/i }));

    await waitFor(() =>
      expect(updateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'CONTINUUM',
          legalName: 'Matheus Garcia Comunicação LTDA',
        }),
      ),
    );
  });

  it('não salva sem nome nem razão social — um consentimento sem organização nomeada é inválido', async () => {
    const user = userEvent.setup();
    wrap(<ConfiguracoesPage />);

    await user.clear(screen.getByLabelText(/Nome curto/i));
    await user.click(screen.getByRole('button', { name: /Salvar/i }));

    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it('avisa que trocar o nome NÃO reescreve consentimento já colhido', () => {
    wrap(<ConfiguracoesPage />);

    // O operador precisa saber que publicar uma nova versão do texto é um passo
    // separado — senão ele troca o nome e segue colhendo sob o texto antigo.
    expect(document.body.textContent).toMatch(/nova versão do texto/i);
  });
});
