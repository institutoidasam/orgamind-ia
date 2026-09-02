/** O shape que `pino-std-serializers` já entrega quando nosso serializer roda —
 * pino-http encadeia `customSerializer(reqSerializers.reqSerializer(req))`, ou
 * seja, recebemos o req JÁ serializado (não o `express.Request` cru). */
interface SerializedPinoRequest {
  method?: string;
  url?: string;
  query?: unknown;
  headers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Sanitiza o req serializado ANTES de virar log — aplicado globalmente via
 * `pinoHttp.serializers.req` em `app.module.ts`.
 *
 * O serializer PADRÃO do pino (`pino-std-serializers`) copia
 * `req.url = req.originalUrl`, que no Express carrega a query string INTEIRA,
 * e ainda expõe `req.query` como objeto à parte. Com `autoLogging` do
 * pino-http ligado (padrão), toda resposta — 200 e 401 — grava esse req no
 * log em nível `info`. Isso vaza qualquer segredo carregado na query: o
 * `GOZAP_WEBHOOK_TOKEN` de `/webhooks/gozap?t=<segredo>` (o ÚNICO segredo que
 * protege essa rota — o GoZap não assina nada) e o `hub.verify_token` do
 * handshake da Meta em `/webhooks/whatsapp`.
 *
 * `redact` do pino é por CAMINHO (dot-path) — adicionar `req.query.t` não
 * bastaria, porque o segredo continuaria dentro da STRING de `req.url`. A
 * única correção real é nunca deixar a query chegar ao objeto logado.
 *
 * Preserva method/pathname/headers/remoteAddress — só a query sai; o
 * diagnóstico (rota, verbo, IP, user-agent) continua no log.
 */
export function sanitizeReqForLog(
  req: SerializedPinoRequest,
): SerializedPinoRequest {
  const { query: _query, url, ...rest } = req;
  return {
    ...rest,
    url: typeof url === 'string' ? url.split('?')[0] : url,
  };
}
