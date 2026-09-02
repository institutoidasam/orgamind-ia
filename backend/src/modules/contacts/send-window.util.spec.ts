import { describe, it, expect } from 'vitest';
import { isWithinSendWindow } from './send-window.util';

const WINDOW = {
  sendWindowEnabled: true,
  sendWindowStartHour: 8,
  sendWindowEndHour: 20,
};

// 2026-08-24T13:00:00Z = 09:00 em America/Manaus (UTC-4).
const NOVE_DA_MANHA = new Date('2026-08-24T13:00:00Z');
const TRES_DA_MADRUGADA = new Date('2026-08-24T07:00:00Z');

describe('isWithinSendWindow', () => {
  it('dentro da janela comercial', () => {
    expect(isWithinSendWindow(NOVE_DA_MANHA, WINDOW)).toBe(true);
  });

  it('de madrugada, fora', () => {
    expect(isWithinSendWindow(TRES_DA_MADRUGADA, WINDOW)).toBe(false);
  });

  it('janela desligada libera qualquer hora', () => {
    expect(
      isWithinSendWindow(TRES_DA_MADRUGADA, {
        ...WINDOW,
        sendWindowEnabled: false,
      }),
    ).toBe(true);
  });

  /**
   * Janela que VIRA O DIA (22h–06h). O teste ingênuo (`h < start || h >= end`)
   * é verdadeiro para TODA hora quando start > end — foi o defeito que adiava
   * mensagem para sempre no `send-message.processor`. Aqui é a mesma regra,
   * pelo mesmo motivo.
   */
  it('janela que vira o dia (22h–06h) inclui a madrugada', () => {
    const noturna = {
      sendWindowEnabled: true,
      sendWindowStartHour: 22,
      sendWindowEndHour: 6,
    };
    expect(isWithinSendWindow(TRES_DA_MADRUGADA, noturna)).toBe(true);
    expect(isWithinSendWindow(NOVE_DA_MANHA, noturna)).toBe(false);
  });

  it('start === end é config degenerada: trata como sem restrição', () => {
    expect(
      isWithinSendWindow(TRES_DA_MADRUGADA, {
        sendWindowEnabled: true,
        sendWindowStartHour: 8,
        sendWindowEndHour: 8,
      }),
    ).toBe(true);
  });

  it('o fuso é o do app (America/Manaus), não o do servidor', () => {
    // 12:00Z = 08:00 em Manaus: a primeira hora DENTRO da janela.
    expect(
      isWithinSendWindow(new Date('2026-08-24T12:00:00Z'), WINDOW),
    ).toBe(true);
    // 11:59Z = 07:59 em Manaus: ainda fora.
    expect(
      isWithinSendWindow(new Date('2026-08-24T11:59:00Z'), WINDOW),
    ).toBe(false);
  });
});
