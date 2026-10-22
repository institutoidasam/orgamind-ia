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
  useSectorPersonCandidates,
  useUpdateSectorPerson,
} from './api';

afterEach(() => vi.restoreAllMocks());

const person = {
  id: 'u2', name: 'Bia', phoneE164: '+5592988887777', hasAccess: false, role: null,
  level: null, jobTitle: null, shift: { id: 'sh1', name: 'Dia' }, editable: 'full',
};
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
    const data = { name: 'Bia', phone: '92988887777', levelId: null, jobTitle: 'Conferente', shiftId: 'sh1' };
    const { request, url, body, invalidatedKeys } = await mutate(() => useCreateSectorPerson('s1'), data, person);
    expect(request.method).toBe('POST');
    expect(url.pathname).toMatch(/\/internal\/sectors\/s1\/people$/);
    expect(body).toEqual(data);
    expect(invalidatedKeys()).toEqual(REFRESHED);
  });

  it('de contatos: POST /people/from-contacts, devolve created e failed, e recarrega', async () => {
    const data = { contactIds: ['c1', 'c2'], levelId: 'l1', shiftId: 'sh1' };
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
    const vars = { userId: 'u2', data: { levelId: 'l2', shiftId: 'sh2' } };
    const { request, url, body, invalidatedKeys } = await mutate(() => useUpdateSectorPerson('s1'), vars, null, 204);
    expect(request.method).toBe('PATCH');
    expect(url.pathname).toMatch(/\/internal\/sectors\/s1\/people\/u2$/);
    expect(body).toEqual({ levelId: 'l2', shiftId: 'sh2' });
    expect(invalidatedKeys()).toEqual(REFRESHED);
  });

  it('tirar do setor: DELETE /people/:userId, e recarrega', async () => {
    const { request, url, invalidatedKeys } = await mutate(() => useRemoveSectorPerson('s1'), 'u2', null, 204);
    expect(request.method).toBe('DELETE');
    expect(url.pathname).toMatch(/\/internal\/sectors\/s1\/people\/u2$/);
    expect(invalidatedKeys()).toEqual(REFRESHED);
  });
});
