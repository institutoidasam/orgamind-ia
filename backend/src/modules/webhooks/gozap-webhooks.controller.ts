import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { Public } from '../auth/decorators/public.decorator';
import { UnauthorizedError } from '../../shared/errors/domain.error';
import { AuditService } from '../../shared/audit/audit.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WebhookDropsService } from '../whatsapp-providers/webhook-drops.service';
import type { Env } from '../../shared/config/env.schema';

/**
 * Constant-time string comparison — mesmo padrão de `webhooks.controller.ts`.
 * `crypto.timingSafeEqual` exige buffers do mesmo tamanho (por isso o guard de
 * `length` antes); comparar a credencial com `===` vaza, pelo tempo de resposta,
 * quantos bytes iniciais bateram. Aqui é a ÚNICA defesa — o GoZap não assina o
 * corpo, então o rigor todo está nesta comparação.
 */
function timingSafeStrEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Cabeçalho preferido para a credencial. Nome próprio (não `token`, que o
 * PRÓPRIO GoZap já usa como cabeçalho de autenticação na direção oposta —
 * `gozap-instances.service.ts` manda `{ token: instanceToken }` — e reutilizar
 * o nome convidaria a confundir os dois segredos).
 */
export const TOKEN_HEADER = 'x-webhook-token';

/** Express tipa cabeçalho como `string | string[]`; só `set-cookie` chega como
 * lista, mas um proxy pode duplicar qualquer um. Lista → não adivinhe: só o
 * primeiro valor conta, e nunca concatenado (concatenar mudaria o tamanho e
 * daria ao atacante um oráculo de comprimento). */
function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** `Authorization: Bearer <segredo>` — a forma que praticamente todo painel de
 * webhook de SaaS sabe configurar. O prefixo é case-insensitive por RFC 7235. */
function bearerToken(v: string | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(v.trim());
  return m ? m[1] : undefined;
}

/** Intervalo mínimo entre dois avisos de "ainda autenticando pela query". */
const LEGACY_WARN_EVERY_MS = 60 * 60 * 1000;

/** O formato do payload do GoZap é indocumentado — só o que usamos para roteamento. */
type GozapEnvelope = { event?: unknown; instance_id?: unknown; data?: unknown };

/**
 * Receptor dos webhooks do GoZap. Diferente do Zernio (HMAC-SHA256 sobre o raw
 * body) e da Twilio (HMAC-SHA1 sobre a URL), o GoZap NÃO assina o corpo — a
 * documentação não define nenhum cabeçalho de assinatura. A autenticação é o
 * segredo `GOZAP_WEBHOOK_TOKEN`. Por ser mais fraco que HMAC, o segredo é
 * comparado em tempo constante e a rejeição é auditada.
 *
 * ONDE O SEGREDO VIAJA — e por que são DOIS caminhos (achado C20, 2026-08-19):
 * o segredo nasceu na query string (`?t=<segredo>`), que nós mesmos armamos na
 * URL ao configurar o webhook (POST /webhook). Query string é a pior carona
 * possível para uma credencial: ela vai INTEIRA para o access log de todo proxy
 * no caminho. Em produção foram encontradas 74 linhas de access log do nginx em
 * 52h com o token de 48 hex em texto claro — e quem lê log de container (a API
 * do Dokploy, por exemplo) passava a poder forjar ack e opt-out de eleitor.
 *
 *   PREFERIDO   `X-Webhook-Token: <segredo>` (ou `Authorization: Bearer <…>`).
 *               Cabeçalho não entra em access log nenhum.
 *   COMPAT      `?t=<segredo>`. Continua valendo porque a URL está gravada no
 *               painel do GoZap, que é SaaS de terceiro: cortar a query hoje
 *               faria TODO evento de entrada ser recusado até alguém
 *               reconfigurar o painel à mão — ack, mensagem recebida e opt-out
 *               perdidos no intervalo. Cada autenticação por esse caminho
 *               deixa um `warn` (estrangulado) para a transição ter fim.
 *   FIM         Depois de reconfigurar o painel para o cabeçalho e rotacionar o
 *               segredo, `GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN=false` fecha a query.
 *               Ver OPERATIONS.md → "Webhook do GoZap: tirar o segredo da URL".
 *
 * O access log do nginx desta rota também deixou de gravar a query (ver
 * `frontend/nginx.conf`), mas isso protege só o NOSSO proxy: o segredo ainda
 * atravessa a internet dentro da URL enquanto o painel não migrar.
 *
 * Resolve o canal por `instance_id` → `Channel.gozapInstanceId`; sem canal →
 * `WebhookDrop` (contabilizado, vira alerta na página Canais) + 200 — nunca 500,
 * senão o GoZap retentaria a NOSSA lacuna de configuração em loop.
 *
 * PROVISÓRIO: o payload de evento do GoZap é indocumentado. Com
 * `GOZAP_WEBHOOK_DEBUG=1` logamos o corpo cru para decifrar o formato real antes
 * de confiar nos acks — essa captura é tão razão de ser desta rota quanto o
 * roteamento em si.
 */
