import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { DEFAULT_MATRIX } from '../../shared/authz/permissions';
import { findEffectivePermissions } from '../permissions/permissions.query';
import { PermissionsRepository } from '../permissions/permissions.repository';
import { PermissionsService } from '../permissions/permissions.service';
import type { TeamAudienceRequest } from './dto/create-team-dispatch.dto';
import {
  REFERENCE_DATE,
  noticeAt,
  seedPerson,
  seedWorld,
  startRecheckDeps,
  type RecheckDeps,
  type World,
} from './team-whatsapp.schedule-recheck.test-fixtures';

/**
 * Aceite 12 (I1/DI2/GI4), banco real: a chave `equipe.urgencia` decide quem
 * cria alerta urgente. Sem ela, a prévia e a criação de Urgência recusam com
 * 403 antes de ler setores ou pessoas; as outras finalidades seguem. Porta ao
 * vivo falsa (todo número aberto) e fila falsa: nenhum WhatsApp de verdade.
 */
const DENIED = {
  status: 403,
  code: 'auth.permission_denied',
  detail: 'Você não tem permissão para criar alerta urgente.',
};
const KEY = { role: 'SUPERVISOR', key: 'equipe.urgencia' } as const;

let deps: RecheckDeps;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ deps, stop } = await startRecheckDeps());
}, 180_000);

afterAll(async () => {
  await stop?.();
});

/** Setor com número e uma pessoa do 1º turno, gerido por um SUPERVISOR. */
async function supervisedSector(): Promise<{
  world: World;
  supervisorId: string;
}> {
  const world = await seedWorld(deps);
  await seedPerson(deps, world, 'Ana');
  const supervisor = await deps.prisma.user.create({
    data: {
      email: `${world.code}-sup@test.local`,
      password: 'x',
      role: 'SUPERVISOR',
    },
  });
  await deps.prisma.sector.update({
    where: { id: world.sectorId },
    data: { managerId: supervisor.id },
  });
  return { world, supervisorId: supervisor.id };
}

/** Linha da matriz (SUPERVISOR, equipe.urgencia); `null` = sem linha (padrão desligado). */
async function supervisorUrgency(granted: boolean | null): Promise<void> {
  await deps.prisma.rolePermission.deleteMany({ where: KEY });
  if (granted === null) return;
  await deps.prisma.rolePermission.create({ data: { ...KEY, granted } });
}

const urgencyOf = (world: World): TeamAudienceRequest =>
  noticeAt(world, {
    purpose: 'urgency',
    when: 'now',
    at: undefined,
    urgencyReason: 'Vazamento no galpão',
  });

const meetingOf = (world: World): TeamAudienceRequest =>
  noticeAt(world, {
    purpose: 'meeting',
    when: 'now',
    at: undefined,
    activity: { date: REFERENCE_DATE, time: '15:00', place: 'Sala 2' },
  });

/** Espia toda leitura de setores e pessoas (e a gravação) do envio. */
function spyAudienceReads() {
  const repo = deps.repo;
  const spies = [
    vi.spyOn(deps.audience, 'resolve'),
    vi.spyOn(repo, 'findSector'),
    vi.spyOn(repo, 'listActiveSectorIds'),
    vi.spyOn(repo, 'listActiveShifts'),
    vi.spyOn(repo, 'loadDayPeopleMany'),
    vi.spyOn(repo, 'findSectorChannels'),
    vi.spyOn(repo, 'findTargetUser'),
    vi.spyOn(repo, 'createDispatch'),
  ];
  return {
    calls: () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

describe('alerta urgente sem a chave equipe.urgencia (aceite 12)', () => {
  it('aceite 12: SUPERVISOR sem a chave — prévia e criação de Urgência 403 com o texto, sem ler setores nem pessoas', async () => {
    await supervisorUrgency(null);
    const { world, supervisorId } = await supervisedSector();
    const request = urgencyOf(world);
    const reads = spyAudienceReads();
    try {
      await expect(
        deps.audience.preview(supervisorId, request),
      ).rejects.toMatchObject(DENIED);
      await expect(
        deps.service.dispatch(supervisorId, request),
      ).rejects.toMatchObject(DENIED);
      expect(reads.calls()).toBe(0);
    } finally {
      reads.restore();
    }
    const stored = await deps.prisma.teamWhatsappDispatch.count({
      where: { authorId: supervisorId },
    });
    expect(stored).toBe(0);
  });

  it('reunião sem a chave — segue', async () => {
    await supervisorUrgency(false);
    const { world, supervisorId } = await supervisedSector();

    const shown = await deps.audience.preview(supervisorId, meetingOf(world));

    expect(shown.included.map((person) => person.name)).toEqual(['Ana']);
  });
});

describe('alerta urgente com a chave na matriz (aceite 12)', () => {
  it('aceite 12: com linha RolePermission (SUPERVISOR, equipe.urgencia, granted) — a prévia de Urgência passa do portão', async () => {
    await supervisorUrgency(true);
    const { world, supervisorId } = await supervisedSector();

    const shown = await deps.audience.preview(supervisorId, urgencyOf(world));

    expect(shown.audienceKey).toEqual(expect.any(String));
  });

  it('aceite 12: com linha RolePermission (SUPERVISOR, equipe.urgencia, granted) — SUPERVISOR cria a Urgência (envio gravado com purpose URGENCY)', async () => {
    await supervisorUrgency(true);
    const { world, supervisorId } = await supervisedSector();
    const request = urgencyOf(world);
    const shown = await deps.audience.preview(supervisorId, request);

    const created = await deps.service.dispatch(supervisorId, {
      ...request,
      audienceKey: shown.audienceKey,
    });

    const stored = await deps.prisma.teamWhatsappDispatch.findUniqueOrThrow({
      where: { id: created.dispatchId },
      select: { authorId: true, purpose: true },
    });
    expect(stored).toEqual({ authorId: supervisorId, purpose: 'URGENCY' });
  });
});

describe('matriz de permissões e a chave equipe.urgencia (aceite 12)', () => {
  it('matriz aceita gravar equipe.urgencia para SUPERVISOR', async () => {
    await supervisorUrgency(null);
    const { world, supervisorId } = await supervisedSector();
    const audit = new AuditService(new AuditRepository(deps.prisma as never), {
      get: () => undefined,
    } as never);
    const permissions = new PermissionsService(
      deps.prisma as never,
      new PermissionsRepository(deps.prisma as never),
      audit,
    );

    const saved = await permissions.save(world.adminId, {
      roles: {
        SUPERVISOR: [...DEFAULT_MATRIX.SUPERVISOR, 'equipe.urgencia'],
        OPERATOR: [...DEFAULT_MATRIX.OPERATOR],
      },
    });

    expect(saved.roles.SUPERVISOR).toContain('equipe.urgencia');
    expect(
      await findEffectivePermissions(deps.prisma as never, 'SUPERVISOR'),
    ).toContain('equipe.urgencia');
    const shown = await deps.audience.preview(supervisorId, urgencyOf(world));
    expect(shown.audienceKey).toEqual(expect.any(String));
  });
});
