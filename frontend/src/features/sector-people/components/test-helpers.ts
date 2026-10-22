import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';

// jsdom não implementa estas APIs de ponteiro; o Radix Select as chama ao abrir/escolher.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

export const sectorOptions = {
  levels: [
    { id: 'level_leader', name: 'Líder' },
    { id: 'level_employee', name: 'Funcionário' },
  ],
  shifts: [
    { id: 'dia', name: 'Dia' },
    { id: 'noite', name: 'Noite' },
  ],
};

/** Erro de API com corpo consumível por `readApiErrorBody` (ky 2: corpo em `data`). */
export function apiError(status: number, code: string) {
  return new HTTPError(new Response(JSON.stringify({ code }), { status }), new Request('https://x'), {} as never);
}

export async function pickOption(label: string, option: string) {
  await userEvent.setup().click(screen.getByRole('combobox', { name: label }));
  await userEvent.setup().click(await screen.findByRole('option', { name: option }));
}
