import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { validateEnv, envSchema, configuredProviderGroups } from './env.schema';

/**
 * UMA VAR QUE O SCHEMA CONHECE MAS O CONTÊINER NUNCA VÊ É UM INTERRUPTOR DE
 * MENTIRA. O `docker-compose.prod.yml` não usa `env_file`: ele lista cada
 * variável à mão em `environment:`. O que não estiver lá não chega ao processo
 * — a var definida no painel do Dokploy simplesmente não existe dentro do
 * contêiner, o zod aplica o default e nada no boot avisa. Já aconteceu uma vez
 * com GOZAP_WEBHOOK_DEBUG (está escrito no próprio compose).
 *
 * Aqui isso não é sujeira de configuração, é segurança: o passo final da
 * migração do C20 ("feche a query, o segredo já viaja no cabeçalho") é
 * exatamente definir GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN=false. Se ela não for
 * encaminhada, o operador segue o runbook, vê o deploy verde e acredita ter
 * fechado uma porta que continua aceitando `?t=<segredo>`.
 */
describe('docker-compose.prod.yml encaminha as envs do webhook do GoZap', () => {
  // vitest roda com root em `backend/` (CI: `cd backend && bun run test`).
  const compose = readFileSync(
    resolve(process.cwd(), '..', 'docker-compose.prod.yml'),
    'utf8',
  );

  /** Recorta o bloco `environment:` de um serviço de primeiro nível. */
  function serviceEnvBlock(service: string): string {
    const lines = compose.split('\n');
    const start = lines.findIndex((l) => l === `  ${service}:`);
    expect(start, `serviço ${service} não encontrado`).toBeGreaterThan(-1);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^ {2}\S/.test(l));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n');
  }

  it.each(['api', 'worker'])(
    'serviço %s recebe GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN',
    (service) => {
      expect(serviceEnvBlock(service)).toMatch(
        /^\s+GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN:/m,
      );
    },
  );

  it('serviço api recebe o segredo e a flag de debug do webhook do GoZap', () => {
    const env = serviceEnvBlock('api');
    expect(env).toMatch(/^\s+GOZAP_WEBHOOK_TOKEN:/m);
    expect(env).toMatch(/^\s+GOZAP_WEBHOOK_DEBUG:/m);
  });
});

