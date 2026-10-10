import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { changePasswordSchema } from '@/features/auth/schemas';
import { loginDestinationAfterPasswordChange } from '@/lib/auth-navigation';
import { ChangePasswordPage } from '@/components/auth/change-password-page';

const { extractApiError, mutateAsync, navigate, toastError, toastSuccess } = vi.hoisted(() => ({
  extractApiError: vi.fn(),
  mutateAsync: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: { location: { search: unknown } }) => unknown }) => select({ location: { search: { redirect: '/demandas' } } }),
}));
vi.mock('@/features/auth/api', () => ({ useChangePassword: () => ({ mutateAsync, isPending: false }) }));
vi.mock('@/lib/api-error', () => ({ extractApiError }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function passwordFixture() {
  return crypto.randomUUID();
}

describe('changePasswordSchema', () => {
  it('rejects when newPassword shorter than 8 chars', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword: 'short',
      confirmPassword: 'short',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/8/);
  });

  it('rejects when passwords do not match', () => {
    const newPassword = passwordFixture();
    const confirmPassword = passwordFixture();
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword,
      confirmPassword,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toContain('confirmPassword');
  });

  it('passes with matching passwords >= 8 chars', () => {
    const newPassword = passwordFixture();
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword,
      confirmPassword: newPassword,
    });
    expect(result.success).toBe(true);
  });
});

describe('loginDestinationAfterPasswordChange', () => {
  it('envia o usuário para login e preserva somente um redirect interno', () => {
    expect(loginDestinationAfterPasswordChange('/demandas')).toEqual({
      to: '/login',
      search: { redirect: '/demandas' },
    });
  });

  it('descarta redirect externo antes de navegar para login', () => {
    expect(loginDestinationAfterPasswordChange('//outside.example')).toEqual({
      to: '/login',
      search: { redirect: '/dashboard' },
    });
  });
});

describe('ChangePasswordPage', () => {
  async function submitPasswordForm() {
    const user = userEvent.setup();
    const { container } = render(<ChangePasswordPage />);
    const fields = container.querySelectorAll<HTMLInputElement>('input');
    const currentPassword = crypto.randomUUID();
    const nextPassword = crypto.randomUUID();

    await user.type(fields[0], currentPassword);
    await user.type(fields[1], nextPassword);
    await user.type(fields[2], nextPassword);
    await user.click(container.querySelector('button[type="submit"]')!);
    return { currentPassword, newPassword: nextPassword };
  }

  it('troca a senha, descarta a sessão via mutação e navega para novo login', async () => {
    mutateAsync.mockResolvedValue(undefined);
    const passwords = await submitPasswordForm();

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(passwords));

    expect(toastSuccess).toHaveBeenCalledWith('Senha alterada. Entre novamente com sua nova senha.');
    expect(navigate).toHaveBeenCalledWith({ to: '/login', search: { redirect: '/demandas' } });
  });

  it('não anuncia sucesso nem navega quando a API rejeita a troca', async () => {
    mutateAsync.mockRejectedValue(new Error('denied'));
    extractApiError.mockResolvedValue({ title: 'Não foi possível alterar', message: 'Tente novamente.' });
    await submitPasswordForm();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Não foi possível alterar', { description: 'Tente novamente.' }));

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
