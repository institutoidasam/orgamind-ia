import { describe, it, expect, beforeAll } from 'vitest';
import { Writable } from 'stream';
import pino from 'pino';
import { req as stdReqSerializer } from 'pino-std-serializers';
import { sanitizeReqForLog } from '../../shared/logging/pino-req-serializer';
import { TOKEN_HEADER } from './gozap-webhooks.controller';

/**
 * Preenche (sem sobrescrever) a env mínima que o `ConfigModule` valida no
 * import de `app.module`. Sem isto o import rejeita e o teste morre por um
 * motivo que não tem nada a ver com log.
 */
function applyTestEnvDefaults(webhookToken: string): void {
  const defaults: Record<string, string> = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-32ch',
    APP_BASE_URL: 'http://localhost:3000',
    WEBHOOK_BASE_URL: 'http://localhost:3000',
    CORS_ORIGIN: 'http://localhost:5173',
    // O schema exige um grupo de provedor COMPLETO; o do GoZap é o desta rota.
    GOZAP_BASE_URL: 'https://gozap.example.com',
    GOZAP_ADMIN_TOKEN: 'admin-token-de-teste',
    GOZAP_WEBHOOK_TOKEN: webhookToken,
    GOZAP_TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
    // Grupo Evolution (único provedor ligado): o schema exige o grupo completo.
    EVOLUTION_BASE_URL: 'http://evolution.test:8080',
    EVOLUTION_API_KEY: 'test-evolution-key',
    EVOLUTION_INSTANCE_NAME: 'test-instance',
  };
  for (const [key, value] of Object.entries(defaults)) {
    process.env[key] ??= value;
  }
}

/**
 * O SEGREDO NÃO PODE TROCAR DE LOG.
 *
 * O achado C20 tirou o `GOZAP_WEBHOOK_TOKEN` da query string — e a query já não
 * chega ao log (ver `pino-req-serializer.spec.ts`) nem ao access log do nginx.
 * Mas o caminho NOVO (o segredo num CABEÇALHO) só é uma melhora se o cabeçalho
 * também ficar fora do log: o `autoLogging` do pino-http grava `req.headers`
 * INTEIRO em toda resposta, 200 e 401, em nível `info` — que é o nível de
 * produção (docker-compose.prod.yml: LOG_LEVEL=info). Sem redação, o receptor
 * passaria a gravar em texto claro, no log do contêiner `api`, exatamente o
 * segredo que a mudança existe para esconder — e o log da `api` é o que a API
 * do Dokploy expõe. Quem o lê forja ack de entrega e opt-out de eleitor.
 *
 * Por isso este teste NÃO reimplementa a config: ele monta um pino REAL com a
 * lista de `redact` de produção (`LOG_REDACT_PATHS`, importada de app.module) e
 * com o serializer real, serializa um request como o pino-http serializaria, e
 * exige que o segredo não apareça em NENHUM lugar da linha de log. Se alguém
 * trocar o nome do cabeçalho no controller sem atualizar a lista, ou apagar uma
 * entrada da lista, este teste fica vermelho.
 */
describe('segredo de webhook não pode aparecer no log da aplicação', () => {
  const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f7081';

  let redactPaths: string[];

  beforeAll(async () => {
    // `app.module` importa o ConfigModule, que valida a env no import.
    applyTestEnvDefaults(SECRET);
    ({ LOG_REDACT_PATHS: redactPaths } = await import('../../app.module.js'));
  });

  /** Reproduz a cadeia do pino-http: serializer padrão → o nosso → pino. */
  function logRequest(headers: Record<string, string>): string {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = pino(
      {
        level: 'info',
        redact: redactPaths,
        serializers: { req: sanitizeReqForLog },
      },
      dest,
    );
    // `stdReqSerializer` é o mesmo de `pino-std-serializers` que o pino-http
    // aplica antes do nosso — ele é quem copia headers e originalUrl.
    const serialized = stdReqSerializer({
      method: 'POST',
      url: '/api/webhooks/gozap',
      originalUrl: '/api/webhooks/gozap',
      headers,
      socket: { remoteAddress: '10.0.0.1', remotePort: 44444 },
    } as never);
    logger.info({ req: serialized }, 'request completed');
    return lines.join('');
  }

  it(`redige o cabeçalho ${TOKEN_HEADER} (o caminho PREFERIDO do segredo)`, () => {
    const line = logRequest({
      'user-agent': 'gozap-webhook',
      [TOKEN_HEADER]: SECRET,
    });

    expect(line).not.toContain(SECRET);
    expect(line).toContain('[Redacted]');
    // A linha continua servindo para diagnóstico: rota e user-agent ficam.
    expect(line).toContain('/api/webhooks/gozap');
    expect(line).toContain('gozap-webhook');
  });

  it('redige o mesmo segredo quando ele vem como Authorization: Bearer', () => {
    const line = logRequest({
      'user-agent': 'gozap-webhook',
      authorization: `Bearer ${SECRET}`,
    });

    expect(line).not.toContain(SECRET);
  });

  it('o cabeçalho do controller está coberto pela lista de redact de produção', () => {
    // Amarra as duas pontas: o nome que o controller lê e o caminho que o pino
    // apaga. Trocar um sem o outro é o defeito que este arquivo existe para pegar.
    expect(redactPaths).toContain(`req.headers["${TOKEN_HEADER}"]`);
  });
});
