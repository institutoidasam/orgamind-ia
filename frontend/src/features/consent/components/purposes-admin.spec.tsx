import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminPurpose } from '@/features/consent/admin';
import { PurposesAdmin } from './purposes-admin';

const createMut = { mutateAsync: vi.fn(), isPending: false };
const updateMut = { mutateAsync: vi.fn(), isPending: false };
const deleteMut = { mutateAsync: vi.fn(), isPending: false };
const publishMut = { mutateAsync: vi.fn(), isPending: false };

/**
 * O rascunho que o backend compõe com a identidade CONFIGURADA da organização
 * (`GET /consent/texts/suggested`). `activeTextNamesOrganization: false` é o
 * alarme: o texto que colhe consentimento HOJE nomeia outra organização.
 */
const state: {
  purposes: AdminPurpose[];
  suggested: {
    purposeKey: string;
    version: string;
    body: string;
    activeTextNamesOrganization: boolean;
  };
} = {
  purposes: [],
  suggested: {
    purposeKey: 'continuum_avisos',
    version: 'optin-continuum-v2',
    body: 'Autorizo CONTINUUM (Canal do Matheus Garcia - CONTINUUM) a me enviar mensagens no WhatsApp sobre avisos do continuum.\nSão no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.\nMinha resposta não afeta em nada meu acesso aos projetos e serviços de CONTINUUM.\nPolítica de privacidade: {url}',
    activeTextNamesOrganization: true,
  },
};

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// `importOriginal` de propósito: o preview e o checklist legal são funções PURAS
// do módulo — mocká-las junto com os hooks faria os testes de preview afirmarem
// sobre um dublê, e não sobre o texto que o titular vai ler.
vi.mock('@/features/consent/admin', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/consent/admin')>();
  return {
    ...actual,
    useAdminPurposes: () => ({
      data: state.purposes,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useCreatePurpose: () => createMut,
    useUpdatePurpose: () => updateMut,
    useDeletePurpose: () => deleteMut,
    usePublishConsentText: () => publishMut,
    useSuggestedConsentText: () => ({
      data: state.suggested,
      isLoading: false,
      isError: false,
    }),
  };
});

const CONTINUUM: AdminPurpose = {
  key: 'continuum_avisos',
  label: 'Avisos do CONTINUUM',
  description: 'Comunicados operacionais do programa.',
  isSensitive: false,
  active: true,
  texts: [
    {
      id: 'ct1',
      version: 'optin-continuum-v1',
      body: 'Autorizo o CONTINUUM (Continuum Ltda) a me enviar mensagens no WhatsApp sobre avisos.\nPosso sair respondendo PARAR.',
      activeFrom: new Date('2026-07-01'),
      createdAt: new Date('2026-07-01'),
    },
  ],
  activeText: {
    id: 'ct1',
    version: 'optin-continuum-v1',
    body: 'Autorizo o CONTINUUM (Continuum Ltda) a me enviar mensagens no WhatsApp sobre avisos.\nPosso sair respondendo PARAR.',
    activeFrom: new Date('2026-07-01'),
    createdAt: new Date('2026-07-01'),
  },
  consents: 42,
  events: 50,
  campaigns: 1,
};

const VIRGEM: AdminPurpose = {
  key: 'finalidade_nova',
  label: 'Finalidade nova',
  description: 'Ainda não usada.',
  isSensitive: false,
  active: true,
  texts: [],
  activeText: null,
  consents: 0,
  events: 0,
  campaigns: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.purposes = [CONTINUUM, VIRGEM];
});

describe('PurposesAdmin — lista', () => {
  it('lista as finalidades com a versão vigente do texto', () => {
    render(<PurposesAdmin />);

    expect(screen.getByText('Avisos do CONTINUUM')).toBeInTheDocument();
    expect(screen.getByText('continuum_avisos')).toBeInTheDocument();
    expect(screen.getByText(/optin-continuum-v1/)).toBeInTheDocument();
  });

  it('avisa quando a finalidade não tem texto publicado (não coleta nada)', () => {
    render(<PurposesAdmin />);

    const row = screen.getByTestId('purpose-finalidade_nova');
    expect(within(row).getByText(/sem texto/i)).toBeInTheDocument();
  });

  it('só oferece apagar a finalidade que nunca foi usada — a trilha é prova', () => {
    render(<PurposesAdmin />);

    const emUso = screen.getByTestId('purpose-continuum_avisos');
    expect(within(emUso).queryByRole('button', { name: /apagar/i })).toBeNull();

    const virgem = screen.getByTestId('purpose-finalidade_nova');
    expect(
      within(virgem).getByRole('button', { name: /apagar/i }),
    ).toBeInTheDocument();
  });
});

describe('PurposesAdmin — criar finalidade', () => {
  it('cria a finalidade com key, rótulo e descrição', async () => {
    const user = userEvent.setup();
    render(<PurposesAdmin />);

    await user.click(screen.getByRole('button', { name: /nova finalidade/i }));

    await user.type(screen.getByLabelText(/chave/i), 'continuum_captacao');
    await user.type(screen.getByLabelText(/rótulo/i), 'Captação CONTINUUM');
    await user.type(
      screen.getByLabelText(/descrição/i),
      'Campanhas de apoio do CONTINUUM.',
    );

    await user.click(screen.getByRole('button', { name: /^criar$/i }));

    expect(createMut.mutateAsync).toHaveBeenCalledWith({
      key: 'continuum_captacao',
      label: 'Captação CONTINUUM',
      description: 'Campanhas de apoio do CONTINUUM.',
      isSensitive: false,
      active: true,
    });
  });

  it('não deixa criar sem chave/rótulo/descrição', async () => {
    const user = userEvent.setup();
    render(<PurposesAdmin />);

    await user.click(screen.getByRole('button', { name: /nova finalidade/i }));
    expect(screen.getByRole('button', { name: /^criar$/i })).toBeDisabled();
  });
});

