import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TeamPurpose } from './schemas';
import { audienceRequest, referenceDate, useSendFilters, usesScreenDate } from './use-send-filters';

const TODAY = '2026-10-21';
const sectors = [{ id: 's1', name: 'Produção', code: 'PROD' }];

const setup = () => renderHook(() => useSendFilters(TODAY, sectors));

describe('useSendFilters: finalidade e folga', () => {
  it('trocar a finalidade limpa a seleção e ajusta a folga', () => {
    const { result } = setup();
    expect(result.current.purpose).toBe('shift_notice');
    expect(result.current.includeOff).toBe(false);
    act(() => result.current.setSelected(new Set(['ana'])));
    act(() => result.current.pickPurpose('meeting'));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.base).toBe('assigned');
    expect(result.current.includeOff).toBe(true);
    act(() => result.current.pickPurpose('overtime'));
    expect(result.current.includeOff).toBe(false);
    act(() => result.current.pickPurpose('urgency'));
    expect(result.current.base).toBe('on_duty');
    act(() => result.current.toggleOff(true));
    expect(result.current.includeOff).toBe(false);
  });

  it('turno escolhido não zera mais a folga na base vinculada', () => {
    const { result } = setup();
    act(() => result.current.pickPurpose('lecture'));
    act(() => result.current.pickShifts(['noite']));
    expect(result.current.includeOff).toBe(true);
    act(() => result.current.viewShift('2026-10-20', 'manha'));
    expect(result.current.includeOff).toBe(true);
    act(() => result.current.toggleOff(false));
    act(() => result.current.pickShifts(['manha', 'noite']));
    expect(result.current.includeOff).toBe(false);
  });
});

describe('useSendFilters: base do público', () => {
  it('Alinhamento: a base em serviço tira a folga e a recusa; voltar à vinculada começa desmarcada', () => {
    const { result } = setup();
    act(() => result.current.pickPurpose('alignment'));
    expect(result.current.base).toBe('assigned');
    act(() => result.current.toggleOff(true));
    expect(result.current.includeOff).toBe(true);
    act(() => result.current.pickBase('on_duty'));
    expect(result.current.includeOff).toBe(false);
    act(() => result.current.toggleOff(true));
    expect(result.current.includeOff).toBe(false);
    act(() => result.current.pickBase('assigned'));
    expect(result.current.includeOff).toBe(false);
  });

  it('a base de outra finalidade não se troca', () => {
    const { result } = setup();
    act(() => result.current.pickPurpose('meeting'));
    act(() => result.current.pickBase('on_duty'));
    expect(result.current.base).toBe('assigned');
    expect(result.current.includeOff).toBe(true);
  });
});

describe('referenceDate (GF4)', () => {
  const activity = { date: '2026-10-25', time: '', place: '' };
  const none = { date: '', time: '', place: '' };

  it('Reunião usa a data da atividade como data de referência; Alinhamento sem atividade usa a da tela', () => {
    expect(referenceDate({ purpose: 'meeting', date: TODAY, activity })).toBe('2026-10-25');
    expect(referenceDate({ purpose: 'meeting', date: TODAY, activity: none })).toBe('');
    expect(referenceDate({ purpose: 'alignment', date: TODAY, activity: none })).toBe(TODAY);
    expect(referenceDate({ purpose: 'alignment', date: TODAY, activity })).toBe('2026-10-25');
    expect(referenceDate({ purpose: 'shift_notice', date: TODAY, activity })).toBe(TODAY);
    expect(referenceDate({ purpose: 'urgency', date: TODAY, activity })).toBe(TODAY);
  });

  it('só Aviso de turno e Urgência usam a data da tela (e o atalho do turno em andamento)', () => {
    expect(usesScreenDate('shift_notice')).toBe(true);
    expect(usesScreenDate('urgency')).toBe(true);
    expect(usesScreenDate('meeting')).toBe(false);
    expect(usesScreenDate('alignment')).toBe(false);
  });
});

describe('audienceRequest', () => {
  function ready(purpose: TeamPurpose) {
    const hook = setup();
    act(() => hook.result.current.pickSectors(['s1']));
    act(() => hook.result.current.pickShifts(['noite']));
    act(() => hook.result.current.pickPurpose(purpose));
    return hook.result;
  }

  it('Reunião: corpo sem texto, na data da atividade, com folga marcada e só o que foi informado', () => {
    const result = ready('meeting');
    act(() => result.current.pickActivity({ date: '2026-10-25', time: '14:30', place: '  Sala 2 ' }));
    expect(audienceRequest(result.current)).toEqual({
      text: '',
      purpose: 'meeting',
      base: 'assigned',
      target: { type: 'sector', sectorIds: ['s1'], date: '2026-10-25', shiftIds: ['noite'], includeOff: true },
      activity: { date: '2026-10-25', time: '14:30', place: 'Sala 2' },
    });
  });

  it('Urgência leva o motivo e a data da tela, sem folga nem atividade; Aviso de turno não leva motivo', () => {
    const result = ready('urgency');
    act(() => result.current.pickUrgencyReason(' Falta de energia '));
    act(() => result.current.pickActivity({ time: '10:00' }));
    act(() => result.current.pickLevels(['l1'], true));
    expect(audienceRequest(result.current)).toEqual({
      text: '',
      purpose: 'urgency',
      base: 'on_duty',
      target: { type: 'sector', sectorIds: ['s1'], date: TODAY, shiftIds: ['noite'], levelIds: ['l1'], withoutLevel: true },
      urgencyReason: 'Falta de energia',
    });
    act(() => result.current.pickPurpose('shift_notice'));
    expect(audienceRequest(result.current)).not.toHaveProperty('urgencyReason');
    expect(audienceRequest(result.current)).not.toHaveProperty('activity');
  });

  it('null enquanto falta turno ou a data da atividade; Todos os turnos não leva shiftIds', () => {
    const result = ready('meeting');
    expect(audienceRequest(result.current)).toBeNull();
    act(() => result.current.pickActivity({ date: '2026-10-25' }));
    act(() => result.current.pickShifts(null));
    expect(audienceRequest(result.current)).toBeNull();
    act(() => result.current.pickShifts([]));
    expect(audienceRequest(result.current)?.target).toEqual({
      type: 'sector', sectorIds: ['s1'], date: '2026-10-25', includeOff: true,
    });
  });
});