describe('validateEnv', () => {
  // Base env satisfies the `meta` provider group. Tests that want to exercise
  // Evolution or Twilio instead swap in that group's own vars explicitly —
  // there is no single WHATSAPP_PROVIDER selector to flip anymore.
  const baseEnv = {
    DATABASE_URL: 'postgresql://u:p@h:5432/d',
    JWT_SECRET: 'a'.repeat(32),
    APP_BASE_URL: 'http://localhost:5173',
    WEBHOOK_BASE_URL: 'http://localhost:3000',
    CORS_ORIGIN: 'http://localhost:5173',
    META_ACCESS_TOKEN: 'meta-token',
    META_PHONE_NUMBER_ID: '123',
    META_APP_SECRET: 'meta-secret',
    META_WEBHOOK_VERIFY_TOKEN: 'verify',
  };

  it('parses valid env', () => {
    const result = validateEnv(baseEnv);
    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(3000);
  });

  it('throws on missing JWT_SECRET', () => {
    expect(() => validateEnv({ ...baseEnv, JWT_SECRET: undefined })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('throws on JWT_SECRET shorter than 32', () => {
    expect(() => validateEnv({ ...baseEnv, JWT_SECRET: 'short' })).toThrow();
  });

  it('coerces PORT from string', () => {
    const result = validateEnv({ ...baseEnv, PORT: '4000' });
    expect(result.PORT).toBe(4000);
  });

  // Provider credentials are validated by GROUP now (not by WHATSAPP_PROVIDER):
  // any non-empty var in a group makes the whole group required, and at least
  // one group must be fully configured.

  it('requires the rest of the Meta group when one Meta var is missing', () => {
    expect(() =>
      validateEnv({ ...baseEnv, META_ACCESS_TOKEN: undefined }),
    ).toThrow(/META_ACCESS_TOKEN/);
  });

  it('requires the full Evolution group when any Evolution var is set', () => {
    // A lone EVOLUTION_API_KEY makes the whole Evolution group required even
    // though the Meta group is complete.
    expect(() => validateEnv({ ...baseEnv, EVOLUTION_API_KEY: 'k' })).toThrow(
      /EVOLUTION_BASE_URL/,
    );
  });

  it('requires the full Twilio group when any Twilio var is set', () => {
    expect(() =>
      validateEnv({ ...baseEnv, TWILIO_AUTH_TOKEN: 'auth-token' }),
    ).toThrow(/TWILIO_ACCOUNT_SID/);
  });

  it('requires the full Zernio group when any Zernio var is set', () => {
    expect(() => validateEnv({ ...baseEnv, ZERNIO_API_KEY: 'k' })).toThrow(
      /ZERNIO_WEBHOOK_SECRET/,
    );
  });

  it('boots with ONLY the Zernio group configured (no Meta)', () => {
    const result = validateEnv({
      DATABASE_URL: 'postgresql://u:p@h:5432/d',
      JWT_SECRET: 'a'.repeat(32),
      APP_BASE_URL: 'http://localhost:5173',
      WEBHOOK_BASE_URL: 'http://localhost:3000',
      CORS_ORIGIN: 'http://localhost:5173',
      ZERNIO_API_KEY: 'k',
      ZERNIO_WEBHOOK_SECRET: 'wh-secret',
    });
    expect(result.ZERNIO_API_KEY).toBe('k');
  });

  it('accepts multiple complete groups (Meta + Zernio)', () => {
    const result = validateEnv({
      ...baseEnv,
      ZERNIO_API_KEY: 'k',
      ZERNIO_WEBHOOK_SECRET: 'wh-secret',
    });
    expect(result.ZERNIO_API_KEY).toBe('k');
  });

  it('rejects a Zernio group missing WEBHOOK_SECRET even when BASE_URL is set', () => {
    // ZERNIO_BASE_URL is excluded from the group's presence/completeness
    // check (it defaults) — setting it does not exempt API_KEY/WEBHOOK_SECRET.
    expect(() =>
      validateEnv({
        ...baseEnv,
        ZERNIO_API_KEY: 'k',
        ZERNIO_BASE_URL: 'https://custom.zernio.example.com/api/v1',
      }),
    ).toThrow(/ZERNIO_WEBHOOK_SECRET/);
  });

  it('boots with ONLY the Evolution group configured (no Meta)', () => {
    const result = validateEnv({
      DATABASE_URL: 'postgresql://u:p@h:5432/d',
      JWT_SECRET: 'a'.repeat(32),
      APP_BASE_URL: 'http://localhost:5173',
      WEBHOOK_BASE_URL: 'http://localhost:3000',
      CORS_ORIGIN: 'http://localhost:5173',
      EVOLUTION_BASE_URL: 'http://localhost:8080',
      EVOLUTION_API_KEY: 'k',
      EVOLUTION_INSTANCE_NAME: 'picoa-dev',
    });
    expect(result.EVOLUTION_INSTANCE_NAME).toBe('picoa-dev');
  });

  it('throws when NO provider group is fully configured', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://u:p@h:5432/d',
        JWT_SECRET: 'a'.repeat(32),
        APP_BASE_URL: 'http://localhost:5173',
        WEBHOOK_BASE_URL: 'http://localhost:3000',
        CORS_ORIGIN: 'http://localhost:5173',
        // no meta / evolution / twilio credentials at all
      }),
    ).toThrow(/provider group/i);
  });

  it('attaches the no-group-configured error to a synthetic `providers` path, not a removed WHATSAPP_PROVIDER field', () => {
    // There is no single-selector field to blame anymore — the invariant is
    // cross-group ("at least one of meta/evolution/twilio"), so it can't be
    // attached to a real env var.
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://u:p@h:5432/d',
      JWT_SECRET: 'a'.repeat(32),
      APP_BASE_URL: 'http://localhost:5173',
      WEBHOOK_BASE_URL: 'http://localhost:3000',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.join('.') === 'providers'),
      ).toBe(true);
    }
  });

  it('rejects a partial group even when another group is complete', () => {
    // Meta complete + a stray EVOLUTION_BASE_URL (incomplete Evolution group).
    expect(() =>
      validateEnv({ ...baseEnv, EVOLUTION_BASE_URL: 'http://localhost:8080' }),
    ).toThrow(/EVOLUTION_API_KEY/);
  });

  it('accepts multiple complete groups (Meta + Twilio)', () => {
    const result = validateEnv({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      TWILIO_AUTH_TOKEN: 'auth-token',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    });
    expect(result.TWILIO_ACCOUNT_SID).toBe(
      'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    );
  });

  it('treats empty strings (compose ${VAR:-}) as absent, not partial', () => {
    // Meta complete; all Evolution vars forwarded as '' → group is absent, not
    // a partial group that would fail the boot.
    expect(() =>
      validateEnv({
        ...baseEnv,
        EVOLUTION_BASE_URL: '',
        EVOLUTION_API_KEY: '',
        EVOLUTION_INSTANCE_NAME: '',
      }),
    ).not.toThrow();
  });

  it('treats empty Zernio strings (compose ${VAR:-}) as absent, not partial', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ZERNIO_API_KEY: '',
        ZERNIO_BASE_URL: '',
        ZERNIO_WEBHOOK_SECRET: '',
      }),
    ).not.toThrow();
  });

  it('completes the Twilio group via TWILIO_MESSAGING_SERVICE_SID (no FROM)', () => {
    const result = validateEnv({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      TWILIO_AUTH_TOKEN: 'auth-token',
      TWILIO_MESSAGING_SERVICE_SID: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    });
    expect(result.TWILIO_MESSAGING_SERVICE_SID).toBe(
      'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    );
  });

  it('rejects a Twilio group missing BOTH sender fields', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        TWILIO_AUTH_TOKEN: 'auth-token',
        // neither TWILIO_WHATSAPP_FROM nor TWILIO_MESSAGING_SERVICE_SID
      }),
    ).toThrow(/TWILIO_WHATSAPP_FROM|TWILIO_MESSAGING_SERVICE_SID/);
  });

  it('accepts a full Twilio config', () => {
    const result = validateEnv({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      TWILIO_AUTH_TOKEN: 'auth-token',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    });
    expect(result.TWILIO_ACCOUNT_SID).toBe(
      'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    );
    expect(result.TWILIO_WHATSAPP_FROM).toBe('whatsapp:+14155238886');
  });

  it('accepts an empty TWILIO_WEBHOOK_URL without crashing (compose forwards "" by default)', () => {
    // Regression: a `.url()` here rejected the empty default and crash-looped
    // the app on boot. It must parse.
    expect(() =>
      validateEnv({
        ...baseEnv,
        TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        TWILIO_AUTH_TOKEN: 'auth-token',
        TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
        TWILIO_WEBHOOK_URL: '',
      }),
    ).not.toThrow();
  });

  it('keeps a provided TWILIO_WEBHOOK_URL', () => {
    expect(
      validateEnv({
        ...baseEnv,
        TWILIO_WEBHOOK_URL: 'https://picoa.app.br/api/webhooks/twilio',
      }).TWILIO_WEBHOOK_URL,
    ).toBe('https://picoa.app.br/api/webhooks/twilio');
  });

  describe('CORS_ORIGIN', () => {
    it('rejects an empty value', () => {
      expect(() => validateEnv({ ...baseEnv, CORS_ORIGIN: '' })).toThrow(
        /CORS_ORIGIN/,
      );
    });

    it('rejects a whitespace-only value', () => {
      expect(() => validateEnv({ ...baseEnv, CORS_ORIGIN: '   ' })).toThrow(
        /CORS_ORIGIN/,
      );
    });

    it('rejects a non-URL value', () => {
      expect(() =>
        validateEnv({ ...baseEnv, CORS_ORIGIN: 'not a url' }),
      ).toThrow(/CORS_ORIGIN/);
    });

    it('rejects a comma list where one entry is not a URL', () => {
      expect(() =>
        validateEnv({
          ...baseEnv,
          CORS_ORIGIN: 'http://localhost:5173, garbage',
        }),
      ).toThrow(/CORS_ORIGIN/);
    });

    it('accepts a single valid origin', () => {
      const result = validateEnv({
        ...baseEnv,
        CORS_ORIGIN: 'https://picoa.app.br',
      });
      expect(result.CORS_ORIGIN).toBe('https://picoa.app.br');
    });

    it('accepts a comma-separated list of valid origins', () => {
      const result = validateEnv({
        ...baseEnv,
        CORS_ORIGIN: 'https://picoa.app.br, http://localhost:5173',
      });
      expect(result.CORS_ORIGIN).toBe(
        'https://picoa.app.br, http://localhost:5173',
      );
    });
  });

  describe('BULL_BOARD_PASSWORD', () => {
    it('rejects the placeholder default in production', () => {
      expect(() =>
        validateEnv({
          ...baseEnv,
          NODE_ENV: 'production',
          BULL_BOARD_PASSWORD: 'changeme123',
        }),
      ).toThrow(/BULL_BOARD_PASSWORD/);
    });

    it('rejects an empty value in production', () => {
      expect(() =>
        validateEnv({
          ...baseEnv,
          NODE_ENV: 'production',
          BULL_BOARD_PASSWORD: '',
        }),
      ).toThrow(/BULL_BOARD_PASSWORD/);
    });

    it('accepts a real password in production', () => {
      const result = validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        BULL_BOARD_PASSWORD: 'a-strong-real-password',
      });
      expect(result.BULL_BOARD_PASSWORD).toBe('a-strong-real-password');
    });

    it('keeps working in development with the placeholder default', () => {
      const result = validateEnv({ ...baseEnv });
      expect(result.NODE_ENV).toBe('development');
      expect(result.BULL_BOARD_PASSWORD).toBe('changeme123');
    });
  });
});

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  APP_BASE_URL: 'http://localhost:3000',
  WEBHOOK_BASE_URL: 'http://localhost:3000',
  CORS_ORIGIN: 'http://localhost:5173',
  EVOLUTION_BASE_URL: 'http://localhost:8080',
  EVOLUTION_API_KEY: 'k',
  EVOLUTION_INSTANCE_NAME: 'picoa-dev',
};

