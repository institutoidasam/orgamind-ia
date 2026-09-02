import { describe, it, expect } from 'vitest';
import { FailureReason } from '@prisma/client';

import { classifyFailure, buildContactFailureUpdate } from './failure-reason';

describe('classifyFailure', () => {
  describe('SEM_WHATSAPP', () => {
    it.each([
      ['131021', 'Meta — número não é usuário do WhatsApp'],
      ['63003', 'Twilio — destinatário não é usuário do WhatsApp'],
      [
        'gozap.invalid_recipient',
        'GoZap — "Número inválido / não existe no WhatsApp" (classifyGozapError)',
      ],
    ])('%s → SEM_WHATSAPP (%s)', (code) => {
      expect(classifyFailure(code)).toBe(FailureReason.SEM_WHATSAPP);
    });
  });

  describe('OPT_OUT', () => {
    it.each([
      ['131050', 'Meta — opt-out de marketing'],
      ['recipient_opted_out', 'Zernio — destinatário recusou no ato do envio'],
      [
        'opted_out',
        'interno — processor/zernio-broadcast-send cancelam por opt-out PRÉVIO (string diferente de recipient_opted_out, mesmo motivo)',
      ],
      ['suppressed', 'interno — contato na SuppressionList'],
      ['21610', 'Twilio — STOP'],
      ['63020', 'Twilio — bloqueou/optou por sair'],
      ['63024', 'Twilio — Meta recusou entrega (bloqueio)'],
      ['63032', 'Twilio — limitou recebimento de marketing'],
    ])('%s → OPT_OUT (%s)', (code) => {
      expect(classifyFailure(code)).toBe(FailureReason.OPT_OUT);
    });

    it('opted_out e recipient_opted_out são a MESMA classificação apesar da deriva de vocabulário (spec §2.1)', () => {
      expect(classifyFailure('opted_out')).toBe(
        classifyFailure('recipient_opted_out'),
      );
      expect(classifyFailure('opted_out')).toBe(FailureReason.OPT_OUT);
    });
  });

  describe('MARKETING_DESLIGADO', () => {
    it.each([
      ['131026', 'Meta — desligou mensagens de marketing'],
      ['130472', 'Meta — experimento de marketing'],
    ])('%s → MARKETING_DESLIGADO (%s)', (code) => {
      expect(classifyFailure(code)).toBe(FailureReason.MARKETING_DESLIGADO);
    });
  });

  describe('SEM_CONSENTIMENTO', () => {
    it("'no_consent' → SEM_CONSENTIMENTO (gate de consentimento do backend)", () => {
      expect(classifyFailure('no_consent')).toBe(
        FailureReason.SEM_CONSENTIMENTO,
      );
    });
  });

  describe('FORA_DA_JANELA', () => {
    it.each([
      ['131047', 'Meta — janela de 24h fechada'],
      ['63016', 'Twilio — livre fora da janela'],
    ])('%s → FORA_DA_JANELA (%s)', (code) => {
      expect(classifyFailure(code)).toBe(FailureReason.FORA_DA_JANELA);
    });
  });

  describe('LIMITE_DIARIO', () => {
    it("'131049' → LIMITE_DIARIO (cap diário de marketing do destinatário)", () => {
      expect(classifyFailure('131049')).toBe(FailureReason.LIMITE_DIARIO);
    });
  });

  describe('TELEFONE_INVALIDO', () => {
    it.each([
      ['invalid_field_value', 'Zernio — valor de campo inválido'],
      ['21211', 'Twilio — formato E.164 incorreto'],
    ])('%s → TELEFONE_INVALIDO (%s)', (code) => {
      expect(classifyFailure(code)).toBe(FailureReason.TELEFONE_INVALIDO);
    });
  });

  describe('TEMPLATE_INDISPONIVEL', () => {
    it.each([
      ['132000', 'Meta — nº de variáveis não confere'],
      ['132001', 'Meta — template não encontrado/aprovado'],
      ['132005', 'Meta — texto excede tamanho'],
      ['132007', 'Meta — conteúdo viola política'],
      ['132012', 'Meta — formato de parâmetro inválido'],
      ['132015', 'Meta — template pausado (baixa qualidade)'],
      ['132016', 'Meta — template desativado'],
      ['63040', 'Twilio — template não pôde ser usado'],
      ['63041', 'Twilio — template pausado'],
      ['63042', 'Twilio — template desativado'],
      ['template_required', 'Zernio — precisa de template aprovado'],
      [
        'gozap.invalid_payload',
        'GoZap — conteúdo/payload rejeitado ("text is required" nas docs)',
      ],
    ])('%s → TEMPLATE_INDISPONIVEL (%s)', (code) => {
      expect(classifyFailure(code)).toBe(FailureReason.TEMPLATE_INDISPONIVEL);
    });
  });

  describe('CANAL_FORA', () => {
    it.each([
      ['enqueue_failed', 'interno — falha ao enfileirar'],
      ['antiban.instance_deleted', 'interno — instância removida'],
      ['campaign_cancelled', 'interno — campanha cancelada'],
      [
        'campaign.default_instance_inactive',
        'interno — instância padrão da campanha deletada, sem fallback',
      ],
      ['401', 'Zernio — credencial inválida/revogada'],
      ['403', 'Zernio — assinatura/add-on/plano'],
      ['131031', 'Meta — conta/número bloqueado (suspenso)'],
      ['linked_account_required', 'Zernio — conta desconectada'],
      ['account_not_found', 'Zernio — accountId não encontrado'],
      ['gozap.not_connected', 'GoZap — instância desconectada'],
      ['gozap.quota_exceeded', 'GoZap — cota de instâncias/conexões excedida'],
      ['gozap.unauthorized', 'GoZap — token ausente/inválido'],
    ])('%s → CANAL_FORA (%s)', (code) => {
      expect(classifyFailure(code)).toBe(FailureReason.CANAL_FORA);
    });
  });

  describe('INDETERMINADO', () => {
    it.each([
      [
        'twilio.indeterminate',
        'interno — timeout Twilio, entrega desconhecida',
      ],
      ['twilio.timeout', 'sinal cru do adapter Twilio antes da tradução'],
      ['sending_stuck', 'interno — reconciler achou envio travado'],
      ['zernio.timeout', 'Zernio — timeout client-side'],
      ['zernio.unreachable', 'Zernio — inacessível'],
      [
        'zernio.indeterminate',
        'interno — timeout Zernio terminalizado pelo processor (fix: generalização do B3)',
      ],
      [
        'gozap.timeout',
        'sinal cru do adapter GoZap antes da tradução (fix: generalização do B3)',
      ],
      [
        'gozap.indeterminate',
        'interno — timeout GoZap terminalizado pelo processor (fix: generalização do B3)',
      ],
    ])('%s → INDETERMINADO (%s)', (code) => {
      expect(classifyFailure(code)).toBe(FailureReason.INDETERMINADO);
    });
  });

  describe('OUTRO (default)', () => {
    it('código nulo → OUTRO', () => {
      expect(classifyFailure(null)).toBe(FailureReason.OUTRO);
    });

    it('código undefined → OUTRO', () => {
      expect(classifyFailure(undefined)).toBe(FailureReason.OUTRO);
    });

    it('código desconhecido/não mapeado → OUTRO', () => {
      expect(classifyFailure('algum-codigo-nunca-visto')).toBe(
        FailureReason.OUTRO,
      );
      expect(classifyFailure('500')).toBe(FailureReason.OUTRO);
      expect(classifyFailure('429')).toBe(FailureReason.OUTRO);
    });
  });

  it('aceita o provider sem mudar o resultado (nenhum código colide entre provedores hoje)', () => {
    expect(classifyFailure('131021', 'TWILIO')).toBe(
      FailureReason.SEM_WHATSAPP,
    );
    expect(classifyFailure('131021', 'ZERNIO')).toBe(
      FailureReason.SEM_WHATSAPP,
    );
  });
});