describe('PurposesAdmin — texto de consentimento', () => {
  async function abrirTexto() {
    const user = userEvent.setup();
    render(<PurposesAdmin />);
    const row = screen.getByTestId('purpose-continuum_avisos');
    await user.click(within(row).getByRole('button', { name: /texto/i }));
    return user;
  }

  it('mostra o preview de como o texto aparece na landing e no link wa.me', async () => {
    const user = await abrirTexto();

    // Exato: o título do dialog ("Texto de consentimento — Avisos do
    // CONTINUUM") também rotula o próprio dialog.
    const corpo = screen.getByLabelText('Texto de consentimento');
    await user.clear(corpo);
    await user.type(
      corpo,
      'Autorizo o CONTINUUM (Continuum Ltda) a me enviar mensagens no WhatsApp sobre avisos.',
    );

    // Landing: o corpo inteiro, como o titular o lê ao lado do checkbox.
    const landing = screen.getByTestId('preview-landing');
    expect(landing).toHaveTextContent(
      'Autorizo o CONTINUUM (Continuum Ltda) a me enviar mensagens no WhatsApp sobre avisos.',
    );

    // wa.me: só a DECLARAÇÃO (1ª linha) + o token de origem, URL-encoded.
    const wame = screen.getByTestId('preview-wame');
    expect(wame).toHaveTextContent('https://wa.me/');
    expect(wame).toHaveTextContent('Autorizo%20o%20CONTINUUM');
  });

  it('mostra o checklist legal e NÃO bloqueia a publicação (é aviso, não validação)', async () => {
    const user = await abrirTexto();

    const checklist = screen.getByTestId('checklist-legal');
    expect(within(checklist).getByText(/nomeia a organização/i)).toBeInTheDocument();
    expect(within(checklist).getByText(/como sair/i)).toBeInTheDocument();
    expect(
      within(checklist).getByText(/não prejudica o titular/i),
    ).toBeInTheDocument();

    // Exato: o título do dialog ("Texto de consentimento — Avisos do
    // CONTINUUM") também rotula o próprio dialog.
    const corpo = screen.getByLabelText('Texto de consentimento');
    await user.clear(corpo);
    // Texto propositalmente INCOMPLETO (sem frequência, sem não-retaliação).
    await user.type(corpo, 'Autorizo mensagens.');
    // Versão e corpo já chegam PRÉ-PREENCHIDOS pelo rascunho composto com a
    // organização configurada — o operador reescreve por cima.
    const versao = screen.getByLabelText(/versão/i);
    await user.clear(versao);
    await user.type(versao, 'optin-continuum-v2');

    const publicar = screen.getByRole('button', { name: /publicar/i });
    expect(publicar).toBeEnabled();

    await user.click(publicar);
    expect(publishMut.mutateAsync).toHaveBeenCalledWith({
      purposeKey: 'continuum_avisos',
      version: 'optin-continuum-v2',
      body: 'Autorizo mensagens.',
    });
  });

  it('avisa que publicar cria uma versão NOVA e não altera as anteriores', async () => {
    await abrirTexto();
    expect(
      screen.getByText(/não altera as versões anteriores/i),
    ).toBeInTheDocument();
  });
});

/**
 * O caminho para trocar a organização nomeada num texto de consentimento.
 *
 * Antes, o rascunho trazia um `[NOME DA ORGANIZAÇÃO POR EXTENSO]` que o operador
 * precisava lembrar de substituir — e esquecer disso publica um texto inválido.
 * Hoje o corpo vem composto pelo backend a partir de `Organization`.
 */
describe('PurposesAdmin — a organização dentro do texto', () => {
  async function abrirTexto() {
    const user = userEvent.setup();
    render(<PurposesAdmin />);
    const row = screen.getByTestId('purpose-continuum_avisos');
    await user.click(within(row).getByRole('button', { name: /texto/i }));
    return user;
  }

  it('quando o texto vigente NÃO nomeia a organização, alarma e parte do rascunho composto', async () => {
    state.suggested = {
      ...state.suggested,
      activeTextNamesOrganization: false,
    };

    await abrirTexto();

    expect(screen.getByTestId('aviso-organizacao')).toBeInTheDocument();
    // Partir do texto vigente propagaria a organização errada: o rascunho é o
    // composto, e ele já nomeia a organização configurada.
    expect(screen.getByLabelText('Texto de consentimento')).toHaveValue(
      state.suggested.body,
    );
    expect(screen.getByLabelText(/versão/i)).toHaveValue('optin-continuum-v2');
  });

  it('quando o vigente já nomeia a organização, não alarma e parte do texto que vale hoje', async () => {
    state.suggested = {
      ...state.suggested,
      activeTextNamesOrganization: true,
    };

    await abrirTexto();

    expect(screen.queryByTestId('aviso-organizacao')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Texto de consentimento')).toHaveValue(
      CONTINUUM.activeText!.body,
    );
  });

  it('o rascunho nunca traz um placeholder para o operador esquecer de trocar', async () => {
    state.suggested = {
      ...state.suggested,
      activeTextNamesOrganization: false,
    };

    await abrirTexto();

    const corpo = screen.getByLabelText('Texto de consentimento') as HTMLTextAreaElement;
    expect(corpo.value).not.toMatch(/\[NOME DA ORGANIZAÇÃO/i);
    expect(corpo.value).toContain('CONTINUUM');
  });
});