describe('envSchema EVOLUTION_PROXY_*', () => {
  const evo = {
    ...base,
    EVOLUTION_PROXY_HOST: '203.0.113.77',
    EVOLUTION_PROXY_PORT: '10527',
    EVOLUTION_PROXY_PROTOCOL: 'socks5',
    EVOLUTION_PROXY_USERNAME: 'u',
    EVOLUTION_PROXY_PASSWORD: 'p',
  };

  it('parseia uma config de proxy completa', () => {
    const r = envSchema.safeParse(evo);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.EVOLUTION_PROXY_PROTOCOL).toBe('socks5');
  });

  it('é opcional — sem proxy o boot continua', () => {
    expect(envSchema.safeParse(base).success).toBe(true);
  });

  it('trata o default vazio do compose (${VAR:-}) como ausente e NÃO quebra o boot', () => {
    // Regressão: um z.enum cru rejeitaria '' e crash-loopava a api+worker.
    const r = envSchema.safeParse({
      ...base,
      EVOLUTION_PROXY_HOST: '',
      EVOLUTION_PROXY_PORT: '',
      EVOLUTION_PROXY_PROTOCOL: '',
      EVOLUTION_PROXY_USERNAME: '',
      EVOLUTION_PROXY_PASSWORD: '',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.EVOLUTION_PROXY_PROTOCOL).toBeUndefined();
  });

  it('rejeita um protocolo inválido', () => {
    const r = envSchema.safeParse({ ...evo, EVOLUTION_PROXY_PROTOCOL: 'quic' });
    expect(r.success).toBe(false);
  });
});

