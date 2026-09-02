import { describe, it, expect } from 'vitest';

import {
  MARKETING_UNDELIVERABLE_CODES,
  isMarketingUndeliverableCode,
  marketingUndeliverableReason,
  isPermanentRecipientFailure,
} from './marketing-reachability';

describe('isMarketingUndeliverableCode', () => {
  it('é verdadeiro para 131026 (destinatário desligou marketing)', () => {
    expect(isMarketingUndeliverableCode('131026')).toBe(true);
  });

  it('é verdadeiro para 130472 (experimento de marketing da Meta)', () => {
    expect(isMarketingUndeliverableCode('130472')).toBe(true);
  });

  it('é falso para falhas transitórias e para código ausente', () => {
    // 131048 (anti-spam) e 500 são transitórios: o contato NÃO é inalcançável,
    // e marcá-lo como tal o excluiria de toda campanha de marketing para sempre.
    expect(isMarketingUndeliverableCode('131048')).toBe(false);
    expect(isMarketingUndeliverableCode('500')).toBe(false);
    expect(isMarketingUndeliverableCode(undefined)).toBe(false);
    expect(isMarketingUndeliverableCode(null)).toBe(false);
  });

  it('é falso para o cap diário de marketing (131049) — ele expira em 24h', () => {
    // 131049 é o teto de marketing do destinatário nas últimas 24h. É temporário
    // por definição; tratá-lo como inalcançável PERMANENTE seria descartar o
    // contato por um limite que se renova sozinho amanhã.
    expect(isMarketingUndeliverableCode('131049')).toBe(false);
  });

  it('não é falso-positivo para um código desconhecido', () => {
    expect(isMarketingUndeliverableCode('999999')).toBe(false);
  });
});

describe('marketingUndeliverableReason', () => {
  it('explica 131026 em PT-BR, mencionando que UTILITY funciona', () => {
    const r = marketingUndeliverableReason('131026');
    expect(r).toBeTruthy();
    expect(r!.toUpperCase()).toContain('MARKETING');
    expect(r!.toUpperCase()).toContain('UTILITY');
  });

  it('explica 130472 em PT-BR, mencionando que UTILITY funciona', () => {
    const r = marketingUndeliverableReason('130472');
    expect(r!.toUpperCase()).toContain('MARKETING');
    expect(r!.toUpperCase()).toContain('UTILITY');
  });

  it('retorna null para um código que não torna o contato inalcançável', () => {
    expect(marketingUndeliverableReason('131048')).toBeNull();
    expect(marketingUndeliverableReason(undefined)).toBeNull();
  });
});

describe('isPermanentRecipientFailure', () => {
  it('inclui as falhas definitivas de marketing', () => {
    for (const code of MARKETING_UNDELIVERABLE_CODES) {
      expect(isPermanentRecipientFailure(code)).toBe(true);
    }
  });

  it('inclui número inexistente no WhatsApp (131021) e opt-out (131050)', () => {
    expect(isPermanentRecipientFailure('131021')).toBe(true);
    expect(isPermanentRecipientFailure('131050')).toBe(true);
    expect(isPermanentRecipientFailure('recipient_opted_out')).toBe(true);
  });

  it('inclui o timeout indeterminado — TODO provedor, não só a Twilio (pode ter sido entregue)', () => {
    // Reenviar arrisca cobrança dupla + entrega duplicada (sinal de ban). O
    // Zernio é o provedor do tráfego REAL do cliente — sem estas duas linhas,
    // o processor terminaliza a Message como FAILED(zernio.indeterminate) sem
    // reenviar (send-message.processor.ts), mas o PRÓXIMO LOTE da mesma
    // campanha achava o contato "pendente" de novo e reenviava — a mesma
    // duplicata, por outro caminho (ver batch-audience.ts).
    expect(isPermanentRecipientFailure('twilio.indeterminate')).toBe(true);
    expect(isPermanentRecipientFailure('zernio.indeterminate')).toBe(true);
    expect(isPermanentRecipientFailure('gozap.indeterminate')).toBe(true);
  });

  it('inclui o timeout CRU (zernio/gozap.timeout) — linhas LEGADAS gravadas antes da guarda B3 ser generalizada', () => {
    // Sinais CRUS do adapter (pré-tradução do processor). Não é hipotético:
    // antes da guarda de timeout indeterminado (send-message.processor.ts,
    // B3) cobrir todo provedor, ela só existia para a Twilio — um timeout do
    // Zernio era relançado, retentado 5x pelo BullMQ, e a linha FINAL ficava
    // com o código CRU (`@OnWorkerEvent('failed')` grava
    // `err.providerErrorCode` sem tradução para o terminal
    // `<provider>.indeterminate`). Essas linhas legadas já existem no banco
    // e carregam o MESMO risco de entrega talvez-já-ocorrida.
    expect(isPermanentRecipientFailure('zernio.timeout')).toBe(true);
    expect(isPermanentRecipientFailure('gozap.timeout')).toBe(true);
  });

  it('NÃO inclui falhas transitórias — elas voltam a ser pendentes no próximo lote', () => {
    expect(isPermanentRecipientFailure('131048')).toBe(false);
    expect(isPermanentRecipientFailure('500')).toBe(false);
    // `zernio.unreachable` é falha de REDE (a conexão nunca se estabeleceu, o
    // POST nunca chegou ao Zernio) — não há ambiguidade de entrega, retentar
    // é correto.
    expect(isPermanentRecipientFailure('zernio.unreachable')).toBe(false);
    // Uma falha sem código é indeterminada, não definitiva: pode ser retentada.
    expect(isPermanentRecipientFailure(null)).toBe(false);
    expect(isPermanentRecipientFailure(undefined)).toBe(false);
  });
});
