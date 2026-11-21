import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Role } from '@prisma/client';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionsService } from '../permissions/permissions.service';
import { permissionsWith } from '../../shared/authz/actor.test-fixtures';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';
import { TeamAudienceService } from './team-audience.service';
import { TeamPanoramaController } from './team-panorama.controller';
import { TeamPanoramaService } from './team-panorama.service';
import { TeamWhatsappController } from './team-whatsapp.controller';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import { TeamWhatsappRetryService } from './team-whatsapp-retry.service';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import { TeamWhatsappService } from './team-whatsapp.service';

// DJ1 (aceite 3): o panorama fica ao lado do roster, com os mesmos portões
// globais na ordem real; papel e validação da data devolvem o mesmo que o roster.
const BASE = '/internal/team-whatsapp';
const openApps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** App com os dois controllers; só `panorama` e `roster` respondem. */
async function appAs(role: Role) {
  const panorama = { panorama: vi.fn().mockResolvedValue({ sectors: [] }) };
  const team = { roster: vi.fn().mockResolvedValue({ sectors: [] }) };
  const signedIn = (ctx: ExecutionContext) => {
    const user = { sub: 'actor-1', role };
    Object.assign(ctx.switchToHttp().getRequest<object>(), { user });
    return true;
  };
  const effectiveFor = (r: Role) => Promise.resolve(permissionsWith(r));
  const moduleRef = await Test.createTestingModule({
    controllers: [TeamWhatsappController, TeamPanoramaController],
    providers: [
      { provide: TeamPanoramaService, useValue: panorama },
      { provide: TeamWhatsappService, useValue: team },
      { provide: TeamWhatsappScheduleService, useValue: {} },
      { provide: TeamWhatsappResultsService, useValue: {} },
      { provide: TeamWhatsappRetryService, useValue: {} },
      { provide: TeamAudienceService, useValue: {} },
      { provide: PermissionsService, useValue: { effectiveFor } },
      { provide: APP_PIPE, useClass: ZodValidationPipe },
      { provide: APP_FILTER, useClass: DomainExceptionFilter },
      { provide: APP_GUARD, useValue: { canActivate: signedIn } },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  openApps.push(app);
  await app.init();
  const http = request(app.getHttpServer() as Parameters<typeof request>[0]);
  return { get: (path: string) => http.get(`${BASE}${path}`), panorama, team };
}

describe('TeamPanoramaController — portões (DJ1, aceite 3)', () => {
  it('aceite 3: VIEWER 403 do RolesGuard', async () => {
    const { get, panorama, team } = await appAs('VIEWER');
    const res = await get('/panorama?date=2026-11-20');
    const roster = await get('/roster?sectorIds=s1&date=2026-11-20');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'auth.insufficient_role' });
    expect((res.body as { code: string }).code).toBe(
      (roster.body as { code: string }).code,
    );
    expect(panorama.panorama).not.toHaveBeenCalled();
    expect(team.roster).not.toHaveBeenCalled();
  });

  it('aceite 3: sem date e com date inválida — 400 com o mesmo código que o roster devolve para a mesma query', async () => {
    const { get, panorama } = await appAs('ADMIN');
    for (const query of ['', '?date=2026-02-30', '?date=amanha']) {
      const res = await get(`/panorama${query}`);
      const sep = query ? '&' : '?';
      const roster = await get(`/roster${query}${sep}sectorIds=s1`);
      expect([res.status, roster.status]).toEqual([400, 400]);
      expect((res.body as { code: string }).code).toBe(
        (roster.body as { code: string }).code,
      );
    }
    expect(panorama.panorama).not.toHaveBeenCalled();
  });

  it('com papel de remetente repassa o ator, a data e a hora do pedido', async () => {
    const { get, panorama } = await appAs('OPERATOR');
    const before = Date.now();
    const res = await get('/panorama?date=2026-11-20');
    expect(res.status).toBe(200);
    const [actorId, query, now] = panorama.panorama.mock.calls[0] as [
      string,
      object,
      Date,
    ];
    expect([actorId, query]).toEqual(['actor-1', { date: '2026-11-20' }]);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });
});
