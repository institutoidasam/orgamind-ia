import { Logger } from '@nestjs/common';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { GozapWebhooksController } from './gozap-webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { AuditService } from '../../shared/audit/audit.service';
import { WebhookDropsService } from '../whatsapp-providers/webhook-drops.service';
import { UnauthorizedError } from '../../shared/errors/domain.error';
import type { Env } from '../../shared/config/env.schema';
import { PrismaService } from '../../shared/prisma/prisma.service';

function makeReq(o: { ip?: string; headers?: Record<string, unknown> } = {}) {
  return {
    ip: o.ip ?? '127.0.0.1',
    headers: { 'user-agent': 'gozap', ...(o.headers ?? {}) },
  } as never;
}

/** A messages_update envelope — o formato REAL do GoZap é indocumentado; só o
 * necessário para roteamento (`event`, `instance_id`) é assumido aqui. */
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    event: 'messages_update',
    instance_id: 'gz-inst-1',
    data: { id: 'MSG1', status: 'delivered', timestamp: 1710000000 },
    ...overrides,
  };
}

describe('GozapWebhooksController', () => {
  let controller: GozapWebhooksController;
  let webhooks: MockProxy<WebhooksService>;
  let prisma: MockProxy<PrismaService>;
  let audit: MockProxy<AuditService>;
  let drops: MockProxy<WebhookDropsService>;
  let config: MockProxy<ConfigService<Env>>;

  beforeEach(() => {
    webhooks = mockDeep<WebhooksService>();
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    drops = mockDeep<WebhookDropsService>();
    config = mockDeep<ConfigService<Env>>();
    config.get.mockImplementation((key: unknown) => {
      if (key === 'GOZAP_WEBHOOK_TOKEN') return 'sekret';
      if (key === 'GOZAP_WEBHOOK_DEBUG') return false;
      return undefined;
    });
    webhooks.process.mockResolvedValue(undefined);
    controller = new GozapWebhooksController(
      webhooks,
      config,
      prisma,
      audit,
      drops,
    );
  });

  it('token de query errado → 401, nada processado', async () => {
    await expect(
      controller.receive(makeReq(), 'wrong', envelope()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(webhooks.process).not.toHaveBeenCalled();
  });

  it('token de query ausente → 401, nada processado', async () => {
    await expect(
      controller.receive(makeReq(), undefined, envelope()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(webhooks.process).not.toHaveBeenCalled();
  });

  it('token errado → auditoria da rejeição', async () => {
    await expect(
      controller.receive(makeReq({ ip: '203.0.113.9' }), 'wrong', envelope()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(audit.log).toHaveBeenCalledWith(
      'webhook.apikey_invalid',
      'WhatsappWebhook',
      undefined,
      expect.objectContaining({ ip: '203.0.113.9', provider: 'gozap' }),
    );
  });

  it('token certo + canal resolvido → 200 e delega process(payload, channelId, GOZAP)', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue({
      id: 'chan-g',
      provider: 'GOZAP',
      gozapInstanceId: 'gz-inst-1',
    });
    const res = await controller.receive(makeReq(), 'sekret', envelope());
    expect(res).toEqual({ ok: true });
    expect(prisma.channel.findFirst).toHaveBeenCalledWith({
      where: {
        provider: 'GOZAP',
        gozapInstanceId: 'gz-inst-1',
        isActive: true,
      },
    });
    expect(webhooks.process).toHaveBeenCalledWith(
      expect.anything(),
      'chan-g',
      'GOZAP',
    );
  });

  /**
   * COMPLIANCE — antes, o catch devolvia 200 para QUALQUER exceção. Como os
   * parsers passaram a devolver `[]` em vez de lançar, o que chega aqui é a
   * família "persistência falhou": um "PARAR" de eleitor cujo `consent.record`
   * falhasse por um blip do banco virava 200 + log, e a revogação se perdia
   * para sempre. `webhooks.service` solta a chave de dedupe e relança contando
   * com o provider retentar — engolir aqui quebrava esse contrato.
   */
  it('falha ao processar → RELANÇA (para o GoZap reentregar), não devolve 200', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue({
      id: 'chan-g',
      provider: 'GOZAP',
      gozapInstanceId: 'gz-inst-1',
    });
    (webhooks.process as any).mockRejectedValueOnce(new Error('banco fora'));

    await expect(
      controller.receive(makeReq(), 'sekret', envelope()),
    ).rejects.toThrow('banco fora');
  });

  it('o log de erro NÃO imprime o corpo do webhook (telefone e texto do eleitor)', async () => {
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    (prisma.channel.findFirst as any).mockResolvedValue({
      id: 'chan-g',
      provider: 'GOZAP',
      gozapInstanceId: 'gz-inst-1',
    });
    (webhooks.process as any).mockRejectedValueOnce(new Error('banco fora'));

    await expect(
      controller.receive(makeReq(), 'sekret', envelope()),
    ).rejects.toThrow();

    const logado = JSON.stringify(errorSpy.mock.calls);
    expect(logado).not.toContain('gz-inst-1'.slice(0, 0) + 'PushName');
    expect(logado).not.toContain('body=');
    errorSpy.mockRestore();
  });

  /**
   * SUBSTITUI o contrato anterior ("não propaga, loga o corpo cru, ainda 200").
   * Aquela decisão se apoiava em "o parser é PROVISÓRIO e vai estourar com
   * payload indocumentado" — premissa que caiu em 2026-08-08, quando os
   * parsers passaram a ser escritos contra o payload REAL e a devolver `[]`
   * em vez de lançar. O que sobra chegando aqui é "persistência falhou", e
   * para ela a reentrega do provider é o remédio, não o silêncio.
   */
  it('erro de persistência → RELANÇA e NÃO loga o corpo (PII do eleitor)', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue({ id: 'chan-g' });
    webhooks.process.mockRejectedValue(new Error('unexpected shape'));
    const errorSpy = vi
      .spyOn((controller as any).logger, 'error')
      .mockImplementation(() => undefined);
    const body = envelope();

    await expect(controller.receive(makeReq(), 'sekret', body)).rejects.toThrow(
      'unexpected shape',
    );

    expect(errorSpy).toHaveBeenCalled();
    const logado = JSON.stringify(errorSpy.mock.calls);
    expect(logado).not.toContain(JSON.stringify(body).slice(1, 40));
  });

  it('token certo + sem canal → WebhookDrop + 200 (não 500), não processa', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue(null);
    const res = await controller.receive(makeReq(), 'sekret', envelope());
    expect(res).toEqual({ ok: true });
    expect(drops.record).toHaveBeenCalledWith({
      provider: 'GOZAP',
      accountRef: 'gz-inst-1',
      event: 'messages_update',
    });
    expect(webhooks.process).not.toHaveBeenCalled();
  });

  it('sem instance_id no payload → ignora com 200, não processa', async () => {
    const res = await controller.receive(
      makeReq(),
      'sekret',
      envelope({ instance_id: undefined }),
    );
    expect(res).toEqual({ ok: true });
    expect(webhooks.process).not.toHaveBeenCalled();
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
  });

  it('GOZAP_WEBHOOK_DEBUG desligado → não loga o corpo cru', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue({ id: 'chan-g' });
    const logSpy = vi.spyOn((controller as any).logger, 'log');
    await controller.receive(makeReq(), 'sekret', envelope());
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[gozap-raw]'),
    );
  });

  /**
   * C20 — o segredo viajava SÓ em `?t=`, e o access log do nginx grava a URL
   * inteira: 74 linhas de produção com o token de 48 hex em texto claro. O
   * remédio é aceitar a credencial por CABEÇALHO (que nenhum access log grava)
   * mantendo a query como compatibilidade, porque a URL está gravada no painel
   * do GoZap — cortar a query hoje derruba toda a entrada até alguém
   * reconfigurar o SaaS à mão.
   */
  describe('credencial fora da query (C20)', () => {
    beforeEach(() => {
      (prisma.channel.findFirst as any).mockResolvedValue({
        id: 'chan-g',
        provider: 'GOZAP',
        gozapInstanceId: 'gz-inst-1',
      });
    });

    it('x-webhook-token correto e NENHUMA query → autentica e processa', async () => {
      const res = await controller.receive(
        makeReq({ headers: { 'x-webhook-token': 'sekret' } }),
        undefined,
        envelope(),
      );
      expect(res).toEqual({ ok: true });
      expect(webhooks.process).toHaveBeenCalled();
    });

    it('Authorization: Bearer correto e NENHUMA query → autentica e processa', async () => {
      const res = await controller.receive(
        makeReq({ headers: { authorization: 'Bearer sekret' } }),
        undefined,
        envelope(),
      );
      expect(res).toEqual({ ok: true });
      expect(webhooks.process).toHaveBeenCalled();
    });

    it('cabeçalho errado + query certa → ainda autentica (a compat não pode ser derrubada por um header lixo)', async () => {
      const res = await controller.receive(
        makeReq({ headers: { 'x-webhook-token': 'nope' } }),
        'sekret',
        envelope(),
      );
      expect(res).toEqual({ ok: true });
      expect(webhooks.process).toHaveBeenCalled();
    });

    it('cabeçalho errado e sem query → 401', async () => {
      await expect(
        controller.receive(
          makeReq({ headers: { 'x-webhook-token': 'nope' } }),
          undefined,
          envelope(),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      expect(webhooks.process).not.toHaveBeenCalled();
    });

    it('com GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN=false a query deixa de valer, o cabeçalho continua valendo', async () => {
      config.get.mockImplementation((key: unknown) => {
        if (key === 'GOZAP_WEBHOOK_TOKEN') return 'sekret';
        if (key === 'GOZAP_WEBHOOK_DEBUG') return false;
        if (key === 'GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN') return false;
        return undefined;
      });

      await expect(
        controller.receive(makeReq(), 'sekret', envelope()),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      expect(webhooks.process).not.toHaveBeenCalled();

      const res = await controller.receive(
        makeReq({ headers: { 'x-webhook-token': 'sekret' } }),
        undefined,
        envelope(),
      );
      expect(res).toEqual({ ok: true });
      expect(webhooks.process).toHaveBeenCalledTimes(1);
    });

    it('a auditoria da rejeição diz por ONDE veio a tentativa, e NUNCA o valor', async () => {
      await expect(
        controller.receive(
          makeReq({ headers: { 'x-webhook-token': 'chute-do-atacante' } }),
          'outro-chute',
          envelope(),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedError);

      expect(audit.log).toHaveBeenCalledWith(
        'webhook.apikey_invalid',
        'WhatsappWebhook',
        undefined,
        expect.objectContaining({
          provider: 'gozap',
          sentHeaderToken: true,
          sentQueryToken: true,
        }),
      );
      const auditado = JSON.stringify((audit.log as any).mock.calls);
      expect(auditado).not.toContain('chute-do-atacante');
      expect(auditado).not.toContain('outro-chute');
    });

    it('autenticar pela query avisa que a rota legada ainda está em uso (com o segredo fora do aviso)', async () => {
      const warnSpy = vi
        .spyOn((controller as any).logger, 'warn')
        .mockImplementation(() => undefined);

      await controller.receive(makeReq(), 'sekret', envelope());

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('query string'),
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('sekret');
    });

    it('autenticar pelo cabeçalho NÃO avisa nada (é o caminho desejado)', async () => {
      const warnSpy = vi
        .spyOn((controller as any).logger, 'warn')
        .mockImplementation(() => undefined);

      await controller.receive(
        makeReq({ headers: { 'x-webhook-token': 'sekret' } }),
        undefined,
        envelope(),
      );

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it('GOZAP_WEBHOOK_DEBUG ligado → loga o corpo cru do payload', async () => {
    config.get.mockImplementation((key: unknown) => {
      if (key === 'GOZAP_WEBHOOK_TOKEN') return 'sekret';
      if (key === 'GOZAP_WEBHOOK_DEBUG') return true;
      return undefined;
    });
    (prisma.channel.findFirst as any).mockResolvedValue({ id: 'chan-g' });
    const logSpy = vi.spyOn((controller as any).logger, 'log');
    const body = envelope();
    await controller.receive(makeReq(), 'sekret', body);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(JSON.stringify(body)),
    );
  });
});
