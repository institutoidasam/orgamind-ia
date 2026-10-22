import { Injectable } from '@nestjs/common';
import type {
  SectorContactCandidatesResponse,
  SectorPeopleCandidatesResponse,
  SectorPeopleResponse,
} from '../../schemas/contracts/sector-people.schema';
import { LevelsRepository } from '../levels/levels.repository';
import { ShiftsRepository } from '../shifts/shifts.repository';
import {
  sectorPeopleForbidden,
  sectorPeopleSectorNotFound,
} from './sector-people.errors';
import {
  canManageSector,
  canPickExisting,
  isSectorAdmin,
  type PeopleActor,
} from './sector-people.policy';
import {
  type SectorDetail,
  SectorPeopleRepository,
  toSectorPerson,
} from './sector-people.repository';

/**
 * Página do setor (C3/P1). Toda rota passa por `requireManageable` antes de
 * qualquer leitura de pessoas. Sem log: os dados aqui são nome e telefone (GC8).
 */
@Injectable()
export class SectorPeopleService {
  constructor(
    private readonly repo: SectorPeopleRepository,
    private readonly levels: LevelsRepository,
    private readonly shifts: ShiftsRepository,
  ) {}

  /** 403 para quem não gerencia; 404 só ao ADMIN (o gestor não descobre se o setor existe). */
  async requireManageable(
    actorId: string,
    sectorId: string,
  ): Promise<{ actor: PeopleActor; sector: SectorDetail }> {
    const [actor, sector] = await Promise.all([
      this.repo.findActor(actorId),
      this.repo.findSector(sectorId),
    ]);
    if (!actor) throw sectorPeopleForbidden();
    if (!sector) {
      throw isSectorAdmin(actor)
        ? sectorPeopleSectorNotFound()
        : sectorPeopleForbidden();
    }
    if (!canManageSector(actor, sector)) throw sectorPeopleForbidden();
    return { actor, sector };
  }

  async list(actorId: string, sectorId: string): Promise<SectorPeopleResponse> {
    const { actor, sector } = await this.requireManageable(actorId, sectorId);
    const viewer = { isAdmin: isSectorAdmin(actor) };
    const [rows, levels, shifts] = await Promise.all([
      this.repo.listPeople(sector.id),
      this.levels.listActive(),
      this.shifts.listAll(),
    ]);
    return {
      sector: {
        id: sector.id,
        name: sector.name,
        code: sector.code,
        isActive: sector.isActive,
        manager: sector.manager,
      },
      people: rows.map((row) => toSectorPerson(row, viewer)),
      options: {
        levels,
        shifts: shifts
          .filter((shift) => shift.isActive)
          .map(({ id, name }) => ({ id, name })),
      },
    };
  }

  async candidates(
    actorId: string,
    sectorId: string,
    q: string,
  ): Promise<SectorPeopleCandidatesResponse> {
    const { actor, sector } = await this.requireManageable(actorId, sectorId);
    const items = await this.repo.listCandidates({
      sectorId: sector.id,
      q,
      onlyUnassignedWithoutAccess: !isSectorAdmin(actor),
    });
    // A política confirma o recorte da consulta (D6) item a item.
    return {
      items: items.filter((item) =>
        canPickExisting(actor, sector, {
          id: item.id,
          sectorId: item.sector?.id ?? null,
          hasAccess: item.hasAccess,
          isActive: true,
        }),
      ),
    };
  }

  async contactCandidates(
    actorId: string,
    sectorId: string,
    q: string,
  ): Promise<SectorContactCandidatesResponse> {
    await this.requireManageable(actorId, sectorId);
    return { items: await this.repo.listContactCandidates(q) };
  }
}
