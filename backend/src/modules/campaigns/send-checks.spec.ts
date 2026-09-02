import { describe, it, expect } from 'vitest';
import { computeSendChecks } from './send-checks';
import type { SendCheckInput } from './send-checks';

/**
 * Minimal valid input; individual tests override the slice they exercise.
 * Defaults are deliberately "calm" (small audience, healthy instance, one-off
 * schedule, no overlap) so every test starts from a no-block baseline.
 */
function baseInput(overrides: Partial<SendCheckInput> = {}): SendCheckInput {
  return {
    recipients: 50,
    reachability: { total: 50, reachable: 50, invalid: 0, unknown: 0 },
    instance: {
      sentToday: 0,
      dailySendLimit: 500,
      sendWindowStartHour: 8,
      sendWindowEndHour: 20,
      sendWindowEnabled: true,
    },
    schedule: { type: 'IMMEDIATE' },
    hasRunningCampaignOnInstance: false,
    nextRunAt: null,
    ...overrides,
  };
}

function byCode(checks: ReturnType<typeof computeSendChecks>, code: string) {
  return checks.find((c) => c.code === code);
}

describe('computeSendChecks', () => {
  it('always includes an OPT_OUT info reminder', () => {
    const checks = computeSendChecks(baseInput());
    const optOut = byCode(checks, 'OPT_OUT');
    expect(optOut).toBeDefined();
    expect(optOut?.severity).toBe('info');
  });

  it('emits the checks in a stable order (VOLUME first, OPT_OUT last)', () => {
    // Force every optional check to fire so ordering is fully exercised.
    const checks = computeSendChecks(
      baseInput({
        recipients: 2000,
        reachability: { total: 2000, reachable: 400, invalid: 800, unknown: 800 },
        instance: {
          sentToday: 480,
          dailySendLimit: 500,
          sendWindowStartHour: 8,
          sendWindowEndHour: 20,
          sendWindowEnabled: true,
        },
        schedule: { type: 'DAILY_AT', time: '09:00' },
        hasRunningCampaignOnInstance: true,
        nextRunAt: new Date('2026-07-01T01:00:00Z'), // 22h BRT, outside window
      }),
    );
    expect(checks.map((c) => c.code)).toEqual([
      'VOLUME',
      'FREQUENCY',
      'REACHABILITY',
      'OVERLAP',
      'WINDOW',
      'OPT_OUT',
    ]);
  });

  it('emits only VOLUME (info) and OPT_OUT for a fully calm baseline', () => {
    const checks = computeSendChecks(baseInput());
    expect(checks.map((c) => c.code)).toEqual(['VOLUME', 'OPT_OUT']);
    expect(byCode(checks, 'VOLUME')?.severity).toBe('info');
  });

  describe('VOLUME', () => {
    it('reports recipient count + estimated duration as info for a calm send', () => {
      const checks = computeSendChecks(baseInput({ recipients: 50 }));
      const vol = byCode(checks, 'VOLUME');
      expect(vol).toBeDefined();
      expect(vol?.severity).toBe('info');
      expect(vol?.message).toContain('50');
    });

    // DECISÃO DO DONO (2026-08-12): volume alto ALERTA, não BLOQUEIA. O risco
    // de ban é do número do cliente, ele foi informado e assumiu. O bloqueio
    // custava caro por um caminho que ninguém previu: para furá-lo o operador
    // tinha de marcar "entendo o risco", e essa MESMA flag vira, em provedor
    // não-oficial, override de CONSENTIMENTO — que o backend recusa sem
    // justificativa escrita (`campaign.override_justification_required`).
    // Resultado: 4 tentativas de salvar campanha, 4 recusas, e o operador sem
    // saber por quê. Alertar mantém o aviso e desarma a armadilha.
    it('volume acima da capacidade do dia ALERTA (não bloqueia)', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 2000,
          reachability: { total: 2000, reachable: 2000, invalid: 0, unknown: 0 },
          instance: {
            sentToday: 480,
            dailySendLimit: 500, // only 20 left in the daily budget
            sendWindowStartHour: 8,
            sendWindowEndHour: 20,
            sendWindowEnabled: true,
          },
        }),
      );
      const vol = byCode(checks, 'VOLUME');
      expect(vol?.severity).toBe('warn');
      // E o texto continua dizendo o risco — o aviso não fica mudo.
      expect(vol?.message).toMatch(/bloqueio do n(ú|u)mero/i);
    });

    it('does not block when the instance has ample remaining daily capacity', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 300,
          reachability: { total: 300, reachable: 300, invalid: 0, unknown: 0 },
          instance: {
            sentToday: 0,
            dailySendLimit: 5000,
            sendWindowStartHour: 8,
            sendWindowEndHour: 20,
            sendWindowEnabled: true,
          },
        }),
      );
      expect(byCode(checks, 'VOLUME')?.severity).not.toBe('block');
    });

    it('canal que ENFILEIRA o excedente (broadcast do Zernio): estouro vira informação com o contrato, não bloqueio', () => {
      // O comportamento contratado (13/07): o dispatch corta no teto da janela
      // de 24h e re-enfileira o resto sozinho. Exigir "entendo o risco" aqui é
      // pedir aceite de um risco que não existe.
      const checks = computeSendChecks(
        baseInput({
          recipients: 5000,
          reachability: { total: 5000, reachable: 5000, invalid: 0, unknown: 0 },
          instance: {
            sentToday: 500,
            dailySendLimit: 2000, // sobram 1500
            sendWindowStartHour: 8,
            sendWindowEndHour: 20,
            sendWindowEnabled: true,
            queuesOverflow: true,
          },
        }),
      );
      const vol = byCode(checks, 'VOLUME');
      expect(vol?.severity).toBe('info');
      expect(vol?.message).toContain('1500'); // saem agora
      expect(vol?.message).toContain('3500'); // entram em fila
      expect(vol?.message).toContain('fila');
      expect(vol?.message).not.toContain('Risco de bloqueio');
    });

    it('sem queuesOverflow o estouro ALERTA — o 1-a-1 não enfileira sozinho, e isso precisa aparecer', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 2000,
          reachability: { total: 2000, reachable: 2000, invalid: 0, unknown: 0 },
          instance: {
            sentToday: 480,
            dailySendLimit: 500,
            sendWindowStartHour: 8,
            sendWindowEndHour: 20,
            sendWindowEnabled: true,
            queuesOverflow: false,
          },
        }),
      );
      expect(byCode(checks, 'VOLUME')?.severity).toBe('warn');
    });
  });

  describe('FREQUENCY', () => {
    it('warns on DAILY_AT recurrence over a large segment', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 1500,
          reachability: { total: 1500, reachable: 1500, invalid: 0, unknown: 0 },
          schedule: { type: 'DAILY_AT', time: '09:00' },
        }),
      );
      expect(byCode(checks, 'FREQUENCY')?.severity).toBe('warn');
    });

    it('warns on a short INTERVAL recurrence over a large segment', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 1500,
          reachability: { total: 1500, reachable: 1500, invalid: 0, unknown: 0 },
          schedule: { type: 'INTERVAL', everyMinutes: 30 },
        }),
      );
      expect(byCode(checks, 'FREQUENCY')?.severity).toBe('warn');
    });

    it('does not emit FREQUENCY for a one-off IMMEDIATE send', () => {
      const checks = computeSendChecks(
        baseInput({ recipients: 5000, schedule: { type: 'IMMEDIATE' } }),
      );
      expect(byCode(checks, 'FREQUENCY')).toBeUndefined();
    });

    it('does not emit FREQUENCY for a recurring send over a small segment', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 30,
          schedule: { type: 'DAILY_AT', time: '09:00' },
        }),
      );
      expect(byCode(checks, 'FREQUENCY')).toBeUndefined();
    });

    it('does not emit FREQUENCY for a once-a-week (single-day) WEEKLY send', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 5000,
          reachability: { total: 5000, reachable: 5000, invalid: 0, unknown: 0 },
          schedule: { type: 'WEEKLY', weekdays: [1], time: '09:00' },
        }),
      );
      expect(byCode(checks, 'FREQUENCY')).toBeUndefined();
    });

    it('warns on a WEEKLY send covering most of the week over a large segment', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 5000,
          reachability: { total: 5000, reachable: 5000, invalid: 0, unknown: 0 },
          schedule: { type: 'WEEKLY', weekdays: [1, 2, 3, 4, 5], time: '09:00' },
        }),
      );
      expect(byCode(checks, 'FREQUENCY')?.severity).toBe('warn');
    });
  });

  describe('REACHABILITY', () => {
    it('warns when a high percentage is invalid/unknown', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 100,
          reachability: { total: 100, reachable: 40, invalid: 30, unknown: 30 },
        }),
      );
      expect(byCode(checks, 'REACHABILITY')?.severity).toBe('warn');
    });

    it('does not warn when reachability is healthy', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 100,
          reachability: { total: 100, reachable: 95, invalid: 2, unknown: 3 },
        }),
      );
      expect(byCode(checks, 'REACHABILITY')).toBeUndefined();
    });
  });

  describe('OVERLAP', () => {
    it('warns when another campaign is already RUNNING on the instance', () => {
      const checks = computeSendChecks(
        baseInput({ hasRunningCampaignOnInstance: true }),
      );
      expect(byCode(checks, 'OVERLAP')?.severity).toBe('warn');
    });

    it('does not warn when no campaign is running on the instance', () => {
      const checks = computeSendChecks(
        baseInput({ hasRunningCampaignOnInstance: false }),
      );
      expect(byCode(checks, 'OVERLAP')).toBeUndefined();
    });
  });

  describe('WINDOW', () => {
    it('warns when a scheduled run falls outside the send window', () => {
      // 22:00 BRT (01:00Z next day) — outside an 08–20 window.
      const checks = computeSendChecks(
        baseInput({
          schedule: { type: 'ONCE_AT', runAt: new Date('2026-07-01T01:00:00Z') },
          nextRunAt: new Date('2026-07-01T01:00:00Z'),
        }),
      );
      expect(byCode(checks, 'WINDOW')?.severity).toBe('warn');
    });

    it('does not warn when the scheduled run is inside the send window', () => {
      // 13:00 BRT (16:00Z) — inside an 08–20 window.
      const checks = computeSendChecks(
        baseInput({
          schedule: { type: 'ONCE_AT', runAt: new Date('2026-07-01T16:00:00Z') },
          nextRunAt: new Date('2026-07-01T16:00:00Z'),
        }),
      );
      expect(byCode(checks, 'WINDOW')).toBeUndefined();
    });

    it('does not warn when the send window is disabled', () => {
      const checks = computeSendChecks(
        baseInput({
          instance: {
            sentToday: 0,
            dailySendLimit: 500,
            sendWindowStartHour: 8,
            sendWindowEndHour: 20,
            sendWindowEnabled: false,
          },
          schedule: { type: 'ONCE_AT', runAt: new Date('2026-07-01T01:00:00Z') },
          nextRunAt: new Date('2026-07-01T01:00:00Z'),
        }),
      );
      expect(byCode(checks, 'WINDOW')).toBeUndefined();
    });

    // Regression: the window test must be wrap-aware. For an overnight window
    // (start > end, e.g. 20h–08h) a run inside the window must NOT be flagged,
    // and a run genuinely outside it still must be.
    it('does not warn when a scheduled run is inside an overnight window', () => {
      // 23:00 BRT (02:00Z next day) — inside a 20h–08h overnight window.
      const checks = computeSendChecks(
        baseInput({
          instance: {
            sentToday: 0,
            dailySendLimit: 500,
            sendWindowStartHour: 20,
            sendWindowEndHour: 8,
            sendWindowEnabled: true,
          },
          schedule: { type: 'ONCE_AT', runAt: new Date('2026-07-01T02:00:00Z') },
          nextRunAt: new Date('2026-07-01T02:00:00Z'),
        }),
      );
      expect(byCode(checks, 'WINDOW')).toBeUndefined();
    });

    it('warns when a scheduled run is outside an overnight window', () => {
      // 12:00 BRT (15:00Z) — outside a 20h–08h overnight window.
      const checks = computeSendChecks(
        baseInput({
          instance: {
            sentToday: 0,
            dailySendLimit: 500,
            sendWindowStartHour: 20,
            sendWindowEndHour: 8,
            sendWindowEnabled: true,
          },
          schedule: { type: 'ONCE_AT', runAt: new Date('2026-07-01T15:00:00Z') },
          nextRunAt: new Date('2026-07-01T15:00:00Z'),
        }),
      );
      expect(byCode(checks, 'WINDOW')?.severity).toBe('warn');
    });
  });

  describe('hasBlockingCheck', () => {
    // Nenhuma checagem anti-ban bloqueia mais (decisão do dono, ver VOLUME).
    // O único `block` que sobrou é o INSTANCE_DELETED, empurrado em
    // `runChecks` — e esse não é juízo de risco: enviar por um canal removido
    // é IMPOSSÍVEL, todo envio morreria no roteador.
    it('nenhuma checagem anti-ban bloqueia — nem o volume mais agressivo', () => {
      const checks = computeSendChecks(
        baseInput({
          recipients: 2000,
          reachability: { total: 2000, reachable: 2000, invalid: 0, unknown: 0 },
          instance: {
            sentToday: 480,
            dailySendLimit: 500,
            sendWindowStartHour: 8,
            sendWindowEndHour: 20,
            sendWindowEnabled: true,
          },
        }),
      );
      expect(checks.some((c) => c.severity === 'block')).toBe(false);
    });
  });
});
