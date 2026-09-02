import { describe, it, expect } from 'vitest';

import { classifyGozapError } from './gozap-error-mapper';

describe('classifyGozapError', () => {
  it('número inexistente no WhatsApp → fatal, não opt-out', () => {
    const r = classifyGozapError(
      400,
      'Número inválido / não existe no WhatsApp',
    );
    expect(r.fatal).toBe(true);
    expect(r.code).toBe('gozap.invalid_recipient');
  });
  it('instância desconectada → NÃO fatal (retryable — replay ao reconectar)', () => {
    const r = classifyGozapError(
      400,
      'Instância desconectada — conecte antes de enviar',
    );
    expect(r.fatal).toBe(false);
    expect(r.code).toBe('gozap.not_connected');
  });
  it('401 token → fatal (config errada, não retry por mensagem)', () => {
    expect(classifyGozapError(401, 'missing token').fatal).toBe(true);
  });
  it('403 quota → não fatal (problema de conta, retry após liberar)', () => {
    const r = classifyGozapError(403, 'quota exceeded');
    expect(r.fatal).toBe(false);
    expect(r.code).toBe('gozap.quota_exceeded');
  });
  it('5xx → não fatal (transiente)', () => {
    expect(classifyGozapError(500, 'internal').fatal).toBe(false);
  });
  it('desconhecido → não fatal, preserva a mensagem do provedor', () => {
    const r = classifyGozapError(400, 'algo estranho');
    expect(r.fatal).toBe(false);
    expect(r.message).toContain('algo estranho');
  });

  // Regressão apontada na revisão: a regra de invalid_recipient usava
  // `not.*whatsapp`, que atravessa a frase inteira e captura mensagens de
  // OUTRA categoria só porque citam "WhatsApp" em algum lugar.
  it('desconexão que cita "WhatsApp" na frase não deve ser roubada por invalid_recipient (regressão: not.*whatsapp era ganancioso)', () => {
    const r = classifyGozapError(400, 'Error: not connected to WhatsApp');
    expect(r.code).toBe('gozap.not_connected');
    expect(r.fatal).toBe(false);
  });

  // Regressão: a regra de invalid_payload incluía a substring genérica "bad
  // request", que blindava até um 400 de cota como se fosse payload rejeitado.
  it('"Bad Request" genérico não deve virar invalid_payload fatal — cai no default seguro preservando a mensagem crua (regressão: substring "bad request" era ampla demais)', () => {
    const r = classifyGozapError(400, 'Bad Request');
    expect(r.code).toBe('gozap.unknown');
    expect(r.fatal).toBe(false);
    expect(r.message).toContain('Bad Request');
  });

  it('mensagem de cota classifica como quota_exceeded mesmo com status genérico (a remoção de "bad request" não pode quebrar a regra de cota)', () => {
    const r = classifyGozapError(400, 'Quota exceeded for this plan');
    expect(r.code).toBe('gozap.quota_exceeded');
    expect(r.fatal).toBe(false);
  });

  // Mesma família de regressão do primeiro teste, mas para a outra metade da
  // regra: `invalid.*number` capturava "invalid number of parameters" (erro
  // de payload/template) como se fosse destinatário inválido.
  it('"invalid number of parameters" (erro de payload/template) não deve ser capturado por invalid_recipient — cai no default seguro (regressão: invalid.*number era ganancioso)', () => {
    const r = classifyGozapError(400, 'invalid number of parameters');
    expect(r.code).not.toBe('gozap.invalid_recipient');
    expect(r.fatal).toBe(false);
  });

  // Elevado de Minor na revisão da Task 5: com a terminalização de
  // gozap.timeout (mensagens indeterminadas não são mais reenviadas por
  // NENHUM caminho), juntar ECONNREFUSED/ENOTFOUND/EAI_AGAIN no mesmo código
  // do timeout vira destrutivo — uma instabilidade de minutos no GoZap mata a
  // campanha inteira, mesmo quando é CERTO que o POST nunca chegou. Canal
  // separado (3º argumento) porque, ao contrário do status/mensagem do
  // provedor, este vem do socket local — não há "mensagem do GoZap" para
  // casar por substring. Mesmo padrão do zernio.unreachable.
  describe('clientNetworkCode (3º argumento) — conexão nunca se estabeleceu', () => {
    it('ECONNREFUSED → gozap.unreachable, NÃO-fatal (retry é seguro, o POST nunca chegou)', () => {
      const r = classifyGozapError(undefined, undefined, 'ECONNREFUSED');
      expect(r.code).toBe('gozap.unreachable');
      expect(r.fatal).toBe(false);
    });
    it('ENOTFOUND → gozap.unreachable, NÃO-fatal', () => {
      const r = classifyGozapError(undefined, undefined, 'ENOTFOUND');
      expect(r.code).toBe('gozap.unreachable');
      expect(r.fatal).toBe(false);
    });
    it('EAI_AGAIN → gozap.unreachable, NÃO-fatal', () => {
      const r = classifyGozapError(undefined, undefined, 'EAI_AGAIN');
      expect(r.code).toBe('gozap.unreachable');
      expect(r.fatal).toBe(false);
    });
    it('gozap.unreachable NUNCA marca opt-out (não é sinal sobre o destinatário)', () => {
      expect(classifyGozapError(undefined, undefined, 'ECONNREFUSED').optedOut).toBe(
        false,
      );
    });
  });
});
