import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Organization } from '@/features/organization/api';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
    useSearch: () => ({ purposeKey: 'convite_atividades' }),
  }),
}));

const usePublicConsentTextMock = vi.fn();
const usePublicOptInMock = vi.fn();
vi.mock('@/features/consent/public-optin', async (orig) => ({
  ...(await orig<typeof import('@/features/consent/public-optin')>()),
  usePublicConsentText: () => usePublicConsentTextMock(),
  usePublicOptIn: () => usePublicOptInMock(),
}));

const usePublicOrganizationMock = vi.fn();
vi.mock('@/features/organization/api', async (orig) => ({
  ...(await orig<typeof import('@/features/organization/api')>()),
  usePublicOrganization: () => usePublicOrganizationMock(),
}));

import { Route } from './opt-in';

const OptInPage = (Route as unknown as { component: React.ComponentType })
  .component;

const ORG: Organization = {
  id: 'singleton',
  name: 'CONTINUUM',
  legalName: 'Canal do Matheus Garcia - CONTINUUM',
  privacyPolicyUrl: null,
  supportContact: null,
};

const TEXT = {
  purposeKey: 'convite_atividades',
  purposeLabel: 'Convites para eventos, cursos e atividades',
  version: 'optin-continuum-v1',
  body:
    'Autorizo CONTINUUM (Canal do Matheus Garcia - CONTINUUM) a me enviar mensagens no WhatsApp sobre convites para eventos, cursos e atividades.\n' +
    'São no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.',
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

/**
 * A landing é a página que colhe consentimento de gente real. O nome que ela
 * exibe TEM de ser o da organização deste deploy — a Meta exige que o opt-in
 * nomeie o negócio, e um titular autorizando o nome de outra organização produz
 * um consentimento inválido.
 */
describe('/opt-in — landing pública', () => {
  beforeEach(() => {
    usePublicOrganizationMock.mockReturnValue({ data: ORG, isLoading: false });
    usePublicOptInMock.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
    usePublicConsentTextMock.mockReturnValue({
      data: TEXT,
      isLoading: false,
      isError: false,
    });
  });

  it('renderiza o nome CONFIGURADO da organização — nunca uma constante de código', () => {
    wrap(<OptInPage />);

    expect(screen.getByText('CONTINUUM')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Receber mensagens de CONTINUUM/i }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/idasam/i);
  });

  it('a razão social por extenso aparece no rodapé (quem é o controlador)', () => {
    wrap(<OptInPage />);

    expect(
      screen.getByText('Canal do Matheus Garcia - CONTINUUM'),
    ).toBeInTheDocument();
  });

  it('exibe o corpo do ConsentText VERSIONADO servido pelo backend, não copy do React', () => {
    wrap(<OptInPage />);

    expect(
      screen.getByText(/Autorizo CONTINUUM .* a me enviar mensagens no WhatsApp/i),
    ).toBeInTheDocument();
  });

  it('na tela de erro, manda procurar a equipe da organização configurada', () => {
    usePublicConsentTextMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    wrap(<OptInPage />);

    expect(screen.getByText(/Link indisponível/i)).toBeInTheDocument();
    expect(document.body.textContent).toContain('CONTINUUM');
    expect(document.body.textContent).not.toMatch(/idasam/i);
  });

  it('enquanto a organização não carregou, não inventa nome nenhum', () => {
    usePublicOrganizationMock.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    wrap(<OptInPage />);

    // Sem nome, nada de placeholder mentiroso: a tela não nomeia organização
    // alguma até saber qual é.
    expect(document.body.textContent).not.toMatch(/idasam/i);
  });

  it('mantém as cores nativas da nova marca no cabeçalho', () => {
    wrap(<OptInPage />);

    const logo = document.querySelector('header img');
    expect(logo).toHaveClass('size-6');
    expect(logo?.className).not.toMatch(/brightness-0|invert/);
  });
});