describe('envSchema DIFY_BASE_URL', () => {
  it('is optional — parses fine when absent', () => {
    const r = envSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('accepts a valid Dify base url', () => {
    const r = envSchema.safeParse({
      ...base,
      DIFY_BASE_URL: 'https://dify.picoa.app.br/v1',
    });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.DIFY_BASE_URL).toBe('https://dify.picoa.app.br/v1');
  });

  it('treats an empty string as absent (compose ${DIFY_BASE_URL:-} when unset)', () => {
    // Regression: an empty string used to hit `.url()` and crash the app at
    // boot ("DIFY_BASE_URL: Invalid URL") on deploys without the var set.
    const r = envSchema.safeParse({ ...base, DIFY_BASE_URL: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.DIFY_BASE_URL).toBeUndefined();
  });

  it('rejects a non-url DIFY_BASE_URL', () => {
    const r = envSchema.safeParse({ ...base, DIFY_BASE_URL: 'not-a-url' });
    expect(r.success).toBe(false);
  });
});

describe('envSchema ZERNIO_BASE_URL', () => {
  it('defaults to https://zernio.com/api/v1 when unset', () => {
    const r = envSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.ZERNIO_BASE_URL).toBe('https://zernio.com/api/v1');
  });

  it('treats an empty string as absent and falls back to the default (compose ${ZERNIO_BASE_URL:-})', () => {
    // Regression: a bare `.url()` would reject the empty default and crash
    // boot, same class of bug already fixed for DIFY_BASE_URL/EVOLUTION_BASE_URL.
    const r = envSchema.safeParse({ ...base, ZERNIO_BASE_URL: '' });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.ZERNIO_BASE_URL).toBe('https://zernio.com/api/v1');
  });

  it('keeps a provided (custom) ZERNIO_BASE_URL', () => {
    const r = envSchema.safeParse({
      ...base,
      ZERNIO_BASE_URL: 'https://custom.zernio.example.com/api/v1',
    });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.ZERNIO_BASE_URL).toBe(
        'https://custom.zernio.example.com/api/v1',
      );
  });

  it('rejects a non-url ZERNIO_BASE_URL', () => {
    const r = envSchema.safeParse({ ...base, ZERNIO_BASE_URL: 'not-a-url' });
    expect(r.success).toBe(false);
  });
});

