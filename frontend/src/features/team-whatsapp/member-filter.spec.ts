import { describe, expect, it } from 'vitest';
import {
  buildSectorTarget, leftOutByReason, markableIds, markedReceiving, receivingByArea, toggleAllMarkable, unselectedPeople,
} from './member-filter';
import type { TeamAudiencePreview } from './schemas';
import { PREVIEW_RESPONSE, RULE_VIEW } from './audience-preview.test-fixtures';

const person = (userId: string, name: string, extra: Partial<TeamAudiencePreview['included'][number]> = {}) => ({
  userId, name, sectorId: 's1', sectorName: 'Logística', shiftName: 'Manhã', levelName: null, phone: '•••• 0001', ...extra,
});
const out = (userId: string, name: string, reason: TeamAudiencePreview['excluded'][number]['reason']) => ({
  userId, name, sectorId: 's1', sectorName: 'Logística', shiftName: 'Manhã', levelName: null, reason,
});

const rule = {
  ...RULE_VIEW,
  sectors: [{ id: 's1', name: 'Logística' }, { id: 's2', name: 'Atendimento' }],
};
const preview: TeamAudiencePreview = {
  ...PREVIEW_RESPONSE,
  rule,
  included: [person('ana', 'Ana'), person('rui', 'Rui', { sectorId: 's2', sectorName: 'Atendimento' })],
  excluded: [out('maria', 'Maria', 'vacation'), out('lia', 'Lia', 'not_selected'), out('pedro', 'Pedro', 'no_phone')],
};

describe('member-filter: rótulo da seleção', () => {
  it('m2: "seleção de N" conta as pessoas marcadas, mesmo as que a prévia deixou de fora', () => {
    const result = buildSectorTarget({ preview, sectorIds: ['s1', 's2'], selectedIds: ['ana', 'rui', 'maria'] });
    expect(result.label).toBe('Atendimento, Logística · Manhã · 20/11 · seleção de 3');
    expect(result).toMatchObject({ userIds: ['ana', 'rui', 'maria'], recipients: [{ id: 'ana' }, { id: 'rui' }] });
  });
});

describe('member-filter: lista da prévia', () => {
  it('agrupa por área pelo sectorId da prévia, na ordem da regra, e cada pessoa uma vez', () => {
    const groups = receivingByArea(preview);
    expect(groups.map((g) => [g.sectorId, g.name, g.people.map((p) => p.userId)])).toEqual([
      ['s1', 'Logística', ['ana']],
      ['s2', 'Atendimento', ['rui']],
    ]);
  });

  it('área que a regra não lista entra no fim, com o nome da pessoa', () => {
    const extra = { ...preview, included: [person('zeca', 'Zeca', { sectorId: 's9', sectorName: 'Apoio' })] };
    expect(receivingByArea(extra).map((g) => g.name)).toEqual(['Logística', 'Atendimento', 'Apoio']);
  });

  it('só Vão receber e Não selecionado são marcáveis; os de fora por motivo próprio, não', () => {
    expect(unselectedPeople(preview).map((p) => p.userId)).toEqual(['lia']);
    expect(leftOutByReason(preview).map((p) => p.userId)).toEqual(['maria', 'pedro']);
    expect(markableIds(preview)).toEqual(['ana', 'rui', 'lia']);
  });

  it('Marcar todos marca os marcáveis; com todos marcados limpa a seleção', () => {
    const all = markableIds(preview);
    expect([...toggleAllMarkable(all, new Set(['ana']))]).toEqual(['ana', 'rui', 'lia']);
    expect(toggleAllMarkable(all, new Set([...all, 'maria'])).size).toBe(0);
    expect(toggleAllMarkable([], new Set()).size).toBe(0);
  });

  it('marcado que está de fora não conta como quem recebe', () => {
    expect(markedReceiving(preview.included, new Set(['rui', 'maria'])).map((p) => p.userId)).toEqual(['rui']);
  });
});

describe('member-filter: alvo do diálogo', () => {
  const target = (selectedIds: string[]) => buildSectorTarget({ preview, sectorIds: ['s1', 's2'], selectedIds });

  it('leva a regra e as pessoas da prévia, com o rótulo do back', () => {
    expect(target([])).toEqual({
      type: 'sector', sectorIds: ['s1', 's2'], levelIds: [], withoutLevel: false, date: '2026-11-20',
      shiftIds: ['sh1'], includeOff: false, userIds: null,
      label: 'Atendimento, Logística · Manhã · 20/11',
      recipients: [{ id: 'ana', name: 'Ana' }, { id: 'rui', name: 'Rui' }],
      leftOut: [{ name: 'Lia', reason: 'unselected' }, { name: 'Pedro', reason: 'no_phone' }],
    });
  });

  it('com marcados leva os ids marcados e "seleção de N"; sem turnos escolhidos, "todos os turnos"', () => {
    const all = { ...preview, rule: { ...rule, shifts: null, levels: [{ id: 'l1', name: 'Coordenador' }], withoutLevel: true } };
    const result = buildSectorTarget({ preview: all, sectorIds: ['s1', 's2'], selectedIds: ['ana', 'rui'] });
    expect(result).toMatchObject({
      shiftIds: [], levelIds: ['l1'], withoutLevel: true, userIds: ['ana', 'rui'],
      label: 'Atendimento, Logística · Coordenador, Sem nível · todos os turnos · 20/11 · seleção de 2',
    });
  });
});
