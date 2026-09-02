import { describe, it, expect } from 'vitest';
import {
  classifyTwilioError,
  isTwilioOptOutCode,
  isTwilioKillSwitchCode,
  isImmediateKillSwitchCode,
} from './twilio-error-mapper';

describe('classifyTwilioError', () => {
  it('marks invalid-number (21211) as fatal, not opt-out', () => {
    const c = classifyTwilioError('21211');
    expect(c.fatal).toBe(true);
    expect(c.optedOut).toBe(false);
    expect(c.code).toBe('21211');
  });

  it('marks not-a-WhatsApp-user (63003) as fatal', () => {
    expect(classifyTwilioError('63003').fatal).toBe(true);
  });

  it('marks outside-24h-window (63016) as fatal', () => {
    expect(classifyTwilioError('63016').fatal).toBe(true);
  });

  it('marks opted-out via STOP (21610) as fatal with clear PT-BR message', () => {
    const c = classifyTwilioError('21610');
    expect(c.fatal).toBe(true);
    expect(c.optedOut).toBe(true);
    expect(c.code).toBe('21610');
    expect(c.message).toContain('opt-out');
  });

  it.each(['21610', '63020', '63024', '63032'])(
    'marks opt-out code %s as fatal AND optedOut',
    (code) => {
      const c = classifyTwilioError(code);
      expect(c.fatal).toBe(true);
      expect(c.optedOut).toBe(true);
    },
  );

  // T8 — 63032: usuário limitou marketing (Meta 472) — fatal por destinatário
  // + flag no contato (higiene de lista), com mensagem PT-BR correta.
  it('63032 (usuário limitou marketing) tem mensagem clara em PT-BR', () => {
    const c = classifyTwilioError('63032');
    expect(c.message).toContain('marketing');
  });

  it.each(['20429', '429', '63018', '30001', '20003', '63038', '63049'])(
    'marks transient code %s as NON-fatal',
    (code) => {
      expect(classifyTwilioError(code).fatal).toBe(false);
    },
  );

  // T8 — rate limits com mensagem PT-BR (63018 canal, 63038 conta Twilio).
  it.each(['63018', '63038'])('%s (rate limit) traz mensagem PT-BR de limite', (code) => {
    const c = classifyTwilioError(code);
    expect(c.optedOut).toBe(false);
    expect(c.message.toLowerCase()).toContain('limite');
  });

  // T8 — template pausado/desativado (63040/63041/63042): fatal, mensagem clara.
  it.each(['63040', '63041', '63042'])(
    '%s (template pausado/desativado) é fatal com mensagem sobre template',
    (code) => {
      const c = classifyTwilioError(code);
      expect(c.fatal).toBe(true);
      expect(c.optedOut).toBe(false);
      expect(c.message.toLowerCase()).toContain('template');
    },
  );

  // T8 — 63049: throttle de MARKETING por engajamento previsto — transiente.
  it('63049 (throttle de marketing) é transiente com mensagem PT-BR', () => {
    const c = classifyTwilioError('63049');
    expect(c.fatal).toBe(false);
    expect(c.message.toLowerCase()).toContain('marketing');
  });

  // ── C2 (spec §5): família 13xxxx — erros da META que a Twilio só REPASSA ────
  // Antes desta correção NENHUM 13xxxx estava mapeado: todos caíam no default
  // *retryable*, ou seja, o orgamind retentava 5x uma mensagem que a Meta derrubou
  // por template pausado (132015) e queimava retries num destinatário que já
  // estourou o cap de marketing (131049) — o pior comportamento possível.
  describe('família 13xxxx (erros da Meta repassados pela Twilio)', () => {
    // O BUG DE HOJE, fixado explicitamente: 132015 NÃO é retentável.
    it('132015 (template pausado/paced pela Meta) é FATAL — nunca retentar', () => {
      const c = classifyTwilioError('132015');
      expect(c.fatal).toBe(true);
      expect(c.optedOut).toBe(false);
      expect(c.code).toBe('132015');
      expect(c.message.toLowerCase()).toContain('template');
      expect(c.message.toLowerCase()).toContain('pausado');
    });

    it('132015 dispara o kill-switch, e com LIMIAR IMEDIATO (decisão da Meta sobre o template inteiro)', () => {
      expect(isTwilioKillSwitchCode('132015')).toBe(true);
      expect(isImmediateKillSwitchCode('132015')).toBe(true);
    });

    it('131049 (cap de marketing por destinatário) é fatal NA MENSAGEM, sem opt-out e FORA do kill-switch', () => {
      const c = classifyTwilioError('131049');
      expect(c.fatal).toBe(true);
      // É falha do DESTINATÁRIO (cap de 24h somando todas as empresas), não do
      // template: não marca opt-out e não pode matar a campanha inteira.
      expect(c.optedOut).toBe(false);
      expect(isTwilioKillSwitchCode('131049')).toBe(false);
      expect(c.message.toLowerCase()).toContain('marketing');
      expect(c.message).toContain('24h');
    });

    it('131050 (usuário parou de receber marketing) é fatal E opt-out', () => {
      const c = classifyTwilioError('131050');
      expect(c.fatal).toBe(true);
      expect(c.optedOut).toBe(true);
      expect(isTwilioOptOutCode('131050')).toBe(true);
    });

    it.each([
      '131021',
      '131026',
      '131031',
      '131047',
      '131051',
      '132000',
      '132001',
      '132005',
      '132007',
      '132012',
      '132016',
      '133010',
    ])('%s é fatal (não retentável) com mensagem PT-BR não vazia', (code) => {
      const c = classifyTwilioError(code);
      expect(c.fatal).toBe(true);
      expect(c.optedOut).toBe(false);
      expect(c.code).toBe(code);
      expect(c.message.trim().length).toBeGreaterThan(0);
      // PT-BR: nenhuma mensagem pode ser o texto cru da Twilio (inglês).
      expect(c.message).not.toBe('Some Twilio detail');
    });

    it.each(['131048', '131052'])(
      '%s é transiente (retentável)',
      (code) => {
        const c = classifyTwilioError(code);
        expect(c.fatal).toBe(false);
        expect(c.optedOut).toBe(false);
      },
    );

    it('132016 (template desativado) alimenta o kill-switch, mas no limiar normal', () => {
      expect(isTwilioKillSwitchCode('132016')).toBe(true);
      expect(isImmediateKillSwitchCode('132016')).toBe(false);
    });
  });

  it('treats an unknown code as non-fatal and keeps the provider message', () => {
    const c = classifyTwilioError('99999', 'Some Twilio detail');
    expect(c.fatal).toBe(false);
    expect(c.optedOut).toBe(false);
    expect(c.message).toBe('Some Twilio detail');
    expect(c.code).toBe('99999');
  });

  it('handles an undefined code (network/no-response) as non-fatal', () => {
    const c = classifyTwilioError(undefined);
    expect(c.fatal).toBe(false);
    expect(c.code).toBe('twilio.unknown');
  });

  it('classifies the synthetic timeout code as non-fatal', () => {
    expect(classifyTwilioError('twilio.timeout').fatal).toBe(false);
  });
});