// F-A Task 3: the GOZAP_* group is all-or-nothing (4 vars), exactly like the
// other provider groups — the tests below prove both halves of the safety
// contract: a deploy with NONE of the vars boots untouched (inertia), and a
// deploy with SOME but not ALL of them fails LOUD at boot (never silently).
describe('envSchema GOZAP_*', () => {
  const fullGozap = {
    GOZAP_BASE_URL: 'https://tenant.gozap.dev',
    GOZAP_ADMIN_TOKEN: 'admin-token',
    GOZAP_WEBHOOK_TOKEN: 'webhook-token',
    GOZAP_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  };

  it('is optional — boots fine (via the Evolution group in `base`) without any GOZAP_* var', () => {
    // Inertia: no GOZAP_* var set at all → the schema parses clean and the
    // deploy is unaffected (this is the "deploy without GoZap credentials"
    // scenario the whole task exists to keep safe).
    const r = envSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('boots with ONLY the GoZap group configured (no Evolution/Meta/Twilio/Zernio)', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'postgresql://u:p@h:5432/d',
      JWT_SECRET: 'a'.repeat(32),
      APP_BASE_URL: 'http://localhost:5173',
      WEBHOOK_BASE_URL: 'http://localhost:3000',
      CORS_ORIGIN: 'http://localhost:5173',
      ...fullGozap,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.GOZAP_BASE_URL).toBe('https://tenant.gozap.dev');
      expect(r.data.GOZAP_TOKEN_ENCRYPTION_KEY).toBe('a'.repeat(64));
    }
  });

  it.each([
    ['GOZAP_BASE_URL', { GOZAP_BASE_URL: 'https://tenant.gozap.dev' }],
    ['GOZAP_ADMIN_TOKEN', { GOZAP_ADMIN_TOKEN: 'admin-token' }],
    ['GOZAP_WEBHOOK_TOKEN', { GOZAP_WEBHOOK_TOKEN: 'webhook-token' }],
    [
      'GOZAP_TOKEN_ENCRYPTION_KEY',
      { GOZAP_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) },
    ],
  ])(
    'FAILS BOOT (does not pass in silence) when only %s is set — the group is all-or-nothing',
    (_label, partial) => {
      expect(() => validateEnv({ ...base, ...partial })).toThrow();
      const r = envSchema.safeParse({ ...base, ...partial });
      expect(r.success).toBe(false);
    },
  );

  it('treats empty GOZAP_* strings (compose ${VAR:-} default) as absent, not partial', () => {
    const r = envSchema.safeParse({
      ...base,
      GOZAP_BASE_URL: '',
      GOZAP_ADMIN_TOKEN: '',
      GOZAP_WEBHOOK_TOKEN: '',
      GOZAP_TOKEN_ENCRYPTION_KEY: '',
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty GOZAP_BASE_URL alone without crashing `.url()` (compose default)', () => {
    // Regression guard for the exact bug the task brief calls out: a bare
    // `.url()` on the compose's empty-string default would crash-loop boot.
    const r = envSchema.safeParse({ ...base, GOZAP_BASE_URL: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.GOZAP_BASE_URL).toBeUndefined();
  });

  it('rejects a non-url GOZAP_BASE_URL', () => {
    const r = envSchema.safeParse({
      ...base,
      ...fullGozap,
      GOZAP_BASE_URL: 'not-a-url',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed GOZAP_TOKEN_ENCRYPTION_KEY (must be 64 hex chars — AES-256-GCM key)', () => {
    expect(() =>
      validateEnv({
        ...base,
        ...fullGozap,
        GOZAP_TOKEN_ENCRYPTION_KEY: 'not-a-valid-hex-key',
      }),
    ).toThrow(/GOZAP_TOKEN_ENCRYPTION_KEY/);
  });

  it('rejects a GOZAP_TOKEN_ENCRYPTION_KEY that is hex but the wrong length', () => {
    expect(() =>
      validateEnv({
        ...base,
        ...fullGozap,
        GOZAP_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(16), // 32 hex chars = 16 bytes, not 32
      }),
    ).toThrow(/GOZAP_TOKEN_ENCRYPTION_KEY/);
  });

  it('GOZAP_WEBHOOK_DEBUG defaults to false and never affects group completeness', () => {
    const r = envSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.GOZAP_WEBHOOK_DEBUG).toBe(false);
  });

  /**
   * Esta flag despeja o payload CRU do webhook no log — telefone e texto do
   * eleitor. `z.coerce.boolean()` é `Boolean(v)`: toda string não-vazia vira
   * `true`, inclusive `'false'`, `'0'` e `'no'`. Um operador "desligando" o
   * debug com `false` no painel estaria LIGANDO o despejo. Só `1`/`true` ligam.
   */
  it.each([
    ['1', true],
    ['true', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['', false],
    [undefined, false],
  ])('GOZAP_WEBHOOK_DEBUG=%s → %s', (input, expected) => {
    const r = envSchema.safeParse({ ...base, GOZAP_WEBHOOK_DEBUG: input });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.GOZAP_WEBHOOK_DEBUG).toBe(expected);
  });

  /**
   * O interruptor que ENCERRA a transição do C20 (segredo do webhook na query,
   * gravado em texto claro no access log). Enquanto o painel do GoZap não for
   * reconfigurado para o cabeçalho, a query TEM de continuar autenticando —
   * então o default é `true` e a string vazia (o que o docker-compose entrega
   * com `${VAR:-}` quando a env não existe) também é `true`. Só uma negativa
   * explícita desliga: um deploy que "não configurou" jamais pode virar um
   * deploy que recusa todo webhook de entrada em silêncio.
   */
  it.each([
    ['false', false],
    ['0', false],
    ['no', false],
    [false, false],
    // Digitado no painel do Dokploy por gente, não por máquina: caixa alta,
    // caixa mista e espaço colado no fim são o que de fato acontece. Se
    // `FALSE` não desligasse, o operador cumpriria o passo 5 do OPERATIONS.md,
    // veria o deploy verde e acreditaria ter fechado a porta que continua
    // aberta — não há erro de boot nem log que o contradiga.
    ['FALSE', false],
    ['False', false],
    [' false ', false],
    ['NO', false],
    ['off', false],
    ['OFF', false],
    ['true', true],
    ['1', true],
    ['', true],
    ['   ', true],
    [undefined, true],
  ])('GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN=%s → %s', (input, expected) => {
    const r = envSchema.safeParse({
      ...base,
      GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN: input,
    });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN).toBe(expected);
  });

  it('GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN não entra na completude do grupo GOZAP', () => {
    // Desligar a compat não pode fazer um deploy sem GoZap virar "GoZap
    // parcialmente configurado" e quebrar o boot.
    expect(() =>
      validateEnv({ ...base, GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN: 'false' }),
    ).not.toThrow();
  });

  it('PUBLIC_WEBHOOK_BASE_URL é opcional, tolera "" e rejeita lixo', () => {
    expect(envSchema.safeParse(base).success).toBe(true);
    const vazio = envSchema.safeParse({ ...base, PUBLIC_WEBHOOK_BASE_URL: '' });
    expect(vazio.success).toBe(true);
    if (vazio.success)
      expect(vazio.data.PUBLIC_WEBHOOK_BASE_URL).toBeUndefined();

    const ok = envSchema.safeParse({
      ...base,
      PUBLIC_WEBHOOK_BASE_URL: 'https://picoa.app.br/api',
    });
    expect(ok.success).toBe(true);

    expect(
      envSchema.safeParse({ ...base, PUBLIC_WEBHOOK_BASE_URL: 'nao-e-url' })
        .success,
    ).toBe(false);
  });
});

describe('envSchema DIFY_CONSOLE_*', () => {
  it('é opcional — parseia sem as vars', () => {
    expect(envSchema.safeParse(base).success).toBe(true);
  });
  it('aceita console url/email/password', () => {
    const r = envSchema.safeParse({
      ...base,
      DIFY_CONSOLE_URL: 'https://bot.picoa.app.br/console/api',
      DIFY_CONSOLE_EMAIL: 'admin@example.com',
      DIFY_CONSOLE_PASSWORD: 'secret',
    });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.DIFY_CONSOLE_URL).toBe(
        'https://bot.picoa.app.br/console/api',
      );
  });
  it('trata string vazia como ausente (compose ${VAR:-})', () => {
    const r = envSchema.safeParse({
      ...base,
      DIFY_CONSOLE_URL: '',
      DIFY_CONSOLE_PASSWORD: '',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.DIFY_CONSOLE_URL).toBeUndefined();
      expect(r.data.DIFY_CONSOLE_PASSWORD).toBeUndefined();
    }
  });
});

