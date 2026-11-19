import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, apiRelativePath, onPermissionDenied } from './api-client';
import { readApiErrorBody } from './api-error';
import { queryClient } from './query-client';
import { useAuthStore } from '@/stores/auth.store';

function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ code, title: 'Ação não permitida', status }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

const USER = { id: 'u1', email: 'a@b.com', name: 'Ana', role: 'OPERATOR' } as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function pathOf(input: RequestInfo | URL): string {
  return new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAuthStore.setState({ accessToken: null, user: null, mustChangePassword: false });
});

function refreshFailingFetch(refresh: () => Response) {
  return vi.fn(async (input: RequestInfo | URL) =>
    pathOf(input) === '/auth/refresh' ? refresh() : jsonResponse(401, { code: 'auth.unauthorized' }),
  );
}

// jsdom's Request (undici) rejects relative URLs; a browser resolves them against the page.
function stubPageRelativeRequest() {
  const NativeRequest = Request;
  vi.stubGlobal('Request', class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, window.location.origin).href : input, init);
    }
  });
}

async function loadWithApiBase(base: string) {
  stubPageRelativeRequest();
  vi.stubEnv('VITE_API_URL', base);
  vi.resetModules();
  const [client, store, query] = await Promise.all([
    import('./api-client'),
    import('@/stores/auth.store'),
    import('./query-client'),
  ]);
  store.useAuthStore.setState({ accessToken: 'old', user: USER, mustChangePassword: false });
  return {
    api: client.api,
    onDenied: client.onPermissionDenied,
    session: () => store.useAuthStore.getState(),
    clear: vi.spyOn(query.queryClient, 'clear'),
  };
}

function prefixedFetch(refresh: () => Response) {
  return vi.fn(async (input: RequestInfo | URL) =>
    pathOf(input) === '/api/auth/refresh' ? refresh() : jsonResponse(401, { code: 'auth.unauthorized' }),
  );
}

describe('API sob o prefixo /api: rotas /auth/*', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('GET auth/me em segundo plano devolve o 401 e não encerra a sessão (refresh sem rede)', async () => {
    vi.stubGlobal('fetch', prefixedFetch(() => { throw new TypeError('Failed to fetch'); }));
    const { api: prefixed, session, clear } = await loadWithApiBase('/api');

    const error = await prefixed.get('auth/me').json().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ response: { status: 401 } });
    expect(session()).toMatchObject({ accessToken: 'old', user: USER });
    expect(clear).not.toHaveBeenCalled();
  });

  it('403 auth.permission_denied em GET auth/me não avisa os ouvintes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemResponse(403, 'auth.permission_denied')));
    const { api: prefixed, onDenied } = await loadWithApiBase('/api');
    const listener = vi.fn();
    const unsubscribe = onDenied(listener);

    const error = await prefixed.get('auth/me').json().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ response: { status: 403 } });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('401 em POST auth/login é devolvido sem tentar refresh', async () => {
    const fetchMock = prefixedFetch(() => jsonResponse(200, { accessToken: 'new' }));
    vi.stubGlobal('fetch', fetchMock);
    const { api: prefixed, session } = await loadWithApiBase('/api');

    await prefixed.post('auth/login', { json: { email: 'a@b.com', password: 'x' } }).json().catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(session().accessToken).toBe('old');
  });
});

describe('API sob o prefixo /api: rota comum segue como antes', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('401 com refresh recusado encerra a sessão', async () => {
    const refresh = vi.fn(() => jsonResponse(401, { code: 'auth.invalid_refresh' }));
    vi.stubGlobal('fetch', prefixedFetch(refresh));
    const { api: prefixed, session, clear } = await loadWithApiBase('/api');

    await prefixed.get('internal/sectors').json().catch(() => undefined);

    expect(refresh).toHaveBeenCalledOnce();
    expect(session()).toMatchObject({ accessToken: null, user: null });
    expect(clear).toHaveBeenCalledOnce();
  });

  it('403 auth.permission_denied avisa os ouvintes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemResponse(403, 'auth.permission_denied')));
    const { api: prefixed, onDenied } = await loadWithApiBase('/api');
    const listener = vi.fn();
    const unsubscribe = onDenied(listener);

    await prefixed.get('internal/sectors').json().catch(() => undefined);

    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});

