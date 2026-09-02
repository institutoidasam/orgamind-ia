import { Injectable } from '@nestjs/common';
import { Prisma, type Segment } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

export type CreateSegmentData = {
  name: string;
  description?: string;
  filters: Prisma.InputJsonValue;
  createdById?: string;
};

export type UpdateSegmentData = {
  name?: string;
  description?: string | null; // null clears the description
  filters?: Prisma.InputJsonValue;
  // Allow callers to invalidate the cached audience size when the filters
  // change so the list shows "not calculated" instead of a stale count.
  lastCount?: number | null;
  lastCountedAt?: Date | null;
};

@Injectable()
export class SegmentsRepository {
  /**
   * Hard upper bound on how many contact rows a single `findContactsByWhere`
   * call may fetch. `take` is required, but we still clamp it so a caller
   * passing an oversized value cannot pull the whole table into memory.
   */
  static readonly MAX_CONTACTS_TAKE = 10_000;

  constructor(private readonly prisma: PrismaService) {}

  listSummaries() {
    return this.prisma.segment.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        lastCount: true,
        lastCountedAt: true,
        createdAt: true,
      },
    });
  }

  findById(id: string) {
    return this.prisma.segment.findUnique({ where: { id } });
  }

  /**
   * Todo segmento com o `filters` CRU — usado pelo aviso de "apagar campanha"
   * (CampaignsService.getDependentSegments), que varre em memória por nós
   * history referenciando a campanha. `listSummaries()` não traz `filters` de
   * propósito (a listagem não precisa do JSON pesado); esta é a fonte que traz.
   */
  findAllWithFilters() {
    return this.prisma.segment.findMany({
      select: { id: true, name: true, filters: true },
    });
  }

  findByName(name: string) {
    return this.prisma.segment.findUnique({ where: { name } });
  }

  create(data: CreateSegmentData): Promise<Segment> {
    return this.prisma.segment.create({
      data: {
        name: data.name,
        description: data.description,
        filters: data.filters,
        createdById: data.createdById,
      },
    });
  }

  update(id: string, data: UpdateSegmentData): Promise<Segment> {
    return this.prisma.segment.update({ where: { id }, data });
  }

  delete(id: string): Promise<Segment> {
    return this.prisma.segment.delete({ where: { id } });
  }

  /** Cache the most recently computed audience size on the segment row. */
  updateCountCache(id: string, count: number): Promise<Segment> {
    return this.prisma.segment.update({
      where: { id },
      data: { lastCount: count, lastCountedAt: new Date() },
    });
  }

  countContactsByWhere(where: Prisma.ContactWhereInput): Promise<number> {
    return this.prisma.contact.count({ where });
  }

  /**
   * A amostra da prévia do segmento. `orderBy: { id: 'asc' }` é a MESMA ordem do
   * disparo (`campaigns.repository.findContactsPage`) — antes era
   * `createdAt: 'desc'`, a ordem OPOSTA, e a amostra mostrava o outro extremo da
   * lista em relação a quem realmente receberia.
   */
  findContactsByWhere(where: Prisma.ContactWhereInput, take: number) {
    return this.prisma.contact.findMany({
      where,
      take: Math.min(take, SegmentsRepository.MAX_CONTACTS_TAKE),
      orderBy: { id: 'asc' },
    });
  }

  /**
   * For a resolved `where` clause (the segment's audience filter), count
   * contacts grouped by their cached `whatsappValid` flag:
   *   - `true`  → reachable (checked and confirmed on WhatsApp)
   *   - `false` → invalid (checked and NOT on WhatsApp)
   *   - `null`  → unknown (never checked yet)
   *
   * Returns { total, reachable, invalid, unknown }.
   */
  async preflightSummary(
    where: Prisma.ContactWhereInput,
  ): Promise<{ total: number; reachable: number; invalid: number; unknown: number }> {
    // Run the three counts in one snapshot so concurrent writes can't make the
    // buckets inconsistent (e.g. a contact validated between counts inflating
    // reachable+invalid past total → a negative "unknown").
    const [total, reachable, invalid] = await this.prisma.$transaction(
      [
        this.prisma.contact.count({ where }),
        this.prisma.contact.count({ where: { ...where, whatsappValid: true } }),
        this.prisma.contact.count({ where: { ...where, whatsappValid: false } }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      total,
      reachable,
      invalid,
      // Defensive clamp: even with RepeatableRead, never report a negative bucket.
      unknown: Math.max(0, total - reachable - invalid),
    };
  }
}
