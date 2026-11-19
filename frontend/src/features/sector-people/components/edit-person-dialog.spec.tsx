import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'ADMIN',
  permissions: undefined as string[] | undefined,
  update: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (select: (s: { user: { role: string; permissions?: string[] } }) => unknown) =>
    select({ user: { role: mocks.role, permissions: mocks.permissions } }),
}));

vi.mock('../api', () => ({ useUpdateSectorPerson: () => ({ mutateAsync: mocks.update, isPending: false }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));

import { REASON_MESSAGE } from '@/features/people-record/reason';
import { EditPersonDialog } from './edit-person-dialog';
import { chooseAuthorization } from './test-helpers';
import type { SectorPerson } from '../schemas';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

const options = {
  levels: [{ id: 'l1', name: 'Líder' }, { id: 'l2', name: 'Funcionário' }],
  shifts: [{ id: 'sh1', name: 'Dia' }, { id: 'sh2', name: 'Noite' }],
};
const noAuthorization = { status: 'NAO_AUTORIZADO', source: null, note: null, date: null, recordedAt: null } as const;
const legacyAuthorization = { status: 'AUTORIZADO', source: 'CADASTRO_ANTERIOR', note: null, date: null, recordedAt: '2026-11-01T10:00:00Z' } as const;
const free: SectorPerson = {
  id: 'u2', name: 'Bia', phoneE164: '+5592988887777', hasPhone: true, phoneMasked: '•••• 7777', hasAccess: false, role: null, level: null, jobTitle: null, shift: { id: 'sh1', name: 'Dia' },
  editable: 'full', registration: null, isActive: true, contactAuthorization: noAuthorization,
};
const withAccess: SectorPerson = {
  ...free, id: 'u1', name: 'Ana', phoneE164: null, hasPhone: false, phoneMasked: null, hasAccess: true, role: 'OPERATOR', editable: 'limited', registration: 'M-7', contactAuthorization: legacyAuthorization,
};
const REASON = 'Ajuste de cadastro';
const typeReason = (text = REASON) => userEvent.setup().type(screen.getByLabelText('Motivo da alteração'), text);
const save = () => userEvent.setup().click(screen.getByRole('button', { name: 'Salvar' }));

function renderDialog(person: SectorPerson) {
  return render(<EditPersonDialog sectorId="s1" person={person} options={options} open onOpenChange={vi.fn()} />);
}

function apiError(status: number, code: string) {
  return new HTTPError(new Response(JSON.stringify({ code }), { status }), new Request('https://x'), {} as never);
}

async function pickOption(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.permissions = undefined;
  mocks.update.mockResolvedValue(undefined);
});

/** CB5: sem `telefone.ver_completo` a API manda `phoneE164` nulo e só a máscara. */
const withoutFullPhone: SectorPerson = { ...free, phoneE164: null };
const asSupervisor = (permissions: string[]) => {
  mocks.role = 'SUPERVISOR';
  mocks.permissions = permissions;
};

const maskedName: SectorPerson = { ...free, name: '•••• 7777', phoneE164: null };
const NAME_HINT = 'O nome desta pessoa é o número de telefone. Informe o nome para substituir.';
const NO_DOTS = 'Informe o nome sem os pontos.';
const typeName = (text: string) => userEvent.setup().type(screen.getByLabelText('Nome'), text);

describe('EditPersonDialog: nome mascarado', () => {
  it('abre com o campo vazio, a máscara no placeholder e o apoio; salvar outra alteração não envia name', async () => {
    renderDialog(maskedName);
    const field = screen.getByLabelText('Nome');
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', '•••• 7777');
    expect(screen.getByText(NAME_HINT)).toBeInTheDocument();
    await pickOption('Nível', 'Líder');
    await typeReason();
    await save();
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ userId: 'u2', data: { levelId: 'l1', reason: REASON } }));
  });

  it('preenchido envia o nome novo', async () => {
    renderDialog(maskedName);
    await typeName('Ana Souza');
    await typeReason();
    await save();
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ userId: 'u2', data: { name: 'Ana Souza', reason: REASON } }));
  });

  it('texto com o ponto • mostra o erro e não envia', async () => {
    renderDialog(maskedName);
    await typeName('•••• Ana');
    await typeReason();
    await save();
    expect(await screen.findByText(NO_DOTS)).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('EditPersonDialog: telefone sem a chave', () => {
  it('sem telefone.ver_completo mostra •••• 7777 só leitura, com o aviso, e o PATCH não leva phone', async () => {
    asSupervisor(['pessoas.editar']);
    renderDialog(withoutFullPhone);
    const field = screen.getByLabelText('Telefone (WhatsApp)');
    expect(field).toHaveValue('•••• 7777');
    expect(field).toBeDisabled();
    expect(screen.getByText('Você não tem permissão para alterar o telefone já cadastrado.')).toBeInTheDocument();
    expect(document.body.innerHTML).toContain('Você não tem permissão para alterar o telefone já cadastrado.');
    expect(document.body.innerHTML).not.toMatch(/98888|\+55/);
    await pickOption('Nível', 'Líder');
    await typeReason();
    await save();
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ userId: 'u2', data: { levelId: 'l1', reason: REASON } }));
  });

  it('sem a chave, pessoa sem telefone cadastrado pode receber um', async () => {
    asSupervisor(['pessoas.editar']);
    renderDialog({ ...withoutFullPhone, hasPhone: false, phoneMasked: null });
    expect(screen.queryByText('Você não tem permissão para alterar o telefone já cadastrado.')).not.toBeInTheDocument();
    await userEvent.setup().type(screen.getByLabelText('Telefone (WhatsApp)'), '92977776666');
    await typeReason();
    await save();
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ userId: 'u2', data: { phone: '92977776666', reason: REASON } }));
  });
});