@SkipThrottle()
@Controller('webhooks/gozap')
export class GozapWebhooksController {
  private readonly logger = new Logger(GozapWebhooksController.name);
  /** Estrangula o aviso do caminho legado (query string) — ver o `if (!byHeader)`. */
  private lastQueryTokenWarnAt = 0;

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly config: ConfigService<Env>,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly drops: WebhookDropsService,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: Request,
    @Query('t') queryToken: string | undefined,
    @Body() body: GozapEnvelope,
  ): Promise<{ ok: true }> {
    // 1. Autenticação ANTES de qualquer processamento. Segredo ausente na
    // config, ou não enviado por nenhum dos caminhos, já reprovam sem chegar à
    // comparação constant-time.
    const expected = this.config.get('GOZAP_WEBHOOK_TOKEN', { infer: true });
    const configured = typeof expected === 'string' && expected.length > 0;

    const headerToken =
      headerValue(req.headers[TOKEN_HEADER]) ??
      bearerToken(headerValue(req.headers.authorization));
    const queryAllowed =
      this.config.get('GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN', { infer: true }) !==
      false;

    // Os dois caminhos passam pela MESMA comparação em tempo constante. E os
    // dois são avaliados sempre: um cabeçalho errado não pode invalidar uma
    // query certa, senão qualquer um derruba a entrega mandando lixo no header.
    const byHeader =
      configured &&
      typeof headerToken === 'string' &&
      timingSafeStrEqual(headerToken, expected);
    const byQuery =
      configured &&
      queryAllowed &&
      typeof queryToken === 'string' &&
      timingSafeStrEqual(queryToken, expected);

    if (!byHeader && !byQuery) {
      this.logger.warn(`gozap webhook rejected: bad token ip=${req.ip}`);
      await this.audit.log(
        'webhook.apikey_invalid',
        'WhatsappWebhook',
        undefined,
        {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          provider: 'gozap',
          // POR ONDE veio a tentativa — nunca O QUE veio. Sem isto, um painel
          // reconfigurado com o header errado é indistinguível de um atacante
          // no log; com o valor, a auditoria viraria o mesmo vazamento que este
          // achado corrige.
          sentHeaderToken: typeof headerToken === 'string',
          sentQueryToken: typeof queryToken === 'string',
        },
      );
      throw new UnauthorizedError(
        'Invalid GoZap webhook token',
        'webhook.invalid_gozap_token',
      );
    }

    // Autenticou pela query: a URL registrada no painel do GoZap ainda carrega
    // o segredo, e ele atravessa a internet (e todo access log no caminho) a
    // cada evento. Um `warn` por hora — não por requisição — porque um alarme
    // que se repete milhares de vezes por dia deixa de ser alarme; mesmo
    // estrangulamento do `resolveWebhookUrl` do GozapInstancesService.
    if (!byHeader) {
      const now = Date.now();
      if (now - this.lastQueryTokenWarnAt >= LEGACY_WARN_EVERY_MS) {
        this.lastQueryTokenWarnAt = now;
        this.logger.warn(
          'gozap webhook: autenticado pelo segredo na query string (caminho legado). ' +
            `Reconfigure a URL do webhook no painel do GoZap para mandar o segredo no cabeçalho ${TOKEN_HEADER} ` +
            'e rotacione GOZAP_WEBHOOK_TOKEN — ele está em texto claro em todo access log do caminho. ' +
            'Ver OPERATIONS.md.',
        );
      }
    }

    // 2. Captura crua — só com a flag ligada. É assim que decifraremos o formato
    // real do payload (indocumentado) antes de a F-B confiar nos acks.
    if (this.config.get('GOZAP_WEBHOOK_DEBUG', { infer: true })) {
      this.logger.log(`[gozap-raw] ${JSON.stringify(body).slice(0, 2000)}`);
    }

    const eventType = typeof body?.event === 'string' ? body.event : '?';
    const instanceId =
      typeof body?.instance_id === 'string' ? body.instance_id : undefined;
    if (!instanceId) {
      this.logger.warn(
        `gozap webhook: no instance_id event=${eventType}, ignoring`,
      );
      return { ok: true };
    }

    // 3. Resolve qual canal GOZAP este evento pertence, pelo instance_id.
    const channel = await this.prisma.channel.findFirst({
      where: { provider: 'GOZAP', gozapInstanceId: instanceId, isActive: true },
    });
    if (!channel) {
      // Sem canal ativo para esta instância — 200 (não 500, senão o GoZap
      // retenta a nossa lacuna de config) + drop CONTADO, não só um warn: é o
      // que evita a perda silenciosa que já aconteceu com o Zernio.
      this.logger.warn(
        `gozap webhook: no active GOZAP channel for instance=${instanceId} event=${eventType}, ignoring`,
      );
      await this.drops.record({
        provider: 'GOZAP',
        accountRef: instanceId,
        event: eventType,
      });
      return { ok: true };
    }

    // 4. Delega ao pipeline compartilhado, provider-agnóstico. Diferente do
    // Zernio (formato documentado e estável), o parser do GoZap é
    // PROVISÓRIO contra um payload indocumentado — uma exceção por formato
    // inesperado é o cenário mais provável, justo durante a fase de
    // descoberta para a qual GOZAP_WEBHOOK_DEBUG existe. Deixar propagar
    // viraria 500 e o GoZap retentaria o MESMO payload malformado em loop;
    // o corpo cru vai no log de erro porque é exatamente o que falta para
    // decifrar o formato real.
    try {
      await this.webhooks.process(body, channel.id, 'GOZAP');
    } catch (err) {
      // RELANÇA. A justificativa original ("um parser que estoura viraria 500 e
      // o GoZap retentaria o mesmo payload malformado em loop") caiu quando os
      // parsers passaram a devolver `[]` em vez de lançar: o que chega aqui
      // agora é a família PERSISTÊNCIA FALHOU, e para ela a reentrega é
      // exatamente o remédio. `webhooks.service` inclusive solta a chave de
      // dedupe e relança de propósito, contando com o provider retentar —
      // engolir aqui quebrava esse contrato. Concretamente: um "PARAR" de
      // eleitor cujo `consent.record` falhasse por um blip do banco virava
      // 200 + log, e a revogação se perdia PARA SEMPRE.
      //
      // O corpo cru NÃO vai mais para o log: ele carrega telefone, PushName e
      // o texto do eleitor, e este log não é coberto por GOZAP_WEBHOOK_DEBUG.
      this.logger.error(
        `gozap webhook: process failed event=${eventType} instance=${instanceId} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
    return { ok: true };
  }
}
