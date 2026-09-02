import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../shared/config/env.schema';
import { DifyConsoleNotConfiguredError, BotKeyUnavailableError } from './errors/bot.errors';

const LOGIN_TIMEOUT_MS = 15_000;
const REQ_TIMEOUT_MS = 20_000;
const CHAT_MODES = new Set(['chat', 'agent-chat', 'advanced-chat']);

export type DifyApp = { id: string; name: string; mode: string };
type Cookies = { access: string; refresh: string; csrf: string };

@Injectable()
export class DifyConsoleClient {
  private cookies: Cookies | null = null;
  private authInFlight: Promise<void> | null = null;

  constructor(private readonly config: ConfigService<Env>) {}

  async listChatApps(): Promise<DifyApp[]> {
    const res = await this.request('GET', '/apps?page=1&limit=100');
    const data = (await res.json()) as { data?: Array<{ id: string; name: string; mode: string }> };
    return (data.data ?? [])
      .filter((a) => CHAT_MODES.has(a.mode))
      .map((a) => ({ id: a.id, name: a.name, mode: a.mode }));
  }

  async getOrCreateAppKey(appId: string): Promise<string> {
    const existing = await this.findReadableAppKey(appId);
    if (existing) return existing;
    // No readable token — try to create one. Apps at the per-app key cap will 400 here.
    try {
      const createRes = await this.request('POST', `/apps/${appId}/api-keys`, {});
      const created = (await createRes.json()) as { token?: string };
      if (created.token) return created.token;
    } catch {
      // fall through to re-list — the cap may have left a usable (but newly readable) token
    }
    const afterCreate = await this.findReadableAppKey(appId);
    if (afterCreate) return afterCreate;
    throw new BotKeyUnavailableError(appId);
  }

  private async findReadableAppKey(appId: string): Promise<string | null> {
    const listRes = await this.request('GET', `/apps/${appId}/api-keys`);
    const list = (await listRes.json()) as { data?: Array<{ token?: string }> };
    const found = list.data?.find((k) => typeof k.token === 'string' && k.token.startsWith('app-'));
    return found?.token ?? null;
  }

  private cfg(): { baseUrl: string; email: string; password: string } {
    const baseUrl = this.config.get('DIFY_CONSOLE_URL', { infer: true });
    const email = this.config.get('DIFY_CONSOLE_EMAIL', { infer: true });
    const password = this.config.get('DIFY_CONSOLE_PASSWORD', { infer: true });
    if (!baseUrl || !email || !password) throw new DifyConsoleNotConfiguredError();
    return { baseUrl, email, password };
  }

  private async request(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
    if (!this.cookies) await this.authenticate(() => this.login());
    const res = await this.rawFetch(method, path, body);
    if (res.status === 401 && retry) {
      await this.authenticate(async () => {
        const ok = await this.refresh();
        if (!ok) await this.login();
      });
      return this.request(method, path, body, false);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // The api-keys body can contain full app- service tokens — never leak them in errors.
      const safe = text.slice(0, 200).replace(/app-[A-Za-z0-9_-]+/g, 'app-[REDACTED]');
      throw new Error(`Dify console ${method} ${path} failed: ${res.status} ${safe}`);
    }
    return res;
  }

  private rawFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const { baseUrl } = this.cfg();
    const headers: Record<string, string> = {
      cookie: this.cookieHeader(),
      'x-csrf-token': this.cookies?.csrf ?? '',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
  }

  // Serialize authentication so concurrent requests share a single login/refresh
  // attempt instead of independently rotating (and clobbering) the shared cookies.
  private authenticate(attempt: () => Promise<void>): Promise<void> {
    if (!this.authInFlight) {
      this.authInFlight = attempt().finally(() => {
        this.authInFlight = null;
      });
    }
    return this.authInFlight;
  }

  private async login(): Promise<void> {
    const { baseUrl, email, password } = this.cfg();
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: Buffer.from(password, 'utf8').toString('base64') }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Dify console login failed: ${res.status}`);
    const parsed = this.parseCookies(res);
    if (!parsed) throw new Error('Dify console login returned no usable cookies');
    this.cookies = parsed;
  }

  private async refresh(): Promise<boolean> {
    try {
      const { baseUrl } = this.cfg();
      const res = await fetch(`${baseUrl}/refresh-token`, {
        method: 'POST',
        headers: { cookie: this.cookieHeader(), 'x-csrf-token': this.cookies?.csrf ?? '' },
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const rotated = this.parseCookies(res);
      if (rotated) this.cookies = rotated;
      return true;
    } catch {
      return false;
    }
  }

  private cookieHeader(): string {
    const c = this.cookies;
    if (!c) return '';
    return `__Host-access_token=${c.access}; __Host-refresh_token=${c.refresh}; __Host-csrf_token=${c.csrf}`;
  }

  private parseCookies(res: Response): Cookies | null {
    const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const get = (name: string): string | null => {
      for (const line of raw) {
        const m = line.match(new RegExp(`${name}=([^;]+)`));
        if (m) return m[1];
      }
      return null;
    };
    const merged: Cookies = {
      access: get('__Host-access_token') ?? this.cookies?.access ?? '',
      refresh: get('__Host-refresh_token') ?? this.cookies?.refresh ?? '',
      csrf: get('__Host-csrf_token') ?? this.cookies?.csrf ?? '',
    };
    if (!merged.access || !merged.csrf) return this.cookies; // keep prior if incomplete
    return merged;
  }
}
