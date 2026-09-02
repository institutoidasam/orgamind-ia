import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { CampaignsRepository } from '../campaigns/campaigns.repository';
import { CampaignsService } from '../campaigns/campaigns.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { classifyTwilioError } from '../whatsapp-providers/adapters/twilio-error-mapper';
import { QUEUE_NAMES } from './queue.constants';
import { parseEnvNumber } from './env-number.helper';
import type { ChannelProvider } from '@prisma/client';

/**
 * An unconfirmed-SENT row enriched with its channel's provider. The provider is
 * what decides whether we can poll a delivery status by id (cloud/Twilio) or
 * must leave the row for a webhook (Evolution). `findUnconfirmedSent` is
 * expected to include `instance: { select: { provider: true } }`; the field is
 * modelled optional so this file compiles and degrades safely (a row with no
 * provider is simply skipped) if the select hasn't been widened yet.
 */
type UnconfirmedSentRow = Awaited<
  ReturnType<CampaignsRepository['findUnconfirmedSent']>
>[number] & { instance?: { provider: ChannelProvider } | null };

/**
 * How long a message may sit in SENDING before the reconciler treats it as
 * stuck. Must be comfortably longer than a normal send (provider call +
 * presence delay + pacing jitter). The pacing jitter alone can reach 45 s and
 * a burst pause is 5 min, so we use 10 min to avoid racing a slow-but-healthy
 * in-flight send.
 *
 * parseEnvNumber-guarded: a typo'd env becoming NaN would make the cutoff
 * `new Date(NaN)` and silently disable stuck-row recovery.
 */
export const SENDING_STUCK_THRESHOLD_MS = parseEnvNumber(
  process.env.SENDING_STUCK_THRESHOLD_MS,
  10 * 60 * 1000,
  'SENDING_STUCK_THRESHOLD_MS',
);

/** How many stuck rows to recover per tick (bounded to keep ticks cheap). */
const RECONCILER_BATCH = parseEnvNumber(
  process.env.SENDING_RECONCILER_BATCH,
  500,
  'SENDING_RECONCILER_BATCH',
);

/**
 * How long a cloud row may sit in SENT (accepted by the provider) without a
 * terminal delivery ack before the status reconciler polls the provider for its
 * real outcome. Long enough to let a healthy status callback arrive first
 * (avoid double work), short enough that failures surface during a multi-day
 * campaign.
 */
export const SENT_UNCONFIRMED_THRESHOLD_MS = parseEnvNumber(
  process.env.SENT_UNCONFIRMED_THRESHOLD_MS,
  15 * 60 * 1000,
  'SENT_UNCONFIRMED_THRESHOLD_MS',
);

/**
 * How many SENT rows to poll per tick. Each is one provider REST call, so keep
 * it modest to avoid hammering the provider (and our own rate budget).
 */
const STATUS_POLL_BATCH = parseEnvNumber(
  process.env.STATUS_POLL_BATCH,
  100,
  'STATUS_POLL_BATCH',
);

/**
 * A2 reconciler.
 *
 * The atomic claim flips QUEUED→SENDING *before* wa.send. If a worker crashes
 * (OOM / SIGKILL / pod eviction) between the claim and markSent — or between
 * markSent and the BullMQ ack — the row is stranded in SENDING with no live
 * job to advance it. This processor runs periodically (registered in
 * worker.ts), finds SENDING rows older than SENDING_STUCK_THRESHOLD_MS, and
 * recovers them.
 *
 * Recovery marks the row FAILED (errorCode 'sending_stuck'), NOT re-QUEUED: a
 * crash mid-pipeline means we cannot know whether the provider accepted the
 * message, and re-queueing would risk a real duplicate WhatsApp send — exactly
 * the failure A2 prevents. FAILED is the safe terminal state; an operator can
 * deliberately retry from the UI. recoverStuckSending is scoped to
 * status:'SENDING', so if markSent wins the race the row is left as SENT.
 *
 * Each row is recovered in its own try/catch so one bad row can't abort the
 * sweep for the rest.
 */
@Processor(QUEUE_NAMES.SENDING_RECONCILER, { concurrency: 1 })
export class SendingReconcilerProcessor extends WorkerHost {
  private readonly logger = new Logger(SendingReconcilerProcessor.name);

  constructor(
    private readonly repo: CampaignsRepository,
    private readonly campaigns: CampaignsService,
    private readonly wa: WhatsappProvidersService,
  ) {
    super();
  }

  async process(): Promise<void> {
    await this.recoverStuckSending();
    await this.reconcileUnconfirmedSent();
  }