describe('isTwilioOptOutCode', () => {
  it('is true for opt-out codes', () => {
    expect(isTwilioOptOutCode('21610')).toBe(true);
    expect(isTwilioOptOutCode('63020')).toBe(true);
    expect(isTwilioOptOutCode('63024')).toBe(true);
  });

  it('is false for non-opt-out / fatal codes', () => {
    expect(isTwilioOptOutCode('21211')).toBe(false);
    expect(isTwilioOptOutCode('63003')).toBe(false);
  });

  it('is false for undefined / unknown', () => {
    expect(isTwilioOptOutCode(undefined)).toBe(false);
    expect(isTwilioOptOutCode('99999')).toBe(false);
  });
});

// T8 — kill-switch: códigos de template/qualidade que, consecutivos numa
// campanha TWILIO, indicam que TODO o restante vai falhar (template pausado/
// desativado, throttle de marketing, lista sem opt-in).
describe('isTwilioKillSwitchCode', () => {
  it.each(['63040', '63041', '63042', '63049', '21610', '132015', '132016'])(
    'é true para %s',
    (code) => {
      expect(isTwilioKillSwitchCode(code)).toBe(true);
    },
  );

  it('é false para códigos fora do conjunto e para undefined', () => {
    expect(isTwilioKillSwitchCode('63016')).toBe(false);
    expect(isTwilioKillSwitchCode('63024')).toBe(false);
    // 131049 é falha do DESTINATÁRIO — jamais mata a campanha.
    expect(isTwilioKillSwitchCode('131049')).toBe(false);
    expect(isTwilioKillSwitchCode(undefined)).toBe(false);
  });
});

// C2 — 132015 é a Meta decidindo sobre o TEMPLATE INTEIRO (pacing/pausa), não a
// falha de um destinatário: a 2ª ocorrência já seria desperdício. Limiar 1.
describe('isImmediateKillSwitchCode', () => {
  it('é true só para 132015', () => {
    expect(isImmediateKillSwitchCode('132015')).toBe(true);
  });

  it('é false para os demais códigos de kill-switch e para undefined', () => {
    for (const code of ['63040', '63041', '63042', '63049', '21610', '132016']) {
      expect(isImmediateKillSwitchCode(code)).toBe(false);
    }
    expect(isImmediateKillSwitchCode(undefined)).toBe(false);
  });
});
