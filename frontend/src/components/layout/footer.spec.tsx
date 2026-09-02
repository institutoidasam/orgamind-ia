import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/release-notes', () => ({
  latestRelease: () => ({
    version: '2026.09.01',
    date: '2026-09-01',
    title: 'x',
    items: [],
  }),
}));

vi.mock('@/lib/format-date-ptbr', () => ({
  formatRelativeToToday: (dateStr: string) => `RELATIVE(${dateStr})`,
  formatDatePtBr: (dateStr: string) => dateStr,
}));

import { Footer } from './footer';

afterEach(cleanup);

describe('Footer', () => {
  it('mostra a versão mais nova e a data relativa formatada', () => {
    render(<Footer />);
    expect(
      screen.getByText('Versão 2026.09.01 · atualizado RELATIVE(2026-09-01)'),
    ).toBeInTheDocument();
  });
});
