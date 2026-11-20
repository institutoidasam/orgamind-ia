import { beforeEach, describe, expect, it } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { PermissionKey } from '../../shared/authz/permissions';
import type { TeamActor } from './team-whatsapp.policy';
import {
  S1,
  S2,
  createAudienceHarness,
  givenPeople,
  person,
  request,
  type AudienceHarness,
} from './team-audience.test-fixtures';

/** Gestor de s1 (OPERATOR) com a matriz padrão menos `revoke`. */
const managerOf = (
  sectorIds: string[],
  revoke: PermissionKey[] = [],
): TeamActor => ({
  ...actorWith('OPERATOR', { id: 'm', revoke }),
  managedSectorIds: sectorIds,
});

let h: AudienceHarness;
beforeEach(() => {
  h = createAudienceHarness();
});

describe('TeamAudienceService.preview — alcance (aceite 17, GF8)', () => {
  it('aceite 17: setor fora do alcance 403 forbidden, sem ler pessoas', async () => {
    h.repo.findActor.mockResolvedValue(managerOf([S1.id]));

    for (const sectorIds of [[S1.id, S2.id], ['s9']]) {
      await expect(
        h.service.preview('m', request({ target: { sectorIds } })),
      ).rejects.toMatchObject({ code: 'team_whatsapp.forbidden', status: 403 });
    }
    expect(h.repo.loadDayPeopleMany.mock.calls).toHaveLength(0);
    expect(h.repo.findSectorChannels.mock.calls).toHaveLength(0);
  });

  it('quem não envia para a equipe recebe 403 antes de qualquer setor', async () => {
    h.repo.findActor.mockResolvedValue({
      ...actorWith('VIEWER', { id: 'v' }),
      managedSectorIds: [S1.id],
    });

    await expect(h.service.preview('v', request())).rejects.toMatchObject({
      code: 'team_whatsapp.forbidden',
    });
    expect(h.repo.findSector.mock.calls).toHaveLength(0);
  });

  it('erro de regra vem antes do alcance', async () => {
    h.repo.findActor.mockResolvedValue(managerOf([S1.id]));
    const outside = request({
      target: { sectorIds: [S2.id], includeOff: true },
    });

    await expect(h.service.preview('m', outside)).rejects.toMatchObject({
      code: 'team_whatsapp.invalid_off_option',
      status: 422,
    });
    expect(h.repo.findSector.mock.calls).toHaveLength(0);
  });
});

describe('TeamAudienceService.preview — disparo amplo (GF8)', () => {
  const both = request({ target: { sectorIds: [S1.id, S2.id] } });

  it('amplo sem equipe.disparo_amplo 403 broad_send_denied; com a chave passa', async () => {
    h.repo.findActor.mockResolvedValue(
      managerOf([S1.id, S2.id], ['equipe.disparo_amplo']),
    );
    await expect(h.service.preview('m', both)).rejects.toMatchObject({
      code: 'team_whatsapp.broad_send_denied',
      status: 403,
    });
    expect(h.repo.loadDayPeopleMany.mock.calls).toHaveLength(0);

    h.repo.findActor.mockResolvedValue(managerOf([S1.id, S2.id]));
    await expect(h.service.preview('m', both)).resolves.toMatchObject({
      rule: { sectors: [S1, S2].map(({ id, name }) => ({ id, name })) },
    });
  });
});

describe('TeamAudienceService — seleção sem relação (C4, GF9)', () => {
  it('id sem relação 422 invalid_selection', async () => {
    givenPeople(h, { s1: [person('ana')] });
    const input = request({ target: { userIds: ['ana', 'ghost'] } });

    await expect(h.service.preview('a', input)).rejects.toMatchObject({
      code: 'team_whatsapp.invalid_selection',
      status: 422,
    });
    expect(h.repo.findSectorChannels.mock.calls).toHaveLength(0);
  });

  it('resolve devolve o id sem relação em unknownSelected, sem erro: o envio confere a impressão antes', async () => {
    givenPeople(h, { s1: [person('ana')] });
    const actor = await h.repo.findActor('a');

    const resolved = await h.service.resolve(
      actor!,
      request({ target: { userIds: ['ana', 'ghost'] } }),
    );

    expect(resolved.unknownSelected).toEqual(['ghost']);
    expect(resolved.audienceKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('TeamAudienceService.preview — telefone e nome pela visão de quem pede (aceite 17)', () => {
  const collator = new Intl.Collator('pt-BR');
  const people = () => [
    person('zeca', undefined, { name: 'Zeca', phoneE164: '+5592991110003' }),
    person('fone', undefined, {
      name: '+55 92 99111-0009',
      phoneE164: '+5592991110009',
    }),
    person('ana', undefined, { name: 'Ana', phoneE164: '+5592991110005' }),
  ];

  it('aceite 17: sem telefone.ver_completo telefones mascarados e lista pelo nome exibido', async () => {
    h.repo.findActor.mockResolvedValue(
      managerOf([S1.id], ['telefone.ver_completo']),
    );
    givenPeople(h, { s1: people() });

    const preview = await h.service.preview('m', request());

    const names = preview.included.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => collator.compare(a, b)));
    expect(names).toContain('•••• 0009');
    expect(preview.included.map((p) => p.phone)).toEqual(
      expect.arrayContaining(['•••• 0003', '•••• 0005', '•••• 0009']),
    );
    expect(JSON.stringify(preview)).not.toMatch(/\+55|9911100/);
  });

  it('com telefone.ver_completo sai o telefone completo e o nome real', async () => {
    givenPeople(h, { s1: people() });

    const preview = await h.service.preview('a', request());

    expect(
      preview.included.map((p) => [p.userId, p.name, p.phone]),
    ).toContainEqual(['fone', '+55 92 99111-0009', '+5592991110009']);
  });
});
