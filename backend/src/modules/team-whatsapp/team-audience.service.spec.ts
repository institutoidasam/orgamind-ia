import { beforeEach, describe, expect, it } from 'vitest';
import type { TeamPurpose } from '../../schemas/contracts/team-whatsapp.schema';
import {
  DATE,
  NIGHT,
  S1,
  S2,
  blockCodes,
  createAudienceHarness,
  cycleOf,
  givenPeople,
  on,
  person,
  request,
  verdict,
  type AudienceHarness,
} from './team-audience.test-fixtures';
import { SHIFT_FIRST, SHIFT_SECOND } from './team-whatsapp.test-fixtures';

let h: AudienceHarness;
beforeEach(() => {
  h = createAudienceHarness();
});

/** Remanejado de s1 para s2 no 1º turno, na data. */
const movedTo = (sectorId: string) =>
  on('OTHER_SECTOR', { sectorId, shiftId: SHIFT_FIRST.id });

/** s1: escalada, de folga, de férias e remanejada para s2; e de s2 remanejada para s1. */
const mixedDay = () => ({
  s1: [
    person('ana'),
    person('bia', SHIFT_FIRST, on('DAY_OFF')),
    person('caio', SHIFT_FIRST, on('VACATION')),
    person('davi', SHIFT_FIRST, movedTo(S2.id)),
    person('eva', SHIFT_FIRST, { sectorId: S2.id, ...movedTo(S1.id) }),
  ],
});

describe('TeamAudienceService.preview — base em serviço (aceite 1)', () => {
  it('aceite 1: em serviço — escalados e remanejados entram; Folga, Férias e Em outro setor nesta data', async () => {
    givenPeople(h, mixedDay());

    const preview = await h.service.preview('a', request());

    expect(verdict(preview)).toEqual({
      ana: 'in',
      eva: 'in',
      bia: 'day_off',
      caio: 'vacation',
      davi: 'other_sector',
    });
    expect(preview.included.find((p) => p.userId === 'eva')).toMatchObject({
      sectorId: S1.id,
      sectorName: S1.name,
      shiftName: SHIFT_FIRST.name,
    });
  });
});

describe('TeamAudienceService.preview — base vinculada em dois setores (aceite 2)', () => {
  it('aceite 2: reunião em dois setores e dois turnos com folga; férias fora; uma vez por pessoa, com o sectorId da área que manda', async () => {
    const davi = person('davi', SHIFT_FIRST, movedTo(S2.id));
    givenPeople(h, {
      s1: [
        person('ana'),
        person('bia', SHIFT_SECOND, on('DAY_OFF')),
        person('caio', SHIFT_FIRST, on('VACATION')),
        davi,
      ],
      s2: [davi, person('eli', SHIFT_SECOND, { sectorId: S2.id })],
    });
    const meeting = request({
      purpose: 'meeting',
      activity: { date: DATE, time: '23:59', place: 'Sala 1' },
      target: {
        sectorIds: [S2.id, S1.id],
        shiftIds: [SHIFT_FIRST.id, SHIFT_SECOND.id],
        includeOff: true,
      },
    });

    const preview = await h.service.preview('a', meeting);

    expect(verdict(preview)).toEqual({
      ana: 'in',
      bia: 'in',
      davi: 'in',
      eli: 'in',
      caio: 'vacation',
    });
    expect(preview.included).toHaveLength(4);
    const areaOf = (id: string) =>
      preview.included.find((p) => p.userId === id)?.sectorId;
    expect([areaOf('davi'), areaOf('eli')]).toEqual([S1.id, S2.id]);
  });
});

describe('TeamAudienceService.preview — pessoa inativa (C3)', () => {
  it('C3: pessoa inativa não aparece nem em Vão receber nem em Ficam de fora', async () => {
    givenPeople(h, {
      s1: [
        person('ana'),
        person('ivo', SHIFT_FIRST, { isActive: false }),
        person('iris', SHIFT_FIRST, { isActive: false, ...on('DAY_OFF') }),
      ],
    });

    const preview = await h.service.preview('a', request());

    expect(verdict(preview)).toEqual({ ana: 'in' });
  });
});

