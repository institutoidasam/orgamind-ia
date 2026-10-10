import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { latestRelease } from '@/release-notes';
import { __resetReleaseNotesStoreForTests } from '@/lib/use-release-notes';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { ReleaseNotesButton } from './release-notes-button';

const KEY = 'picoa.lastSeenRelease';

beforeEach(() => {
  // `memoryFallback` de use-release-notes.ts é estado de módulo — sem
  // resetar, o markSeen() real do teste "fechar o diálogo marca a versão
  // como vista" (abaixo) vaza para os testes seguintes do arquivo.
  __resetReleaseNotesStoreForTests();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('ReleaseNotesButton', () => {
  it('mostra o badge "Novo" sem abrir o diálogo quando há versão não vista', () => {
    render(<ReleaseNotesButton />);
    expect(screen.getByText('Novo')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('não mostra o badge nem abre sozinho quando a versão mais nova já foi vista', () => {
    window.localStorage.setItem(KEY, latestRelease().version);
    render(<ReleaseNotesButton />);
    expect(screen.queryByText('Novo')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicar no botão abre o diálogo mesmo já tendo sido visto', async () => {
    window.localStorage.setItem(KEY, latestRelease().version);
    const user = userEvent.setup();
    render(<ReleaseNotesButton />);
    await user.click(screen.getByRole('button', { name: 'Novidades' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('fechar o diálogo marca a versão como vista: o badge some e não reabre', async () => {
    const user = userEvent.setup();
    render(<ReleaseNotesButton />);
    expect(screen.getByText('Novo')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Novidades' }));
    await user.click(screen.getByRole('button', { name: 'Fechar' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Novo')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBe(latestRelease().version);
  });

  it('setItem lança → fechar fecha e não reabre', async () => {
    // Sem armazenamento disponível, fechar mantém o diálogo fechado.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const user = userEvent.setup();
    render(<ReleaseNotesButton />);
    await user.click(screen.getByRole('button', { name: 'Novidades' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Fechar' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