describe('configuredProviderGroups', () => {
  const meta = {
    META_ACCESS_TOKEN: 't',
    META_PHONE_NUMBER_ID: '1',
    META_APP_SECRET: 's',
    META_WEBHOOK_VERIFY_TOKEN: 'v',
  };
  const evolution = {
    EVOLUTION_BASE_URL: 'http://localhost:8080',
    EVOLUTION_API_KEY: 'k',
    EVOLUTION_INSTANCE_NAME: 'picoa-dev',
  };
  const twilioFrom = {
    TWILIO_ACCOUNT_SID: 'AC',
    TWILIO_AUTH_TOKEN: 'tok',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+1',
  };
  const zernio = {
    ZERNIO_API_KEY: 'k',
    ZERNIO_WEBHOOK_SECRET: 'wh-secret',
  };
  const gozap = {
    GOZAP_BASE_URL: 'https://tenant.gozap.dev',
    GOZAP_ADMIN_TOKEN: 't',
    GOZAP_WEBHOOK_TOKEN: 'w',
    GOZAP_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  };

  it('returns [] when nothing is configured', () => {
    expect(configuredProviderGroups({})).toEqual([]);
  });

  it('lists only fully-configured groups', () => {
    expect(configuredProviderGroups(meta)).toEqual(['meta']);
    expect(configuredProviderGroups(evolution)).toEqual(['evolution']);
    expect(configuredProviderGroups(twilioFrom)).toEqual(['twilio']);
    expect(configuredProviderGroups(zernio)).toEqual(['zernio']);
    expect(configuredProviderGroups(gozap)).toEqual(['gozap']);
  });

  it('lists all complete groups when several are configured', () => {
    expect(
      configuredProviderGroups({
        ...meta,
        ...evolution,
        ...twilioFrom,
        ...zernio,
        ...gozap,
      }).sort(),
    ).toEqual(['evolution', 'gozap', 'meta', 'twilio', 'zernio']);
  });

  it('excludes a partially-configured group', () => {
    // Evolution complete + a stray Meta token (partial) → only evolution.
    expect(
      configuredProviderGroups({ ...evolution, META_ACCESS_TOKEN: 't' }),
    ).toEqual(['evolution']);
  });

  it('excludes a partially-configured Zernio group (only API_KEY set)', () => {
    expect(configuredProviderGroups({ ...meta, ZERNIO_API_KEY: 'k' })).toEqual([
      'meta',
    ]);
  });

  // ★ Inertia proof (F-A Task 3): a deploy with NO GOZAP_* var configured
  // must not report 'gozap' as configured — this is what keeps the module
  // factory (whatsapp-providers.module.ts) from registering the adapter, so
  // a deploy without GoZap credentials stays completely unaffected by this
  // task. The symmetric "with the full group it DOES resolve" half is
  // covered by `lists only fully-configured groups` above (gozap → ['gozap'])
  // and by provider-registry.service.spec.ts's GOZAP block, which simulates
  // the module's actual `configured.has('gozap') ? map.set(...) : …` wiring.
  it('excludes GOZAP entirely when no GOZAP_* var is set (deploy without GoZap stays inert)', () => {
    expect(configuredProviderGroups({ ...meta, ...evolution })).not.toContain(
      'gozap',
    );
  });

  it('excludes a partially-configured GOZAP group (only ADMIN_TOKEN + WEBHOOK_TOKEN set)', () => {
    expect(
      configuredProviderGroups({
        ...meta,
        GOZAP_ADMIN_TOKEN: 't',
        GOZAP_WEBHOOK_TOKEN: 'w',
      }),
    ).toEqual(['meta']);
  });

  it('treats empty strings as absent (not partial)', () => {
    expect(
      configuredProviderGroups({
        ...meta,
        EVOLUTION_BASE_URL: '',
        EVOLUTION_API_KEY: '',
        EVOLUTION_INSTANCE_NAME: '',
      }),
    ).toEqual(['meta']);
  });

  it('treats empty GOZAP_* strings as absent (compose ${VAR:-})', () => {
    expect(
      configuredProviderGroups({
        ...meta,
        GOZAP_BASE_URL: '',
        GOZAP_ADMIN_TOKEN: '',
        GOZAP_WEBHOOK_TOKEN: '',
        GOZAP_TOKEN_ENCRYPTION_KEY: '',
      }),
    ).toEqual(['meta']);
  });

  it('does not consider ZERNIO_BASE_URL when deciding Zernio presence', () => {
    // BASE_URL is deliberately excluded from the group's key set (it has a
    // schema default) — setting it alone must not flag the group as present.
    expect(
      configuredProviderGroups({
        ...meta,
        ZERNIO_BASE_URL: 'https://custom.zernio.example.com/api/v1',
      }),
    ).toEqual(['meta']);
  });

  it('accepts Twilio configured via a Messaging Service SID (no FROM)', () => {
    expect(
      configuredProviderGroups({
        TWILIO_ACCOUNT_SID: 'AC',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_MESSAGING_SERVICE_SID: 'MG',
      }),
    ).toEqual(['twilio']);
  });

  it('gozapGroupState: presente e completo com o grupo inteiro', () => {
    const full = {
      GOZAP_BASE_URL: 'https://x.gozap.dev',
      GOZAP_ADMIN_TOKEN: 't',
      GOZAP_WEBHOOK_TOKEN: 'w',
      GOZAP_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    };
    expect(configuredProviderGroups(full)).toContain('gozap');
    expect(configuredProviderGroups({ GOZAP_ADMIN_TOKEN: 't' })).not.toContain(
      'gozap',
    ); // parcial
  });
});