describe('TeamAudienceService.preview — Férias e Folga em cada finalidade (aceite 14)', () => {
  it.each<[TeamPurpose, boolean, string]>([
    ['shift_notice', false, 'day_off'],
    ['meeting', true, 'in'],
    ['alignment', false, 'day_off'],
    ['lecture', true, 'in'],
    ['overtime', false, 'day_off'],
    ['urgency', false, 'day_off'],
  ])(
    'aceite 14: em cada finalidade Férias e Folga separados (%s)',
    async (purpose, includeOff, offVerdict) => {
      givenPeople(h, {
        s1: [
          person('ana'),
          person('bia', SHIFT_FIRST, on('DAY_OFF')),
          person('caio', SHIFT_FIRST, on('VACATION')),
        ],
      });

      const preview = await h.service.preview(
        'a',
        request({ purpose, target: { includeOff } }),
      );

      expect(verdict(preview)).toEqual({
        ana: 'in',
        bia: offVerdict,
        caio: 'vacation',
      });
    },
  );
});

describe('TeamAudienceService.preview — Alinhamento nas duas bases (aceite 10)', () => {
  it('aceite 10: Alinhamento nas duas bases dá públicos diferentes com folga e remanejado', async () => {
    givenPeople(h, mixedDay());
    const alignment = (base: 'assigned' | 'on_duty', includeOff: boolean) =>
      h.service.preview(
        'a',
        request({ purpose: 'alignment', base, target: { includeOff } }),
      );

    const assigned = await alignment('assigned', true);
    const onDuty = await alignment('on_duty', false);

    expect(verdict(assigned)).toEqual({
      ana: 'in',
      bia: 'in',
      davi: 'in',
      caio: 'vacation',
    });
    expect(verdict(onDuty)).toEqual({
      ana: 'in',
      eva: 'in',
      bia: 'day_off',
      caio: 'vacation',
      davi: 'other_sector',
    });
    expect(assigned.audienceKey).not.toBe(onDuty.audienceKey);
    expect([assigned.rule.base, onDuty.rule.base]).toEqual([
      'assigned',
      'on_duty',
    ]);
  });
});

describe('TeamAudienceService.preview — hora extra e urgência (aceites 6 e 18)', () => {
  it('aceite 6: hora extra com a marcada de férias — Férias e trava no_recipients', async () => {
    givenPeople(h, {
      s1: [person('ana'), person('caio', SHIFT_FIRST, on('VACATION'))],
    });
    const overtime = request({
      purpose: 'overtime',
      activity: { date: DATE, time: '23:59', place: 'Galpão' },
      target: { userIds: ['caio'] },
    });

    const preview = await h.service.preview('a', overtime);

    expect(verdict(preview)).toEqual({ ana: 'not_selected', caio: 'vacation' });
    expect(blockCodes(preview)).toContain('no_recipients');
    expect(blockCodes(preview)).not.toContain('overtime_without_selection');
    expect(preview.rule.selectedCount).toBe(1);
  });

  it('aceite 18: urgência com a véspera pega o turno noturno de ontem', async () => {
    const eve = '2026-11-19';
    givenPeople(h, {
      s1: [
        person('nina', NIGHT, cycleOf(NIGHT.id)),
        person('otto', SHIFT_FIRST, cycleOf(NIGHT.id)),
        person('ana'),
      ],
    });
    const urgency = request({
      purpose: 'urgency',
      urgencyReason: 'Vazamento na ala B',
      target: { date: eve, shiftIds: [NIGHT.id] },
    });

    const preview = await h.service.preview('a', urgency);

    expect(h.repo.loadDayPeopleMany.mock.calls).toEqual([[[S1.id], eve]]);
    expect(verdict(preview)).toEqual({ nina: 'in', otto: 'in' });
    expect(preview.included.map((p) => p.shiftName)).toEqual([
      NIGHT.name,
      NIGHT.name,
    ]);
    expect(preview.rule.rosterDate).toBe(eve);
    expect(blockCodes(preview)).not.toContain('missing_urgency_reason');
  });
});

describe('TeamAudienceService.preview — turno inativo (T4a-m2)', () => {
  it('turno inativo da escala sai com o nome, não em branco', async () => {
    const old = { id: 'shift_old', name: 'Turno antigo' };
    givenPeople(h, { s1: [person('rui', old)] });

    const preview = await h.service.preview('a', request());

    expect(preview.included).toMatchObject([
      { userId: 'rui', shiftName: old.name },
    ]);
  });
});

