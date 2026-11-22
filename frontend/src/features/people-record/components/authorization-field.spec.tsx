import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizationChoiceError, toAuthorizationInput, type AuthorizationChoice } from '../authorization';
import { AuthorizationField } from './authorization-field';

afterEach(() => vi.useRealTimers());

function Harness({ initial = null, onValue }: { initial?: AuthorizationChoice | null; onValue?: (v: AuthorizationChoice | null) => void }) {
  const [value, setValue] = useState<AuthorizationChoice | null>(initial);
  return (
    <AuthorizationField
      value={value}
      error={authorizationChoiceError(value)}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

const radio = (name: string) => screen.getByRole('radio', { name });

describe('AuthorizationField', () => {
  it('começa sem nada marcado e com as cinco opções da spec', () => {
    render(<Harness />);
    const names = screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent);
    expect(names).toEqual(['Termo assinado', 'Ficha de admissão', 'Aceite pelo WhatsApp', 'Outro', 'Sem autorização registrada']);
    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect(screen.queryByLabelText('Data da autorização')).not.toBeInTheDocument();
  });

  it('origem escolhida pede a data, com padrão hoje em Manaus e máximo hoje', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T02:30:00Z'));
    const onValue = vi.fn();
    const ui = userEvent.setup();
    render(<Harness onValue={onValue} />);
    await ui.click(radio('Termo assinado'));
    const date = screen.getByLabelText('Data da autorização');
    expect(date).toHaveValue('2026-11-19');
    expect(date).toHaveAttribute('max', '2026-11-19');
    expect(onValue).toHaveBeenLastCalledWith({ status: 'AUTORIZADO', source: 'TERMO_ASSINADO', date: '2026-11-19' });
  });

  it('Outro exige o texto: sem ele mostra o erro, com ele a escolha vira corpo da API', async () => {
    const onValue = vi.fn();
    const ui = userEvent.setup();
    render(<Harness onValue={onValue} />);
    await ui.click(radio('Outro'));
    const note = screen.getByLabelText('Descreva a origem');
    expect(note).toBeRequired();
    expect(note).toHaveAttribute('maxlength', '120');
    expect(screen.getByRole('alert')).toHaveTextContent('Descreva a origem da autorização');
    await ui.type(note, 'Carta do RH');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(toAuthorizationInput(onValue.mock.lastCall![0])).toMatchObject({ source: 'OUTRO', note: 'Carta do RH' });
  });

  it('Sem autorização registrada mostra o aviso e esconde a data', async () => {
    const ui = userEvent.setup();
    render(<Harness initial={{ status: 'AUTORIZADO', source: 'FICHA_ADMISSAO', date: '2026-11-03' }} />);
    expect(radio('Ficha de admissão')).toBeChecked();
    await ui.click(radio('Sem autorização registrada'));
    expect(screen.getByText('Esta pessoa não receberá mensagens até a autorização ser registrada')).toBeInTheDocument();
    expect(screen.queryByLabelText('Data da autorização')).not.toBeInTheDocument();
  });
});
