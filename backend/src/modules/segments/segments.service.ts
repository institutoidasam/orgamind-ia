import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SegmentsRepository } from './segments.repository';
import {
  SegmentNotFoundError,
  SegmentNameConflictError,
} from './errors/segments.errors';
// Reuse the campaigns filter→where converter so segments inherit the exact
// same semantics — including the unconditional `optedOut: false` guard.
import { toPrismaWhere } from '../campaigns/filter.converter';
// F1 T4 — mesmo choke point das campanhas: um nó history com templateIds
// precisa ser expandido em campaignIds ANTES do toPrismaWhere, ou o filtro
// nunca casa nada.
import { resolveHistoryTargets } from '../campaigns/history-filter.resolver';
import { AuditService } from '../../shared/audit/audit.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { FilterGroup } from '../../schemas/contracts/filter.schema';
import type {
  CreateSegment,
  UpdateSegment,
} from '../../schemas/contracts/segment.schema';

@Injectable()
export class SegmentsService {
  constructor(
    private readonly repo: SegmentsRepository,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  list() {
    return this.repo.listSummaries();
  }

  async getById(id: string) {
    const segment = await this.repo.findById(id);
    if (!segment) throw new SegmentNotFoundError(id);
    return segment;
  }

  async create(input: CreateSegment, createdById?: string) {
    const existing = await this.repo.findByName(input.name);
    if (existing) throw new SegmentNameConflictError(input.name);

    let result;
    try {
      result = await this.repo.create({
        name: input.name,
        description: input.description,
        filters: input.filters as Prisma.InputJsonValue,
        createdById,
      });
    } catch (err) {
      // The pre-check above is TOCTOU: a concurrent create with the same name
      // can slip in between findByName and create. The DB's unique constraint
      // is the real guard — map its P2002 violation to a 409 conflict instead
      // of letting it surface as an unhandled 500.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new SegmentNameConflictError(input.name);
      }
      throw err;
    }

    await this.audit.log('segment.create', 'Segment', result.id, {
      name: result.name,
    });
    return result;
  }

  async update(id: string, patch: UpdateSegment) {
    const segment = await this.repo.findById(id);
    if (!segment) throw new SegmentNotFoundError(id);

    // Guard the unique name: a rename to a name owned by ANOTHER segment is a
    // conflict; keeping (or re-setting) the segment's own name is fine.
    if (patch.name && patch.name !== segment.name) {
      const clash = await this.repo.findByName(patch.name);
      if (clash && clash.id !== id) {
        throw new SegmentNameConflictError(patch.name);
      }
    }

    const data = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      // When the audience filters change, the cached size is stale. Invalidate
      // it so the list shows "not calculated" until the next preview() recomputes
      // it, rather than displaying a misleading old count.
      ...(patch.filters !== undefined
        ? {
            filters: patch.filters as Prisma.InputJsonValue,
            lastCount: null,
            lastCountedAt: null,
          }
        : {}),
    };

    const result = await this.repo.update(id, data);
    await this.audit.log('segment.update', 'Segment', id, {
      fields: Object.keys(data),
    });
    return result;
  }

  async remove(id: string) {
    const segment = await this.repo.findById(id);
    if (!segment) throw new SegmentNotFoundError(id);
    const result = await this.repo.delete(id);
    await this.audit.log('segment.delete', 'Segment', id, {
      name: segment.name,
    });
    return result;
  }

  /**
   * Resolve the segment's audience: a precise count plus a 10-row sample.
   * Caches the count on the segment row so the list can show "last known size"
   * without re-scanning every time.
   */
  async preview(id: string): Promise<{ count: number; sample: unknown[] }> {
    const segment = await this.repo.findById(id);
    if (!segment) throw new SegmentNotFoundError(id);

    const resolved = await resolveHistoryTargets(
      segment.filters as unknown as FilterGroup,
      this.prisma,
    );
    const where = toPrismaWhere(resolved) as Prisma.ContactWhereInput;

    const [count, sample] = await Promise.all([
      this.repo.countContactsByWhere(where),
      this.repo.findContactsByWhere(where, 10),
    ]);

    await this.repo.updateCountCache(id, count);

    return { count, sample };
  }

  /**
   * WhatsApp reachability summary for the segment's audience, computed from the
   * cached `whatsappValid` flag (no live Evolution call).
   */
  async preflight(
    id: string,
  ): Promise<{ total: number; reachable: number; invalid: number; unknown: number }> {
    const segment = await this.repo.findById(id);
    if (!segment) throw new SegmentNotFoundError(id);

    const resolved = await resolveHistoryTargets(
      segment.filters as unknown as FilterGroup,
      this.prisma,
    );
    const where = toPrismaWhere(resolved) as Prisma.ContactWhereInput;

    return this.repo.preflightSummary(where);
  }
}
