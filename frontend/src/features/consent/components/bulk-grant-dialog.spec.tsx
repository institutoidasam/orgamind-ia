import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminPurpose, BulkGrantResult } from '@/features/consent/admin';
import { BulkGrantSection } from './bulk-grant-dialog';

const previewMut = { mutateAsync: vi.fn(), isPending: false };
const applyMut = { mutateAsync: vi.fn(), isPending: false };

const PURPOSE: AdminPurpose = {
  key: 'continuum_avisos',
  label: 'Avisos do CONTINUUM',
  description: 'Comunicados do programa.',
  isSensitive: false,
  active: true,
  texts: [],
  activeText: null,
  consents: 0,
  events: 0,
  campaigns: 0,
};

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// O FilterBuilder das campanhas é reusado literalmente; aqui ele é dublê para o
// teste falar sobre o dialog, não sobre a árvore de filtros (que tem spec própria).
vi.mock('@/features/campaigns/components/filter-builder', () => ({
  FilterBuilder: ({
    onChange,
  }: {
    onChange: (v: unknown) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onChange({
          combinator: 'and',
          rules: [{ field: 'group', op: 'eq', value: 'CONTINUUM' }],
        })
      }
    >
      filtrar grupo CONTINUUM
    </button>
  ),
}));

vi.mock('@/features/consent/admin', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/consent/admin')>();
  return {
    ...actual,
    useAdminPurposes: () => ({ data: [PURPOSE], isLoading: false }),
    useBulkGrantPreview: () => previewMut,
    useBulkGrant: () => applyMut,
  };
});

const RESULT: BulkGrantResult = {
  total: 120,
  granted: 100,
  skippedSuppressed: 15,
  alreadyGranted: 5,
  failed: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  previewMut.mutateAsync.mockResolvedValue(RESULT);
  applyMut.mutateAsync.mockResolvedValue(RESULT);
  // O Select do Radix usa APIs de ponteiro que o jsdom não implementa.
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

async function abrir() {
  const user = userEvent.setup();
  render(<BulkGrantSection />);
  await user.click(
    screen.getByRole('button', { name: /registrar consentimento da base/i }),
  );
  return user;
}

/** Sem finalidade não há consentimento válido — nada no dialog funciona sem ela. */
async function escolherFinalidade(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox'));
  await user.click(
    await screen.findByRole('option', { name: 'Avisos do CONTINUUM' }),
  );
}

describe('BulkGrantSection', () => {
  // Bug de produção: o dialog reusa o construtor de filtros das campanhas
  // (desenhado para página larga), e é estreito demais para ele — a linha da
  // regra transbordava, o campo de VALOR ficava cortado e surgia uma barra de
  // rolagem horizontal no rodapé do dialog.
  it('é largo o suficiente para o construtor de filtros e não força rolagem horizontal', async () => {
    await abrir();
    const dialog = screen.getByRole('dialog');

    // O DialogContent base tem `sm:max-w-sm` (estreito). Se a largura deste
    // dialog for passada SEM o prefixo `sm:` (ex.: `max-w-2xl`), o
    // tailwind-merge preserva os dois — e por ordem de cascata (media queries
    // depois das regras base) o `sm:max-w-sm` do default GANHA em telas
    // >= 640px, prendendo o dialog em 384px mesmo o código "parecendo" mais
    // largo. A largura customizada tem que vencer de verdade.
    expect(dialog.className).not.toMatch(/(?:^|\s)sm:max-w-sm(?:\s|$)/);

    // Nunca deve depender de rolagem horizontal para caber o construtor de
    // filtros — só rolagem vertical é aceitável.
    expect(dialog.className).not.toMatch(/overflow-x-(auto|scroll)/);
  });

  it('mostra o aviso legal explícito antes de qualquer registro', async () => {
    await abrir();

    const aviso = screen.getByTestId('aviso-legal');
    expect(aviso).toHaveTextContent(/você declara/i);
    expect(aviso).toHaveTextContent(/registro comprovável/i);
    expect(aviso).toHaveTextContent(/sua identificação/i);
    expect(aviso).toHaveTextContent(/auditável/i);
  });

  it('EXIGE a evidência: sem referência e data, não dá para confirmar', async () => {
    const user = await abrir();
    await escolherFinalidade(user);

    const confirmar = screen.getByRole('button', { name: /registrar/i });
    expect(confirmar).toBeDisabled();

    // Só a referência ainda não basta — falta QUANDO concordaram.
    await user.type(
      screen.getByLabelText(/onde .*concordaram|referência/i),
      'Contrato CONTINUUM #123',
    );
    expect(screen.getByRole('button', { name: /registrar/i })).toBeDisabled();
  });

  it('mostra quantos contatos serão afetados antes de confirmar', async () => {
    const user = await abrir();
    await escolherFinalidade(user);

    await user.click(
      screen.getByRole('button', { name: /filtrar grupo continuum/i }),
    );

    await waitFor(() => {
      expect(previewMut.mutateAsync).toHaveBeenCalled();
    });

    const contagem = await screen.findByTestId('bulk-preview');
    expect(contagem).toHaveTextContent('120');
    expect(contagem).toHaveTextContent('100');
    // Pulados por supressão e já concedidos aparecem separados: o operador
    // precisa saber que 15 pessoas NÃO vão receber consentimento, e por quê.
    expect(contagem).toHaveTextContent('15');
    expect(contagem).toHaveTextContent('5');
  });

  it('registra com finalidade, filtro e evidência', async () => {
    const user = await abrir();
    await escolherFinalidade(user);

    await user.click(
      screen.getByRole('button', { name: /filtrar grupo continuum/i }),
    );
    await user.type(
      screen.getByLabelText(/onde .*concordaram|referência/i),
      'Contrato CONTINUUM #123',
    );
    await user.type(screen.getByLabelText(/quando|data/i), '2025-03-12');
    await user.type(
      screen.getByLabelText(/observação/i),
      'Cláusula 7 do contrato.',
    );

    await user.click(screen.getByRole('button', { name: /^registrar/i }));

    await waitFor(() => {
      expect(applyMut.mutateAsync).toHaveBeenCalledWith({
        purposeKey: 'continuum_avisos',
        filters: {
          combinator: 'and',
          rules: [{ field: 'group', op: 'eq', value: 'CONTINUUM' }],
        },
        evidenceRef: 'Contrato CONTINUUM #123',
        collectedAt: '2025-03-12',
        evidenceNote: 'Cláusula 7 do contrato.',
      });
    });
  });

  it('depois de aplicar, mostra concedidos / pulados por supressão / já tinham', async () => {
    const user = await abrir();
    await escolherFinalidade(user);

    await user.type(
      screen.getByLabelText(/onde .*concordaram|referência/i),
      'Contrato CONTINUUM #123',
    );
    await user.type(screen.getByLabelText(/quando|data/i), '2025-03-12');
    await user.click(screen.getByRole('button', { name: /^registrar/i }));

    const resultado = await screen.findByTestId('bulk-result');
    expect(resultado).toHaveTextContent(/100/);
    expect(resultado).toHaveTextContent(/15/);
    expect(resultado).toHaveTextContent(/5/);
    expect(resultado).toHaveTextContent(/supress/i);
  });
});
