import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useAddPeopleFromContacts,
  useCreateSectorPerson,
  useMoveSectorPeople,
  useRemoveSectorPerson,
  useSectorContactCandidates,
  useSectorPeople,
  useSectorPersonCandidates,
  useSetSectorPersonStatus,
  useUpdateSectorPerson,
} from './api';

afterEach(() => vi.restoreAllMocks());

// Ficha no contrato estrito: todos os campos vêm da API.
const listedPerson = {
  id: 'u2', name: 'Bia', phoneE164: '+5592988887777', hasPhone: true, phoneMasked: '•••• 7777', hasAccess: false, role: null,
  level: null, jobTitle: null, shift: { id: 'sh1', name: 'Dia' }, editable: 'full',
  registration: null,
  isActive: true,
  contactAuthorization: { status: 'NAO_AUTORIZADO', source: null, note: null, date: null, recordedAt: null },
};
const person = { ...listedPerson, registration: 'A-12' };
const NOT_AUTHORIZED = { status: 'NAO_AUTORIZADO' as const };
const REFRESHED = [['sector-people', 's1'], ['internal', 'sectors'], ['users']];

function setup(response: unknown, status = 200) {
  const bodies: string[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    // O ky consome o corpo da requisição; ele é lido aqui, antes, numa cópia.
    bodies.push(await (input as Request).clone().text());
    return status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const sent = () => fetchSpy.mock.calls[0]![0] as Request;
  const sentBody = () => (bodies[0] ? (JSON.parse(bodies[0]) as unknown) : undefined);
  const invalidatedKeys = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  return { wrapper, sent, sentBody, invalidatedKeys };
}

type Mutation<V> = { mutateAsync: (vars: V) => Promise<unknown> };

async function mutate<V>(useHook: () => Mutation<V>, vars: V, response: unknown = {}, status = 200) {
  const ctx = setup(response, status);
  const { result } = renderHook(useHook, { wrapper: ctx.wrapper });
  await act(async () => { await result.current.mutateAsync(vars); });
  return { ...ctx, request: ctx.sent(), url: new URL(ctx.sent().url), body: ctx.sentBody() };
}

const listResponse = {
  sector: { id: 's1', name: 'Logística', code: 'LOG', isActive: true, manager: null, channel: null },
  people: [listedPerson],
  options: { levels: [], shifts: [] },
};

async function readList(opts?: { includeInactive?: boolean }) {
  const ctx = setup(listResponse);
  const { result } = renderHook(() => useSectorPeople('s1', opts), { wrapper: ctx.wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return { url: new URL(ctx.sent().url), method: ctx.sent().method, data: result.current.data! };
}

describe('listagem do setor', () => {
  it('sem opts não manda parâmetro e devolve a ficha da pessoa', async () => {
    const { url, method, data } = await readList();
    expect(method).toBe('GET');
    expect(url.pathname).toMatch(/\/internal\/sectors\/s1\/people$/);
    expect(url.search).toBe('');
    expect(data.people[0]).toMatchObject(listedPerson);
  });

  it('com includeInactive manda includeInactive=true', async () => {
    const { url } = await readList({ includeInactive: true });
    expect(Object.fromEntries(url.searchParams)).toEqual({ includeInactive: 'true' });
  });

  it('ficha sem isActive e sem contactAuthorization falha no contrato estrito', async () => {
    const ctx = setup({ ...listResponse, people: [{ ...listedPerson, isActive: undefined, contactAuthorization: undefined }] });
    const { result } = renderHook(() => useSectorPeople('s1'), { wrapper: ctx.wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('telefone no contrato (CB5)', () => {
  it('ficha no formato anterior, sem hasPhone e phoneMasked, falha no contrato estrito', async () => {
    const ctx = setup({ ...listResponse, people: [{ ...listedPerson, hasPhone: undefined, phoneMasked: undefined }] });
    const { result } = renderHook(() => useSectorPeople('s1'), { wrapper: ctx.wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('contato sem telefone completo (phoneE164 nulo) traz só a máscara', async () => {
    const items = [{ contactId: 'c1', name: null, phoneE164: null, phoneMasked: '•••• 7777', person: null }];
    const { wrapper } = setup({ items });
    const { result } = renderHook(() => useSectorContactCandidates('s1', ''), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ items }));
  });
});

describe('inativar e reativar no setor', () => {
  it('POST /people/:userId/status com { isActive, reason }, e recarrega', async () => {
    const vars = { userId: 'u2', isActive: false, reason: 'Saiu da empresa' };
    const { request, url, body, invalidatedKeys } = await mutate(() => useSetSectorPersonStatus('s1'), vars, person);
    expect(request.method).toBe('POST');
    expect(url.pathname).toMatch(/\/internal\/sectors\/s1\/people\/u2\/status$/);
    expect(body).toEqual({ isActive: false, reason: 'Saiu da empresa' });
    expect(invalidatedKeys()).toEqual(REFRESHED);
  });
});

describe('candidatos (leitura)', () => {
  it.each([
    ['pessoas', useSectorPersonCandidates, 'candidates'],
    ['contatos', useSectorContactCandidates, 'contact-candidates'],
  ])('%s: GET em /people/%s com searchParams { q }', async (_label, useHook, path) => {
    const { wrapper, sent } = setup({ items: [] });
    const { result } = renderHook(() => useHook('s1', 'ana'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(sent().url);
    expect(sent().method).toBe('GET');
    expect(url.pathname).toMatch(new RegExp(`/internal/sectors/s1/people/${path}$`));
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'ana' });
  });
});

describe('escrita da lista de pessoas do setor', () => {
  it('nova pessoa: POST /people com o corpo, e recarrega lista, setores e usuários', async () => {
    const data = { name: 'Bia', phone: '92988887777', registration: 'A-12', contactAuthorization: NOT_AUTHORIZED, levelId: null, jobTitle: 'Conferente', shiftId: 'sh1' };
    const { request, url, body, invalidatedKeys } = await mutate(() => useCreateSectorPerson('s1'), data, person);
    expect(request.method).toBe('POST');
    expect(url.pathname).toMatch(/\/internal\/sectors\/s1\/people$/);
    expect(body).toEqual(data);
    expect(invalidatedKeys()).toEqual(REFRESHED);
  });

  it('de contatos: POST /people/from-contacts, devolve created e failed, e recarrega', async () => {
    const data = { contactIds: ['c1', 'c2'], contactAuthorization: NOT_AUTHORIZED, levelId: 'l1', shiftId: 'sh1' };
    const response = { created: [person], failed: [{ contactId: 'c2', reason: 'phone_taken' }] };
    const ctx = setup(response);
    const { result } = renderHook(() => useAddPeopleFromContacts('s1'), { wrapper: ctx.wrapper });
    let outcome: unknown;
    await act(async () => { outcome = await result.current.mutateAsync(data); });
    expect(ctx.sent().method).toBe('POST');
    expect(new URL(ctx.sent().url).pathname).toMatch(/\/internal\/sectors\/s1\/people\/from-contacts$/);
    expect(ctx.sentBody()).toEqual(data);
    expect(outcome).toEqual(response);
    expect(ctx.invalidatedKeys()).toEqual(REFRESHED);
  });

  it('mover: POST /people/move com { userIds }, e recarrega', async () => {
    const { request, url, body, invalidatedKeys } = await mutate(() => useMoveSectorPeople('s1'), ['u2', 'u3'], { moved: [person] });
    expect(request.method).toBe('POST');
    expect(url.pathname).toMatch(/\/internal\/sectors\/s1\/people\/move$/);
    expect(body).toEqual({ userIds: ['u2', 'u3'] });
    expect(invalidatedKeys()).toEqual(REFRESHED);
  });

  it('editar: PATCH /people/:userId só com o que mudou, e recarrega', async () => {
    const vars = { userId: 'u2', data: { levelId: 'l2', shiftId: 'sh2', reason: 'Troca de turno' } };
    const { request, url, body, invalidatedKeys } = await mutate(() => useUpdateSectorPerson('s1'), vars, null, 204);
    expect(request.method).toBe('PATCH');
    expect(url.pathname).toMatch(/\/internal\/sectors\/s1\/people\/u2$/);
    expect(body).toEqual({ levelId: 'l2', shiftId: 'sh2', reason: 'Troca de turno' });
    expect(invalidatedKeys()).toEqual(REFRESHED);
  });

  it('tirar do setor: DELETE /people/:userId, e recarrega', async () => {
    const { request, url, invalidatedKeys } = await mutate(() => useRemoveSectorPerson('s1'), 'u2', null, 204);
    expect(request.method).toBe('DELETE');
    expect(url.pathname).toMatch(/\/internal\/sectors\/s1\/people\/u2$/);
    expect(invalidatedKeys()).toEqual(REFRESHED);
  });
});