describe('TeamAudienceService.preview — pulo de telefone (DF3)', () => {
  it('sem telefone vira excluído Sem telefone e sai de quem recebe', async () => {
    const blockedPhone = '+5592991110777';
    h.consent.isSuppressed.mockImplementation((p) =>
      Promise.resolve(p === blockedPhone),
    );
    givenPeople(h, {
      s1: [
        person('ana'),
        person('bia', SHIFT_FIRST, { phoneE164: null }),
        person('caio', SHIFT_FIRST, { phoneE164: blockedPhone }),
        person('davi', SHIFT_FIRST, { contactAuthorization: 'NAO_AUTORIZADO' }),
      ],
    });

    const preview = await h.service.preview('a', request());

    expect(verdict(preview)).toEqual({
      ana: 'in',
      bia: 'no_phone',
      caio: 'suppressed',
      davi: 'not_authorized',
    });
    expect(preview.excluded.find((p) => p.userId === 'bia')).toMatchObject({
      sectorId: S1.id,
      shiftName: SHIFT_FIRST.name,
    });
  });
});

describe('TeamAudienceService.preview — travas como lista (CF4, DF11)', () => {
  it('prévia com texto vazio devolve empty_text na lista, sem 422', async () => {
    givenPeople(h, { s1: [person('ana')] });

    const preview = await h.service.preview('a', request({ text: '' }));

    expect(preview.blocks[0]).toEqual({
      code: 'team_whatsapp.empty_text',
      message: 'Escreva a mensagem.',
    });
    const filled = await h.service.preview('a', request({ text: 'Oi' }));
    expect(blockCodes(filled)).toEqual([]);
  });

  it('área sem número vira trava sector_without_number', async () => {
    givenPeople(h, { s1: [person('ana')] });
    h.repo.findSectorChannels.mockImplementation((ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, null]))),
    );

    const preview = await h.service.preview('a', request({ text: 'Oi' }));

    expect(blockCodes(preview)).toEqual(['sector_without_number']);
    expect(h.repo.findSectorChannels.mock.calls).toEqual([[[S1.id]]]);
  });
});

const meeting = request({
  purpose: 'meeting',
  activity: { date: DATE, time: '23:59', place: 'Sala 1' },
  target: { includeOff: true },
});

describe('TeamAudienceService.preview — impressão e painel da regra (CF3, CF7)', () => {
  it('mesma entrada dá a mesma audienceKey; painel com finalidade, base, folga, data, atividade, momento e política nula', async () => {
    givenPeople(h, {
      s1: [person('ana', SHIFT_FIRST, { phoneE164: '+5592991110001' })],
    });

    const first = await h.service.preview('a', meeting);
    const again = await h.service.preview('a', meeting);

    expect(again.audienceKey).toBe(first.audienceKey);
    expect(first.audienceKey).toMatch(/^[0-9a-f]{64}$/);
    expect(first.rule).toEqual({
      purpose: 'meeting',
      base: 'assigned',
      includeOff: true,
      rosterDate: DATE,
      sectors: [{ id: S1.id, name: S1.name }],
      shifts: null,
      levels: [],
      withoutLevel: false,
      selectedCount: null,
      activity: { date: DATE, time: '23:59', place: 'Sala 1' },
      urgencyReason: null,
      when: 'now',
      scheduledFor: null,
      // DG6: a prévia "agora" mostra a política imediata.
      schedulePolicy: 'immediate',
    });
  });
});

describe('TeamAudienceService.preview — impressão com o telefone completo (T5)', () => {
  it('a impressão usa o telefone completo: mesmo final mascarado, outra impressão', async () => {
    const withPhone = (phoneE164: string) =>
      givenPeople(h, { s1: [person('ana', SHIFT_FIRST, { phoneE164 })] });
    h.repo.findActor.mockResolvedValue({
      ...(await h.repo.findActor('a'))!,
      permissions: [],
    });

    withPhone('+5592991110001');
    const before = await h.service.preview('a', meeting);
    withPhone('+5592981110001');
    const after = await h.service.preview('a', meeting);

    expect(after.included).toEqual(before.included);
    expect(after.audienceKey).not.toBe(before.audienceKey);
  });
});
