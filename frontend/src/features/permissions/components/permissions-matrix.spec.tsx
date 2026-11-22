import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { DEFAULT_PERMISSIONS, PERMISSION_KEYS, type PermissionKey } from '../keys';
import type { PermissionMatrix } from '../schemas';
import { ME_QUERY_KEY } from '../use-session-sync';
import { PermissionsMatrix } from './permissions-matrix';

const { get, put, post } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (path: string) => ({ json: () => get(path) }),
    put: (path: string, options: unknown) => ({ json: () => put(path, options) }),
    post: (path: string, options?: unknown) => ({ json: () => post(path, options) }),
  },
  onPermissionDenied: () => () => undefined,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DEFAULTS = {
  SUPERVISOR: [...DEFAULT_PERMISSIONS.SUPERVISOR],
  OPERATOR: [...DEFAULT_PERMISSIONS.OPERATOR],
};

function matrixWith(operator: PermissionKey[]): PermissionMatrix {
  return {
    keys: [...PERMISSION_KEYS],
    roles: { ADMIN: [...PERMISSION_KEYS], SUPERVISOR: DEFAULTS.SUPERVISOR, OPERATOR: operator, VIEWER: [] },
    defaults: DEFAULTS,
    editableRoles: ['SUPERVISOR', 'OPERATOR'],
  };
}

async function renderMatrix(matrix: PermissionMatrix) {
  get.mockResolvedValue(matrix);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <PermissionsMatrix />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Salvar' });
  return { invalidate, ui: userEvent.setup() };
}

const box = (role: string, name: string) => screen.getByRole('checkbox', { name: `${role}: ${name}` });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PermissionsMatrix: colunas fixas', () => {
  it('Administrador marcado e travado; Leitura desmarcado e travado; as outras com caixa livre', async () => {
    await renderMatrix(matrixWith(DEFAULTS.OPERATOR));

    const admin = screen.getAllByRole('checkbox', { name: /^Administrador:/ });
    const viewer = screen.getAllByRole('checkbox', { name: /^Leitura:/ });
    expect(admin).toHaveLength(PERMISSION_KEYS.length);
    expect(viewer).toHaveLength(PERMISSION_KEYS.length);
    for (const cell of admin) {
      expect(cell).toBeChecked();
      expect(cell).toBeDisabled();
    }
    for (const cell of viewer) {
      expect(cell).not.toBeChecked();
      expect(cell).toBeDisabled();
    }
    expect(box('Supervisor', 'Alterar a escala')).toBeEnabled();
    expect(box('Operador', 'Alterar a escala')).toBeChecked();
    expect(box('Operador', 'Manter setores, turnos e níveis')).not.toBeChecked();
  });

  it('cada linha mostra o nome e a explicação da permissão, nunca a chave', async () => {
    await renderMatrix(matrixWith(DEFAULTS.OPERATOR));

    expect(screen.getByText('Sem esta permissão, aparecem só os 4 últimos dígitos.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('telefone.ver_completo');
    expect(document.body.textContent).not.toContain('OPERATOR');
  });
});

describe('PermissionsMatrix: salvar com confirmação', () => {
  it('marcar e desmarcar abre a confirmação com uma frase por mudança; Cancelar não grava', async () => {
    const { ui } = await renderMatrix(matrixWith(DEFAULTS.OPERATOR));

    await ui.click(box('Supervisor', 'Manter setores, turnos e níveis'));
    await ui.click(box('Operador', 'Alterar a escala'));
    await ui.click(screen.getByRole('button', { name: 'Salvar' }));

    const dialog = await screen.findByRole('dialog', { name: 'Confirmar alterações de permissões' });
    expect(within(dialog).getByText('Supervisor: passa a poder Manter setores, turnos e níveis')).toBeInTheDocument();
    expect(within(dialog).getByText('Operador: deixa de poder Alterar a escala')).toBeInTheDocument();
    await ui.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirmar manda PUT /permissions só com SUPERVISOR e OPERATOR, avisa e relê a sessão', async () => {
    const { ui, invalidate } = await renderMatrix(matrixWith(DEFAULTS.OPERATOR));
    const operator = [...DEFAULTS.OPERATOR, 'trilha.consultar' as const];
    put.mockResolvedValue(matrixWith(operator));

    await ui.click(box('Operador', 'Consultar o histórico das pessoas'));
    await ui.click(screen.getByRole('button', { name: 'Salvar' }));
    await ui.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Permissões salvas'));
    expect(put).toHaveBeenCalledWith('permissions', { json: { roles: { SUPERVISOR: DEFAULTS.SUPERVISOR, OPERATOR: operator } } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ME_QUERY_KEY });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('erro do servidor aparece no toast e o diálogo continua aberto', async () => {
    const { ui } = await renderMatrix(matrixWith(DEFAULTS.OPERATOR));
    const detail = 'Sua sessão não pode alterar permissões agora.';
    const response = new Response(JSON.stringify({ code: 'x', detail }), { status: 422 });
    put.mockRejectedValue(new HTTPError(response, new Request('https://x'), {} as never));

    await ui.click(box('Operador', 'Alterar a escala'));
    await ui.click(screen.getByRole('button', { name: 'Salvar' }));
    await ui.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.any(String), { description: detail }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('PermissionsMatrix: restaurar padrão', () => {
  it('com a matriz já no padrão o botão fica desabilitado', async () => {
    await renderMatrix(matrixWith(DEFAULTS.OPERATOR));

    expect(screen.getByRole('button', { name: 'Restaurar padrão' })).toBeDisabled();
  });

  it('abre a confirmação com as diferenças para o padrão e confirmar chama POST restore-defaults', async () => {
    const { ui, invalidate } = await renderMatrix(matrixWith(['pessoas.editar']));
    post.mockResolvedValue(matrixWith(DEFAULTS.OPERATOR));

    await ui.click(screen.getByRole('button', { name: 'Restaurar padrão' }));

    const dialog = await screen.findByRole('dialog', { name: 'Confirmar alterações de permissões' });
    expect(within(dialog).getByText('Operador: passa a poder Alterar a escala')).toBeInTheDocument();
    await ui.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('permissions/restore-defaults', undefined));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ME_QUERY_KEY });
    await waitFor(() => expect(box('Operador', 'Alterar a escala')).toBeChecked());
    expect(toast.success).toHaveBeenCalledWith('Permissões restauradas ao padrão');
  });
});

describe('PermissionsMatrix: leitura inválida', () => {
  it('chave desconhecida na resposta mostra o erro em português, não o JSON do Zod', async () => {
    get.mockResolvedValue({ ...matrixWith([]), keys: [...PERMISSION_KEYS, 'chave.desconhecida'] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PermissionsMatrix />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Não foi possível ler as permissões. Atualize a página.')).toBeInTheDocument();
  });
});
