import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { OptInLinkController } from './optin-link.controller';
import { OptInLinkService, type OptInLinkView } from './optin-link.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';

const VIEW: OptInLinkView = {
  id: 'l1',
  token: 'FEIRA-MANAUS-2026',
  purposeKey: 'convite_atividades',
  purposeLabel: 'Convites para cursos, oficinas e eventos',
  consentTextVersion: 'optin-v1',
  expectedText: 'Autorizo o IDASAM … [FEIRA-MANAUS-2026]',
  url: 'https://wa.me/559231550103?text=Autorizo%20o%20IDASAM',
  senderDigits: '559231550103',
  channelId: 'ch1',
  channelName: 'Principal',
  description: 'Cartaz da feira',
  active: true,
  grants: 7,
  createdAt: new Date('2026-07-01'),
};

describe('OptInLinkController', () => {
  let links: MockProxy<OptInLinkService>;
  let ctrl: OptInLinkController;

  beforeEach(() => {
    links = mockDeep<OptInLinkService>();
    ctrl = new OptInLinkController(links);
  });

  /**
   * Gerar um ponto de coleta é decidir DE ONDE virá consentimento — e o token
   * fica impresso num cartaz que ninguém recolhe. É ato de ADMIN.
   */
  it('é restrito a ADMIN', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, OptInLinkController);
    expect(roles).toEqual(['ADMIN']);
  });

  it('POST cria o link, creditando o usuário autenticado como autor', async () => {
    links.create.mockResolvedValue(VIEW);
    const dto = {
      token: 'FEIRA-MANAUS-2026',
      purposeKey: 'convite_atividades',
      channelId: 'ch1',
      description: 'Cartaz da feira',
    };

    const out = await ctrl.create(dto, { user: { sub: 'u1' } } as never);

    expect(links.create).toHaveBeenCalledWith(dto, 'u1');
    expect(out.url).toContain('wa.me');
    expect(out.expectedText).toContain('IDASAM');
  });

  it('GET lista os pontos de coleta com o funil por token', async () => {
    links.list.mockResolvedValue([VIEW]);

    const out = await ctrl.list();

    expect(out).toHaveLength(1);
    expect(out[0].grants).toBe(7);
  });

  it('PATCH desativa (e reativa) o link — nunca apaga', async () => {
    links.setActive.mockResolvedValue({ ...VIEW, active: false });

    const out = await ctrl.setActive('l1', { active: false });

    expect(links.setActive).toHaveBeenCalledWith('l1', false);
    expect(out.active).toBe(false);
  });
});

describe('Roles decorator (sanidade do teste acima)', () => {
  it('grava a role nos metadados da classe', () => {
    @Roles('ADMIN')
    class Dummy {}
    expect(Reflect.getMetadata(ROLES_KEY, Dummy)).toEqual(['ADMIN']);
  });
});
