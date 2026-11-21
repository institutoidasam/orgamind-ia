import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth.store';
import { useSendFilters } from '../use-send-filters';
import { PurposeFields } from './purpose-fields';

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

type User = ReturnType<typeof userEvent.setup>;

function Harness() {
  const filters = useSendFilters('2026-10-21', []);
  return <PurposeFields filters={filters} />;
}

async function pick(user: User, trigger: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: trigger }));
  await user.click(screen.getByRole('option', { name: option }));
}

const OFF = 'Incluir quem está de folga';

// A Urgência só aparece com `equipe.urgencia` (a lista dela está em purpose-fields.urgency.spec.tsx).
beforeEach(() => {
  useAuthStore.setState({
    user: { id: 'u1', email: 'o@x.test', name: 'Olga', role: 'OPERATOR', permissions: ['equipe.enviar', 'equipe.urgencia'] },
  });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
});

describe('PurposeFields: folga por finalidade', () => {
  it('aceite 14: Incluir quem está de folga marcado em Reunião e Palestra, desmarcado em Hora extra e Alinhamento, ausente em Aviso de turno e Urgência', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const expected: [string, boolean | null][] = [
      ['Aviso de turno', null], ['Reunião', true], ['Alinhamento', false],
      ['Palestra', true], ['Hora extra', false], ['Urgência', null],
    ];
    for (const [purpose, checked] of expected) {
      await pick(user, 'Finalidade', purpose);
      const box = screen.queryByRole('checkbox', { name: OFF });
      if (checked === null) expect(box).not.toBeInTheDocument();
      else if (checked) expect(box).toBeChecked();
      else expect(box).not.toBeChecked();
    }
  });

  it('Alinhamento mostra Base do público; trocar para Equipe em serviço esconde a folga', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole('combobox', { name: 'Finalidade' })).toHaveTextContent('Aviso de turno');
    expect(screen.queryByRole('combobox', { name: 'Base do público' })).not.toBeInTheDocument();
    expect(screen.getByText('Base do público: Equipe em serviço')).toBeInTheDocument();
    await pick(user, 'Finalidade', 'Reunião');
    expect(screen.queryByRole('combobox', { name: 'Base do público' })).not.toBeInTheDocument();
    expect(screen.getByText('Base do público: Equipe vinculada')).toBeInTheDocument();
    await pick(user, 'Finalidade', 'Alinhamento');
    expect(screen.getByRole('combobox', { name: 'Base do público' })).toHaveTextContent('Equipe vinculada');
    await user.click(screen.getByRole('checkbox', { name: OFF }));
    expect(screen.getByRole('checkbox', { name: OFF })).toBeChecked();
    await pick(user, 'Base do público', 'Equipe em serviço');
    expect(screen.queryByRole('checkbox', { name: OFF })).not.toBeInTheDocument();
    await pick(user, 'Base do público', 'Equipe vinculada');
    expect(screen.getByRole('checkbox', { name: OFF })).not.toBeChecked();
  });
});

describe('PurposeFields: atividade e motivo', () => {
  it('atividade em Reunião, Palestra, Hora extra e Alinhamento; motivo só na Urgência', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const hasActivity = () => screen.queryByRole('group', { name: 'Atividade' }) !== null;
    const reason = () => screen.queryByLabelText('Motivo da urgência');
    expect([hasActivity(), reason()]).toEqual([false, null]);
    for (const purpose of ['Reunião', 'Palestra', 'Hora extra', 'Alinhamento']) {
      await pick(user, 'Finalidade', purpose);
      expect(hasActivity()).toBe(true);
      expect(screen.getByLabelText('Data da atividade')).toHaveAttribute('type', 'date');
      expect(screen.getByLabelText('Hora de início')).toHaveAttribute('type', 'time');
      expect(screen.getByLabelText('Local')).toBeInTheDocument();
      expect(reason()).toBeNull();
    }
    expect(screen.getByText(/Opcional: se informar a atividade/)).toBeInTheDocument();
    await pick(user, 'Finalidade', 'Palestra');
    expect(screen.queryByText(/Opcional: se informar a atividade/)).not.toBeInTheDocument();
    await pick(user, 'Finalidade', 'Urgência');
    expect(hasActivity()).toBe(false);
    expect(reason()).toBeInTheDocument();
  });

  it('local até 120 e motivo até 200 caracteres', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, 'Finalidade', 'Reunião');
    await user.click(screen.getByLabelText('Local'));
    await user.paste('L'.repeat(130));
    expect(screen.getByLabelText('Local')).toHaveValue('L'.repeat(120));
    await pick(user, 'Finalidade', 'Urgência');
    await user.click(screen.getByLabelText('Motivo da urgência'));
    await user.paste('M'.repeat(210));
    expect(screen.getByLabelText('Motivo da urgência')).toHaveValue('M'.repeat(200));
  });
});