describe('apiRelativePath', () => {
  const origin = 'http://localhost:3000';

  it.each([
    ['/api', `${origin}/api/auth/me`, '/auth/me'],
    ['/api/', `${origin}/api/auth/me`, '/auth/me'],
    ['https://x/api', 'https://x/api/auth/me', '/auth/me'],
    ['https://x/api/', 'https://x/api/auth/me', '/auth/me'],
    ['http://localhost:3000', `${origin}/auth/me`, '/auth/me'],
    ['', `${origin}/auth/me`, '/auth/me'],
    ['/api', `${origin}/api`, '/'],
    ['/api', `${origin}/apiary/x`, '/apiary/x'],
  ])('base %j: %s -> %s', (base, url, expected) => {
    expect(apiRelativePath(url, base)).toBe(expected);
  });
});

describe('refresh que falha', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'old', user: USER, mustChangePassword: false });
  });

  it('GET auth/me em segundo plano devolve o 401 e não encerra a sessão (refresh sem rede)', async () => {
    vi.stubGlobal('fetch', refreshFailingFetch(() => { throw new TypeError('Failed to fetch'); }));
    const clear = vi.spyOn(queryClient, 'clear');

    const error = await api.get('auth/me').json().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ response: { status: 401 } });
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'old', user: USER });
    expect(clear).not.toHaveBeenCalled();
  });

  it('rota comum com 401 e refresh recusado encerra a sessão', async () => {
    const refresh = vi.fn(() => jsonResponse(401, { code: 'auth.invalid_refresh' }));
    vi.stubGlobal('fetch', refreshFailingFetch(refresh));
    const clear = vi.spyOn(queryClient, 'clear');

    await api.get('people').json().catch(() => undefined);

    expect(refresh).toHaveBeenCalledOnce();
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, user: null });
    expect(clear).toHaveBeenCalledOnce();
  });
});

describe('403 auth.permission_denied em GET auth/me', () => {
  it('não avisa os ouvintes: a releitura não pode invalidar a si mesma', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemResponse(403, 'auth.permission_denied')));
    const listener = vi.fn();
    const unsubscribe = onPermissionDenied(listener);

    const error = await api.get('auth/me').json().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ response: { status: 403 } });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('renovação do token em /auth/*', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'old', user: USER, mustChangePassword: false });
  });

  it('GET auth/me com 401 renova o token uma vez e repete a chamada', async () => {
    const meAuth: (string | null)[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === '/auth/refresh') return jsonResponse(200, { accessToken: 'new' });
      meAuth.push(input instanceof Request ? input.headers.get('Authorization') : null);
      return meAuth.length === 1 ? jsonResponse(401, { code: 'auth.unauthorized' }) : jsonResponse(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const body = await api.get('auth/me').json();

    expect(body).toEqual({ ok: true });
    const refreshes = fetchMock.mock.calls.filter(([input]) => pathOf(input) === '/auth/refresh');
    expect(refreshes).toHaveLength(1);
    expect(meAuth).toEqual(['Bearer old', 'Bearer new']);
  });

  it('401 em outra rota /auth/* não dispara refresh', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { code: 'auth.invalid_credentials' }));
    vi.stubGlobal('fetch', fetchMock);

    await api.post('auth/login', { json: { email: 'a@b.com', password: 'x' } }).json().catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useAuthStore.getState().accessToken).toBe('old');
  });
});

describe('onPermissionDenied', () => {
  it('403 auth.permission_denied avisa os ouvintes e o corpo segue legível', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemResponse(403, 'auth.permission_denied')));
    const listener = vi.fn();
    const unsubscribe = onPermissionDenied(listener);

    const error = await api.get('people').json().catch((caught: unknown) => caught);

    expect(listener).toHaveBeenCalledOnce();
    expect(await readApiErrorBody(error)).toMatchObject({ code: 'auth.permission_denied', status: 403 });

    unsubscribe();
    await api.get('people').json().catch(() => undefined);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('403 de outro código não avisa ninguém', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemResponse(403, 'sector.manager_admin_only')));
    const listener = vi.fn();
    const unsubscribe = onPermissionDenied(listener);

    await api.get('people').json().catch(() => undefined);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
