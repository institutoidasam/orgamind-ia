import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sectorOptions } from './test-helpers';

const mocks = vi.hoisted(() => ({ role: 'ADMIN' }));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (select: (s: { user: { role: string } }) => unknown) => select({ user: { role: mocks.role } }),
}));
vi.mock('../api', () => {
  const empty = { data: { items: [] }, isPending: false, isError: false };
  const mutation = { mutateAsync: vi.fn(), isPending: false };
  return {
    useSectorContactCandidates: () => empty,
    useSectorPersonCandidates: () => empty,
    useCreateSectorPerson: () => mutation,
    useAddPeopleFromContacts: () => mutation,
    useMoveSectorPeople: () => mutation,
  };
});

import { AddPeopleDialog } from './add-people-dialog';

beforeEach(() => {
  mocks.role = 'ADMIN';
});

describe('AddPeopleDialog', () => {
  it.each(['ADMIN', 'SUPERVISOR'])('três abas para %s, cada uma com o seu conteúdo', async (role) => {
    mocks.role = role;
    render(<AddPeopleDialog sectorId="s1" options={sectorOptions} open onOpenChange={vi.fn()} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Nova pessoa', 'Dos contatos', 'Já cadastrada']);
    expect(screen.getByLabelText('Nome')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Dos contatos' }));
    expect(await screen.findByLabelText('Buscar contato por nome ou número')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Já cadastrada' }));
    expect(await screen.findByLabelText('Buscar pessoa por nome')).toBeInTheDocument();
  });
});