  /**
   * A2 crash recovery — rows stranded in SENDING (worker died between claim and
   * markSent) older than the threshold are marked FAILED (safe terminal state;
   * we can't know if the provider accepted, so we never re-queue).
   */
  private async recoverStuckSending(): Promise<void> {
    const cutoff = new Date(Date.now() - SENDING_STUCK_THRESHOLD_MS);
    const stuck = await this.repo.findStuckSending(cutoff, RECONCILER_BATCH);
    if (stuck.length === 0) return;

    let recovered = 0;
    let raceLost = 0;
    let failed = 0;
    for (const row of stuck) {
      try {
        const count = await this.repo.recoverStuckSending(row.id);
        if (count === 0) {
          // markSent won the race between find and recover — row is now SENT.
          raceLost++;
          continue;
        }
        recovered++;
        // Recovered → FAILED. If this drained the campaign's queue, close it.
        if (row.campaignId) {
          await this.campaigns
            .maybeCompleteCampaign(row.campaignId)
            .catch((e) =>
              this.logger.warn({ err: e, campaignId: row.campaignId }, 'maybeCompleteCampaign failed'),
            );
        }
      } catch (err) {
        failed++;
        this.logger.warn(
          { err, messageId: row.id },
          'sending-reconciler: failed to recover row (skipping)',
        );
      }
    }

    this.logger.log(
      `sending-reconciler: stuck=${stuck.length} recovered=${recovered} raceLost=${raceLost} failed=${failed}`,
    );
  }

  /**
   * B4 status reconciler — rows accepted by the provider sit at SENT until a
   * status callback advances them. If the callback never arrives (webhook
   * off/misconfigured/lagging), poll the provider's REST API for the real
   * outcome and upgrade SENT → DELIVERED/READ/FAILED. This is the automated
   * safety net that surfaces failed deliveries (the ~11k unverified numbers) and
   * yields a purge list, even with the webhook down.
   *
   * T3: routing is PER CHANNEL, not deploy-global. Each row's channel provider
   * decides whether a status can be polled by id — cloud providers (Twilio) can,
   * Evolution/Baileys cannot, so Evolution rows are left for the webhook. This
   * replaces the old global WHATSAPP_PROVIDER gate: a mixed deploy now polls
   * exactly the rows whose provider supports it.
   */
  private async reconcileUnconfirmedSent(): Promise<void> {
    const cutoff = new Date(Date.now() - SENT_UNCONFIRMED_THRESHOLD_MS);
    const rows = (await this.repo.findUnconfirmedSent(
      cutoff,
      STATUS_POLL_BATCH,
    )) as UnconfirmedSentRow[];
    if (rows.length === 0) return;

    let resolved = 0;
    let stillPending = 0;
    let pollFailed = 0;
    let skipped = 0;
    for (const row of rows) {
      if (!row.providerMessageId) continue;
      // Per-channel gate: only poll when the message's channel provider can
      // report a delivery status by id. Evolution (and any row missing provider
      // info) is skipped — its delivery is advanced by the webhook, not polling.
      const provider = row.instance?.provider;
      if (!provider || !this.wa.supportsStatusPollingFor(provider)) {
        skipped++;
        continue;
      }
      try {
        const res = await this.wa.fetchMessageStatusFor(
          provider,
          row.providerMessageId,
        );
        const newStatus =
          res?.status === 'delivered'
            ? 'DELIVERED'
            : res?.status === 'read'
              ? 'READ'
              : res?.status === 'failed'
                ? 'FAILED'
                : undefined;
        if (!newStatus) {
          // Still queued/sent at the provider — leave SENT for a later tick.
          stillPending++;
          continue;
        }
        const errorMessage =
          newStatus === 'FAILED' && res?.errorCode
            ? classifyTwilioError(res.errorCode).message
            : undefined;
        const count = await this.repo.applyReconciledDelivery({
          messageId: row.id,
          newStatus,
          occurredAt: new Date(),
          errorCode: newStatus === 'FAILED' ? res?.errorCode : undefined,
          errorMessage,
          contactId: row.contactId,
        });
        if (count > 0) {
          resolved++;
          if (row.campaignId) {
            await this.campaigns
              .maybeCompleteCampaign(row.campaignId)
              .catch((e) =>
                this.logger.warn(
                  { err: e, campaignId: row.campaignId },
                  'maybeCompleteCampaign failed',
                ),
              );
          }
        }
      } catch (err) {
        pollFailed++;
        this.logger.warn(
          { err, messageId: row.id },
          'twilio-status-reconciler: failed to poll/apply (skipping)',
        );
      }
    }

    this.logger.log(
      `status-reconciler: checked=${rows.length} resolved=${resolved} stillPending=${stillPending} skipped=${skipped} pollFailed=${pollFailed}`,
    );
  }
}
