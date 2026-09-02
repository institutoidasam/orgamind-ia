import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { TemplateStatus, TemplateCategory } from '@prisma/client';
import {
  TwilioContentService,
  type TwilioContentItem,
} from '../whatsapp-providers/twilio-content.service';
import { TemplatesRepository } from './templates.repository';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * Twilio approval-status mapping (raw → local enum):
 *   received|pending      → PENDING   (Twilio recebeu / Meta revisando)
 *   approved              → APPROVED
 *   rejected              → REJECTED
 *   paused|disabled       → PAUSED    (feedback negativo / desativado)
 *   ausente ou desconhecido (in_appeal, unsubmitted, …) → PENDING — default
 *   seguro: um status que não conhecemos nunca pode liberar envio.
 */
export function mapTwilioApprovalStatus(
  raw: string | undefined | null,
): TemplateStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'approved':
      return TemplateStatus.APPROVED;
    case 'rejected':
      return TemplateStatus.REJECTED;
    case 'paused':
    case 'disabled':
      return TemplateStatus.PAUSED;
    default:
      return TemplateStatus.PENDING;
  }
}

/**
 * Body of a Content template: prefer the `twilio/text` type (the plain-text
 * fallback every template should carry), else the first type that has a
 * `body`, else ''.
 */
export function extractBodyFromTypes(
  types: TwilioContentItem['types'],
): string {
  const text = types['twilio/text']?.body;
  if (typeof text === 'string') return text;
  for (const key of Object.keys(types)) {
    const body = types[key]?.body;
    if (typeof body === 'string') return body;
  }
  return '';
}

/** Twilio category → local enum; anything else → undefined (don't write). */
function mapTwilioCategory(
  raw: string | undefined,
): TemplateCategory | undefined {
  switch ((raw ?? '').toUpperCase()) {
    case 'MARKETING':
      return TemplateCategory.MARKETING;
    case 'UTILITY':
      return TemplateCategory.UTILITY;
    case 'AUTHENTICATION':
      return TemplateCategory.AUTHENTICATION;
    default:
      return undefined;
  }
}

/**
 * Template approval-status reconciler (T2, twilio-platform).
 *
 * Twilio has NO approval webhook — the canonical way to learn that a template
 * was approved/rejected/paused is polling `GET /v1/ContentAndApprovals`. This
 * processor runs every ~2 min as a BullMQ repeatable job (registered in
 * worker.ts) and upserts the whole Twilio catalog into the Template table:
 *
 *  - `verify_auto_created` (Twilio Verify noise) is filtered out, but its sid
 *    still counts as "present at Twilio" for the removal check below.
 *  - Upsert key is `twilioContentSid`. New sids create a provider=TWILIO row;
 *    known sids only refresh status/category/raw fields (body/language stay —
 *    submitted templates are immutable at Twilio anyway; drafts are T4's job).
 *  - Local provider=TWILIO templates whose sid was NOT returned by Twilio are
 *    marked REJECTED with reason "Template removido na Twilio".
 *
 * Mirrors the connection-reconciler pattern: concurrency 1, try/catch per
 * item (one bad item must not abort the loop), summary log per tick.
 */
@Processor(QUEUE_NAMES.TEMPLATE_APPROVAL_SYNC, { concurrency: 1 })
export class TemplateApprovalSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(TemplateApprovalSyncProcessor.name);

  constructor(
    private readonly twilioContent: TwilioContentService,
    private readonly templatesRepo: TemplatesRepository,
  ) {
    super();
  }

  async process(): Promise<void> {
    // Deploy without the Twilio credential group → nothing to sync (and no
    // 401 noise every 2 minutes).
    if (!this.twilioContent.configured) return;

    // A fetch failure throws and fails this tick (BullMQ records it); the
    // removal marking below must never run on a partial/failed catalog.
    const items = await this.twilioContent.listContentAndApprovals();

    // Every sid Twilio returned — including noise and items whose upsert
    // fails — is "present at Twilio" and must not be marked removed.
    const seenSids = items.map((i) => i.sid);

    let synced = 0;
    let noise = 0;
    let failed = 0;
    for (const item of items) {
      // Twilio Verify auto-creates this template on every account; it is not
      // an operator template and would only pollute the catalog.
      if (item.friendlyName === 'verify_auto_created') {
        noise++;
        continue;
      }
      try {
        await this.syncOne(item);
        synced++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `template-approval-sync: erro sincronizando ${item.sid} (${
            item.friendlyName
          }): ${err instanceof Error ? err.message : String(err)} — pulando`,
        );
      }
    }

    const removed = await this.templatesRepo.markTwilioRemoved(
      seenSids,
      new Date(),
    );

    this.logger.log(
      `template-approval-sync: total=${items.length} synced=${synced} noise=${noise} failed=${failed} removed=${removed}`,
    );
  }

  /** Upsert one Twilio Content item into the Template table (key: sid). */
  private async syncOne(item: TwilioContentItem): Promise<void> {
    const now = new Date();
    // Sem approval_requests = nunca submetido → raw 'draft' explícito (T4):
    // os gates de submit/edição de rascunho dependem desse marcador, e o
    // sync não pode apagá-lo a cada tick (null fica só como legado pré-T4).
    const rawStatus = item.approval?.status ?? 'draft';
    const status = mapTwilioApprovalStatus(rawStatus);
    const category = mapTwilioCategory(item.approval?.category);
    // '' (approved templates carry an empty rejection_reason) → null.
    const rejectionReason = item.approval?.rejectionReason || null;

    const existing = await this.templatesRepo.findByTwilioContentSid(item.sid);
    if (existing) {
      await this.templatesRepo.update(existing.id, {
        status,
        twilioApprovalStatus: rawStatus,
        twilioRejectionReason: rejectionReason,
        lastTwilioSyncAt: now,
        // Unknown/absent category → keep whatever the local row has.
        ...(category && { category }),
      });
      return;
    }

    // `metaName` is @unique. The approval name (or friendly_name for drafts)
    // may collide with an existing row of ANOTHER provider/sid (e.g. the same
    // template name synced from Meta/Evolution). Suffix `_tw` instead of
    // stealing that row; a second collision is left to the per-item try/catch
    // (logged and retried next tick — never seen in practice).
    const base = item.approval?.name || item.friendlyName;
    let metaName = base;
    if (await this.templatesRepo.findByMetaName(metaName)) {
      metaName = `${base}_tw`;
    }

    await this.templatesRepo.create({
      metaName,
      language: item.language ?? 'pt',
      body: extractBodyFromTypes(item.types),
      variables: Object.keys(item.variables),
      status,
      // Template.category is required — default UTILITY for never-submitted
      // drafts (same default TemplatesService.normalizeCategory uses).
      category: category ?? TemplateCategory.UTILITY,
      provider: 'TWILIO',
      twilioContentSid: item.sid,
      twilioApprovalStatus: rawStatus,
      twilioRejectionReason: rejectionReason,
      lastTwilioSyncAt: now,
    });
  }
}