/**
 * ★ REVISÃO FINAL DA FASE B (crítico) — a validação ativa de números é
 * EXPLÍCITA (spec B.5). O cron diário só existe como OPT-IN, e as duas envs
 * que governam risco de bloqueio precisam sobreviver ao formato em que o
 * compose as entrega: `${VAR:-}` chega no container como STRING VAZIA, não
 * como ausente. `.default()` do zod só vale para `undefined` — um
 * `z.coerce.number().positive()` sobre `''` vira 0 e DERRUBA O BOOT (o mesmo
 * motivo do preprocess de ORG_PRIVACY_POLICY_URL).
 */
describe('validação ativa de números: envs de risco (Fase B)', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://u:p@h:5432/d',
    JWT_SECRET: 'a'.repeat(32),
    APP_BASE_URL: 'http://localhost:5173',
    WEBHOOK_BASE_URL: 'http://localhost:3000',
    CORS_ORIGIN: 'http://localhost:5173',
    META_ACCESS_TOKEN: 'meta-token',
    META_PHONE_NUMBER_ID: '123',
    META_APP_SECRET: 'meta-secret',
    META_WEBHOOK_VERIFY_TOKEN: 'verify',
  };

  it('CONTACT_SYNC_CRON_ENABLED: padrão DESLIGADO', () => {
    expect(validateEnv(baseEnv).CONTACT_SYNC_CRON_ENABLED).toBe(false);
  });

  it('CONTACT_SYNC_CRON_ENABLED: só "true"/"1" ligam — "false" NÃO liga a varredura', () => {
    expect(
      validateEnv({ ...baseEnv, CONTACT_SYNC_CRON_ENABLED: 'true' })
        .CONTACT_SYNC_CRON_ENABLED,
    ).toBe(true);
    expect(
      validateEnv({ ...baseEnv, CONTACT_SYNC_CRON_ENABLED: '1' })
        .CONTACT_SYNC_CRON_ENABLED,
    ).toBe(true);
    for (const off of ['false', '0', 'no', '']) {
      expect(
        validateEnv({ ...baseEnv, CONTACT_SYNC_CRON_ENABLED: off })
          .CONTACT_SYNC_CRON_ENABLED,
      ).toBe(false);
    }
  });

  it('GOZAP_CHECK_RATE_PER_MIN vazio (o `${VAR:-}` do compose) cai no padrão 40 em vez de derrubar o boot', () => {
    expect(
      validateEnv({ ...baseEnv, GOZAP_CHECK_RATE_PER_MIN: '' })
        .GOZAP_CHECK_RATE_PER_MIN,
    ).toBe(40);
    expect(
      validateEnv({ ...baseEnv, GOZAP_CHECK_RATE_PER_MIN: '120' })
        .GOZAP_CHECK_RATE_PER_MIN,
    ).toBe(120);
  });
});