describe('buildContactFailureUpdate', () => {
  it('SEMPRE incrementa failureCount, mesmo para falha transitória', () => {
    const update = buildContactFailureUpdate('500');
    expect(update.failureCount).toEqual({ increment: 1 });
  });

  // Fix: `zernio.timeout`/`gozap.timeout` (o sinal CRU, pré-tradução do
  // processor) entraram em `isPermanentRecipientFailure`
  // (marketing-reachability.ts) — são as linhas LEGADAS gravadas pelo
  // `@OnWorkerEvent('failed')` sob o comportamento antigo (guarda B3
  // exclusiva da Twilio), que carregam o mesmo risco de entrega
  // talvez-já-ocorrida que o terminal `<provider>.indeterminate`. Por isso
  // `isPermanentForContact` (abaixo) agora também as reconhece como
  // DEFINITIVAS do ponto de vista do destinatário, e a flag durável do
  // Contact passa a refletir isso — não são mais tratadas como um mero
  // incidente transitório do canal.
  it('falha indeterminada CRUA (zernio/gozap.timeout) TAMBÉM seta lastFailure* — mesmo risco das linhas terminais', () => {
    for (const errorCode of ['zernio.timeout', 'gozap.timeout']) {
      const update = buildContactFailureUpdate(errorCode);
      expect(update.failureCount).toEqual({ increment: 1 });
      expect(update.lastFailureReason).toBe(FailureReason.INDETERMINADO);
      expect(update.lastFailureCode).toBe(errorCode);
      expect(update.lastFailureAt).toBeInstanceOf(Date);
    }
  });

  it('falha transitória (500, código genérico não mapeado) NÃO seta lastFailure* mas incrementa', () => {
    const update = buildContactFailureUpdate('500');
    expect(update.failureCount).toEqual({ increment: 1 });
    expect(update.lastFailureReason).toBeUndefined();
    expect(update.lastFailureCode).toBeUndefined();
    expect(update.lastFailureAt).toBeUndefined();
  });

  it('falha DEFINITIVA (131021, SEM_WHATSAPP) seta increment + lastFailure*', () => {
    const update = buildContactFailureUpdate('131021');
    expect(update.failureCount).toEqual({ increment: 1 });
    expect(update.lastFailureReason).toBe(FailureReason.SEM_WHATSAPP);
    expect(update.lastFailureCode).toBe('131021');
    expect(update.lastFailureAt).toBeInstanceOf(Date);
  });

  it("'recipient_opted_out' (reconhecido por isPermanentRecipientFailure) seta lastFailure*", () => {
    const update = buildContactFailureUpdate('recipient_opted_out');
    expect(update.lastFailureReason).toBe(FailureReason.OPT_OUT);
    expect(update.lastFailureCode).toBe('recipient_opted_out');
    expect(update.lastFailureAt).toBeInstanceOf(Date);
  });

  it("'opted_out' — a string que o processor GRAVA de fato — TAMBÉM seta lastFailure* (a divergência de vocabulário tratada)", () => {
    const update = buildContactFailureUpdate('opted_out');
    expect(update.lastFailureReason).toBe(FailureReason.OPT_OUT);
    expect(update.lastFailureCode).toBe('opted_out');
    expect(update.lastFailureAt).toBeInstanceOf(Date);
  });

  it('MARKETING_DESLIGADO (130472) também é definitiva: seta lastFailure*', () => {
    const update = buildContactFailureUpdate('130472');
    expect(update.lastFailureReason).toBe(FailureReason.MARKETING_DESLIGADO);
    expect(update.lastFailureCode).toBe('130472');
    expect(update.lastFailureAt).toBeInstanceOf(Date);
  });

  it('código nulo/ausente: incrementa mas não seta lastFailure* (não é definitivo sem código)', () => {
    const update = buildContactFailureUpdate(null);
    expect(update.failureCount).toEqual({ increment: 1 });
    expect(update.lastFailureReason).toBeUndefined();
    expect(update.lastFailureCode).toBeUndefined();
    expect(update.lastFailureAt).toBeUndefined();
  });

  it('propaga o provider para classifyFailure ao montar lastFailureReason', () => {
    const update = buildContactFailureUpdate('131021', 'ZERNIO');
    expect(update.lastFailureReason).toBe(FailureReason.SEM_WHATSAPP);
  });
});
