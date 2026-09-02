import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DifyConsoleClient } from './dify-console.client';
import { DifyConsoleNotConfiguredError, BotKeyUnavailableError } from './errors/bot.errors';

const CFG = {
  DIFY_CONSOLE_URL: 'https://dify.test/console/api',
  DIFY_CONSOLE_EMAIL: 'admin@x.com',
  DIFY_CONSOLE_PASSWORD: 'pw',
};
function makeConfig(over: Partial<typeof CFG> = {}) {
  const v = { ...CFG, ...over };
  return { get: (k: keyof typeof CFG) => v[k] } as unknown as ConfigService;
}
function res(body: unknown, init: { status?: number; setCookie?: string[] } = {}) {
  const headers = new Headers();
  const r = new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
  r.headers.getSetCookie = () => init.setCookie ?? [];
  return r;
}
const COOKIES = [
  '__Host-access_token=AAA; Path=/; HttpOnly',
  '__Host-refresh_token=RRR; Path=/; HttpOnly',
  '__Host-csrf_token=CCC; Path=/',
];

describe('DifyConsoleClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('throws when not configured', async () => {
    const c = new DifyConsoleClient(makeConfig({ DIFY_CONSOLE_URL: undefined as any }));
    await expect(c.listChatApps()).rejects.toBeInstanceOf(DifyConsoleNotConfiguredError);
  });

  it('logs in with base64 password and lists only chat-mode apps', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ result: 'success' }, { setCookie: COOKIES })) // login
      .mockResolvedValueOnce(res({ data: [
        { id: 'a1', name: 'Chat', mode: 'chat' },
        { id: 'a2', name: 'Flow', mode: 'workflow' },
        { id: 'a3', name: 'Agent', mode: 'agent-chat' },
      ] }));
    const c = new DifyConsoleClient(makeConfig());
    const apps = await c.listChatApps();
    expect(apps).toEqual([{ id: 'a1', name: 'Chat', mode: 'chat' }, { id: 'a3', name: 'Agent', mode: 'agent-chat' }]);
    // login body had base64 password
    const loginBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(loginBody.password).toBe(Buffer.from('pw').toString('base64'));
    // apps call carried cookie + csrf header
    const appsInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((appsInit.headers as Record<string,string>)['x-csrf-token']).toBe('CCC');
    expect((appsInit.headers as Record<string,string>)['cookie']).toContain('__Host-access_token=AAA');
  });

  it('reuses an existing app- key', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ result: 'success' }, { setCookie: COOKIES }))
      .mockResolvedValueOnce(res({ data: [{ id: 'k1', token: 'app-EXISTING' }] }));
    const c = new DifyConsoleClient(makeConfig());
    expect(await c.getOrCreateAppKey('a1')).toBe('app-EXISTING');
  });

  it('creates a key when none exists', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ result: 'success' }, { setCookie: COOKIES }))
      .mockResolvedValueOnce(res({ data: [] }))              // list: empty
      .mockResolvedValueOnce(res({ token: 'app-NEW' }, { status: 201 })); // create
    const c = new DifyConsoleClient(makeConfig());
    expect(await c.getOrCreateAppKey('a1')).toBe('app-NEW');
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('POST');
  });

  it('reuses an existing key when create fails at the cap', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ result: 'success' }, { setCookie: COOKIES }))
      .mockResolvedValueOnce(res({ data: [] }))                                       // list: empty
      .mockResolvedValueOnce(res({ message: 'Maximum keys exceeded' }, { status: 400 })) // create -> cap
      .mockResolvedValueOnce(res({ data: [{ id: 'k1', token: 'app-CAPPED' }] }));     // re-list: now readable
    const c = new DifyConsoleClient(makeConfig());
    expect(await c.getOrCreateAppKey('a1')).toBe('app-CAPPED');
  });

  it('throws BotKeyUnavailableError when create fails and no readable key exists', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ result: 'success' }, { setCookie: COOKIES }))
      .mockResolvedValueOnce(res({ data: [] }))                                       // list: empty
      .mockResolvedValueOnce(res({ message: 'Maximum keys exceeded' }, { status: 400 })) // create -> cap
      .mockResolvedValueOnce(res({ data: [] }));                                      // re-list: still empty
    const c = new DifyConsoleClient(makeConfig());
    await expect(c.getOrCreateAppKey('a1')).rejects.toBeInstanceOf(BotKeyUnavailableError);
  });

  it('redacts app- tokens leaked in error bodies', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ result: 'success' }, { setCookie: COOKIES }))
      .mockResolvedValueOnce(res({ leaked: 'app-SECRETVALUE' }, { status: 500 }));
    const c = new DifyConsoleClient(makeConfig());
    const err = await c.getOrCreateAppKey('a1').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('app-[REDACTED]');
    expect((err as Error).message).not.toContain('SECRETVALUE');
  });

  it('deduplicates concurrent authentication (single login for concurrent first requests)', async () => {
    let loginCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/login')) {
        loginCalls++;
        return Promise.resolve(res({ result: 'success' }, { setCookie: COOKIES }));
      }
      return Promise.resolve(res({ data: [] }));
    });
    const c = new DifyConsoleClient(makeConfig());
    await Promise.all([c.listChatApps(), c.listChatApps(), c.listChatApps()]);
    expect(loginCalls).toBe(1);
  });

  it('deduplicates concurrent refresh on 401 without redundant login', async () => {
    let loginCalls = 0;
    let refreshCalls = 0;
    let expired = false;
    let expiredAppsHits = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/login')) {
        loginCalls++;
        return Promise.resolve(res({ result: 'success' }, { setCookie: COOKIES }));
      }
      if (url.endsWith('/refresh-token')) {
        refreshCalls++;
        // Single-use rotating token: the first refresh rotates it; a second
        // concurrent refresh with the now-consumed token would 401.
        if (refreshCalls > 1) return Promise.resolve(res({ code: 'unauthorized' }, { status: 401 }));
        return Promise.resolve(res({ result: 'success' }, { setCookie: COOKIES }));
      }
      // apps endpoint: once "expired", the first two concurrent hits 401, then succeed.
      if (expired) {
        expiredAppsHits++;
        if (expiredAppsHits <= 2) return Promise.resolve(res({ code: 'unauthorized' }, { status: 401 }));
      }
      return Promise.resolve(res({ data: [] }));
    });
    const c = new DifyConsoleClient(makeConfig());
    // Prime cookies with an initial successful call.
    await c.listChatApps();
    expired = true; // now the access token has expired
    await Promise.all([c.listChatApps(), c.listChatApps()]);
    // Only one login (the initial prime); the 401 storm is handled by a single shared refresh.
    expect(loginCalls).toBe(1);
    expect(refreshCalls).toBe(1);
  });

  it('refreshes once on 401 then retries', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ result: 'success' }, { setCookie: COOKIES })) // login
      .mockResolvedValueOnce(res({ code: 'unauthorized' }, { status: 401 }))     // apps -> 401
      .mockResolvedValueOnce(res({ result: 'success' }, { setCookie: COOKIES })) // refresh
      .mockResolvedValueOnce(res({ data: [{ id: 'a1', name: 'C', mode: 'chat' }] })); // retry apps
    const c = new DifyConsoleClient(makeConfig());
    const apps = await c.listChatApps();
    expect(apps).toHaveLength(1);
    expect((fetchMock.mock.calls[2][0] as string)).toContain('/refresh-token');
  });
});