describe('EditPersonDialog: telefone com a chave e regra do setor', () => {
  it('com a chave mostra o telefone formatado como hoje, editável', () => {
    asSupervisor(['pessoas.editar', 'telefone.ver_completo']);
    renderDialog(free);
    expect(screen.getByLabelText('Telefone (WhatsApp)')).toHaveValue('(92) 98888-7777');
    expect(screen.getByLabelText('Telefone (WhatsApp)')).toBeEnabled();
  });

  it('pessoa com login para quem não é ADMIN (hasPhone true, phoneE164 e phoneMasked nulos) mostra "—", sem máscara nem Sem telefone', () => {
    asSupervisor(['pessoas.editar']);
    renderDialog({ ...withAccess, hasPhone: true, phoneE164: null, phoneMasked: null });
    expect(screen.getByLabelText('Telefone (WhatsApp)')).toHaveValue('—');
    expect(document.body.innerHTML).toContain('Nome e telefone de quem tem acesso mudam em Usuários.');
    expect(document.body.innerHTML).not.toMatch(/••••|Sem telefone|alterar o telefone já cadastrado/);
    expect(screen.getByText('Nome e telefone de quem tem acesso mudam em Usuários.')).toBeInTheDocument();
  });
});

describe('EditPersonDialog: motivo da alteração', () => {
  it('salvar sem motivo bloqueia: mostra o erro e não envia', async () => {
    renderDialog(free);
    await pickOption('Nível', 'Líder');
    await save();
    expect(await screen.findByText(REASON_MESSAGE)).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('com motivo envia reason aparado junto do que mudou', async () => {
    renderDialog(free);
    await pickOption('Nível', 'Líder');
    await typeReason('  Ajuste de cadastro ');
    await save();
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ userId: 'u2', data: { levelId: 'l1', reason: REASON } }));
  });
});

describe('EditPersonDialog: matrícula e autorização', () => {
  it('sem acesso: troca matrícula e autorização e o PATCH leva as duas, com o motivo', async () => {
    renderDialog(free);
    await userEvent.setup().type(screen.getByLabelText('Matrícula'), 'A-12');
    await chooseAuthorization('Termo assinado');
    await typeReason();
    await save();
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        userId: 'u2',
        data: { registration: 'A-12', contactAuthorization: { status: 'AUTORIZADO', source: 'TERMO_ASSINADO', date: '2026-11-10' }, reason: REASON },
      }),
    );
  });

  it('data futura da autorização não envia e mostra o erro no campo', async () => {
    renderDialog(free);
    await chooseAuthorization('Termo assinado', '2999-01-01');
    await typeReason();
    await save();
    expect(await screen.findByText('A data da autorização não pode ser futura')).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('com acesso: matrícula e autorização só leitura, sem opções para escolher (D16)', () => {
    renderDialog(withAccess);
    expect(screen.getByLabelText('Matrícula')).toBeDisabled();
    expect(screen.getByLabelText('Matrícula')).toHaveValue('M-7');
    expect(screen.getByLabelText('Autorização de contato')).toHaveValue('Cadastro anterior — origem não verificada');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});

describe('EditPersonDialog', () => {
  it('sem acesso edita nome, telefone, nível, função e turno', async () => {
    renderDialog(free);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Nome'));
    await user.type(screen.getByLabelText('Nome'), 'Beatriz');
    await user.clear(screen.getByLabelText('Telefone (WhatsApp)'));
    await user.type(screen.getByLabelText('Telefone (WhatsApp)'), '92977776666');
    await pickOption('Nível', 'Líder');
    await user.type(screen.getByLabelText('Função (opcional)'), 'Conferente');
    await pickOption('Turno', 'Noite');
    await typeReason();
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        userId: 'u2',
        data: { name: 'Beatriz', phone: '92977776666', levelId: 'l1', jobTitle: 'Conferente', shiftId: 'sh2', reason: REASON },
      }),
    );
  });

  it('com acesso: nome e telefone só leitura, PATCH só com nível/função/turno', async () => {
    renderDialog({ ...withAccess, phoneE164: '+5592988887777' });
    expect(screen.getByLabelText('Nome')).toBeDisabled();
    expect(screen.getByLabelText('Telefone (WhatsApp)')).toBeDisabled();
    await pickOption('Nível', 'Funcionário');
    await typeReason();
    await save();
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ userId: 'u1', data: { levelId: 'l2', reason: REASON } }));
  });
});

describe('EditPersonDialog', () => {
  it('quem já tem turno não pode voltar a "Sem turno"; quem não tem pode ficar sem', async () => {
    const user = userEvent.setup();
    const optionsOf = async () => (await screen.findAllByRole('option')).map((option) => option.textContent);
    const first = renderDialog(free);
    await user.click(screen.getByRole('combobox', { name: 'Turno' }));
    expect(await optionsOf()).toEqual(['Dia', 'Noite']);
    first.unmount();
    renderDialog({ ...free, shift: null });
    await user.click(screen.getByRole('combobox', { name: 'Turno' }));
    expect(await optionsOf()).toEqual(['Sem turno', 'Dia', 'Noite']);
  });

  it('phoneE164 null (gestor × pessoa com acesso) mostra "—"', () => {
    renderDialog(withAccess);
    expect(screen.getByLabelText('Telefone (WhatsApp)')).toHaveValue('—');
  });

  it('403 mostra "Você não pode mexer nesta pessoa."', async () => {
    mocks.update.mockRejectedValue(apiError(403, 'sector_people.forbidden'));
    renderDialog(withAccess);
    await pickOption('Nível', 'Líder');
    await typeReason();
    await save();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Você não pode mexer nesta pessoa.'));
  });
});
