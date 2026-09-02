import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SendingReconcilerProcessor,
  SENDING_STUCK_THRESHOLD_MS,
} from './sending-reconciler.processor';
import type { CampaignsRepository } from '../campaigns/campaigns.repository';
import type { CampaignsService } from '../campaigns/campaigns.service';
import type { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';

function makeMocks() {
  const repo = {
    findStuckSending: vi.fn().mockResolvedValue([]),
    recoverStuckSending: vi.fn().mockResolvedValue(1),
    findUnconfirmedSent: vi.fn().mockResolvedValue([]),
    applyReconciledDelivery: vi.fn().mockResolvedValue(1),
  };
  const campaigns = {
    maybeCompleteCampaign: vi.fn().mockResolvedValue(undefined),
  };
  // Channel-aware facade (T3): the reconciler decides per-row by the message's
  // channel provider. Only providers whose adapter can poll a delivery status by
  // id (cloud/Twilio) return true; Evolution cannot poll and is left to webhooks.
  const wa = {
    supportsStatusPollingFor: vi.fn((p: string) => p === 'TWILIO'),
    fetchMessageStatusFor: vi.fn().mockResolvedValue(undefined),
  };
  const processor = new SendingReconcilerProcessor(
    repo as unknown as CampaignsRepository,
    campaigns as unknown as CampaignsService,
    wa as unknown as WhatsappProvidersService,
  );
  return { processor, repo, campaigns, wa };
}

describe('SendingReconcilerProcessor', () => {
  let processor: SendingReconcilerProcessor;
  let repo: ReturnType<typeof makeMocks>['repo'];
  let campaigns: ReturnType<typeof makeMocks>['campaigns'];

  beforeEach(() => {
    vi.clearAllMocks();
    const m = makeMocks();
    processor = m.processor;
    repo = m.repo;
    campaigns = m.campaigns;
  });

  it('queries SENDING rows older than the stuck threshold', async () => {
    const before = Date.now();
    await processor.process();
    const cutoff = repo.findStuckSending.mock.calls[0][0] as Date;
    const after = Date.now();

    // cutoff ≈ now - SENDING_STUCK_THRESHOLD_MS
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - SENDING_STUCK_THRESHOLD_MS + 5);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(
      before - SENDING_STUCK_THRESHOLD_MS - 5_000,
    );
  });

  it('recovers each stuck row and notifies campaign completion', async () => {
    repo.findStuckSending.mockResolvedValue([
      { id: 'm1', campaignId: 'c1' },
      { id: 'm2', campaignId: 'c2' },
    ]);

    await processor.process();

    expect(repo.recoverStuckSending).toHaveBeenCalledWith('m1');
    expect(repo.recoverStuckSending).toHaveBeenCalledWith('m2');
    // After recovering (→ FAILED) we let the campaign close if its queue drained.
    expect(campaigns.maybeCompleteCampaign).toHaveBeenCalledWith('c1');
    expect(campaigns.maybeCompleteCampaign).toHaveBeenCalledWith('c2');
  });

  it('does NOT call maybeCompleteCampaign when recovery lost the race (count=0)', async () => {
    // markSent won the race between the find and the recover update.
    repo.findStuckSending.mockResolvedValue([{ id: 'm1', campaignId: 'c1' }]);
    repo.recoverStuckSending.mockResolvedValue(0);

    await processor.process();

    expect(campaigns.maybeCompleteCampaign).not.toHaveBeenCalled();
  });

  it('skips maybeCompleteCampaign for rows without a campaignId', async () => {
    repo.findStuckSending.mockResolvedValue([{ id: 'm1', campaignId: null }]);

    await processor.process();

    expect(repo.recoverStuckSending).toHaveBeenCalledWith('m1');
    expect(campaigns.maybeCompleteCampaign).not.toHaveBeenCalled();
  });

  it('continues past a per-row failure so one bad row does not abort the sweep', async () => {
    repo.findStuckSending.mockResolvedValue([
      { id: 'm1', campaignId: 'c1' },
      { id: 'm2', campaignId: 'c2' },
    ]);
    repo.recoverStuckSending.mockRejectedValueOnce(new Error('db hiccup'));

    await expect(processor.process()).resolves.toBeUndefined();

    expect(repo.recoverStuckSending).toHaveBeenCalledWith('m2');
  });

  it('resolves without error when there are no stuck rows', async () => {
    repo.findStuckSending.mockResolvedValue([]);
    await expect(processor.process()).resolves.toBeUndefined();
    expect(repo.recoverStuckSending).not.toHaveBeenCalled();
  });
});

describe('SendingReconcilerProcessor — status reconciliation per channel (B4)', () => {
  // A cloud (Twilio) channel row — the only kind whose status can be polled.
  const twilioRow = (over = {}) => ({
    id: 'm1',
    providerMessageId: 'SM1',
    campaignId: 'c1',
    contactId: 'contact-1',
    instance: { provider: 'TWILIO' as const },
    ...over,
  });

  it('polls a TWILIO-channel SENT row, upgrades it to DELIVERED, and closes the campaign', async () => {
    const { processor, repo, campaigns, wa } = makeMocks();
    repo.findUnconfirmedSent.mockResolvedValue([twilioRow()]);
    wa.fetchMessageStatusFor.mockResolvedValue({ status: 'delivered', rawStatus: 'delivered' });

    await processor.process();

    // Routed by the row's channel provider, not a deploy-global provider.
    expect(wa.fetchMessageStatusFor).toHaveBeenCalledWith('TWILIO', 'SM1');
    expect(repo.applyReconciledDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm1', newStatus: 'DELIVERED' }),
    );
    expect(campaigns.maybeCompleteCampaign).toHaveBeenCalledWith('c1');
  });

  it('maps a failed poll to FAILED with the Twilio error code + mapped message', async () => {
    const { processor, repo, wa } = makeMocks();
    repo.findUnconfirmedSent.mockResolvedValue([twilioRow()]);
    wa.fetchMessageStatusFor.mockResolvedValue({
      status: 'failed',
      rawStatus: 'undelivered',
      errorCode: '63003',
    });

    await processor.process();

    const call = repo.applyReconciledDelivery.mock.calls[0][0];
    expect(call.newStatus).toBe('FAILED');
    expect(call.errorCode).toBe('63003');
    expect(call.errorMessage).toMatch(/WhatsApp/i);
    // F2 — contactId (já selecionado por findUnconfirmedSent) é repassado
    // para o repository atualizar a flag durável do Contact best-effort.
    expect(call.contactId).toBe('contact-1');
  });

  it('leaves a still-pending (queued/sent) row untouched', async () => {
    const { processor, repo, wa } = makeMocks();
    repo.findUnconfirmedSent.mockResolvedValue([twilioRow()]);
    wa.fetchMessageStatusFor.mockResolvedValue({ status: 'sent', rawStatus: 'sent' });

    await processor.process();

    expect(repo.applyReconciledDelivery).not.toHaveBeenCalled();
  });

  it('does not close the campaign when the reconciled update no-ops (count 0)', async () => {
    const { processor, repo, campaigns, wa } = makeMocks();
    repo.findUnconfirmedSent.mockResolvedValue([twilioRow()]);
    wa.fetchMessageStatusFor.mockResolvedValue({ status: 'delivered', rawStatus: 'delivered' });
    repo.applyReconciledDelivery.mockResolvedValue(0);

    await processor.process();

    expect(campaigns.maybeCompleteCampaign).not.toHaveBeenCalled();
  });

  // ── T3: per-channel gating (replaces the old deploy-global WHATSAPP_PROVIDER
  // gate). The message's channel provider decides eligibility, so a mixed deploy
  // polls exactly the rows whose provider can report a status by id. ───────────
  it('ignores EVOLUTION-channel rows — its provider cannot poll a status by id', async () => {
    const { processor, repo, wa } = makeMocks();
    repo.findUnconfirmedSent.mockResolvedValue([
      { id: 'm1', providerMessageId: 'BAE5xxxx', campaignId: 'c1', instance: { provider: 'EVOLUTION' } },
    ]);

    await processor.process();

    // The Evolution row is never polled or updated — the webhook advances it.
    expect(wa.fetchMessageStatusFor).not.toHaveBeenCalled();
    expect(repo.applyReconciledDelivery).not.toHaveBeenCalled();
  });

  it('skips a row whose provider adapter reports no status-polling capability', async () => {
    const { processor, repo, wa } = makeMocks();
    // Cloud channel, but this deploy's adapter can't poll (e.g. not configured).
    wa.supportsStatusPollingFor.mockReturnValue(false);
    repo.findUnconfirmedSent.mockResolvedValue([twilioRow()]);

    await processor.process();

    expect(wa.fetchMessageStatusFor).not.toHaveBeenCalled();
    expect(repo.applyReconciledDelivery).not.toHaveBeenCalled();
  });

  it('in a mixed batch, polls ONLY the cloud (TWILIO) rows and skips EVOLUTION', async () => {
    const { processor, repo, wa } = makeMocks();
    repo.findUnconfirmedSent.mockResolvedValue([
      { id: 'm1', providerMessageId: 'BAE5xxxx', campaignId: 'c1', instance: { provider: 'EVOLUTION' } },
      { id: 'm2', providerMessageId: 'SM2', campaignId: 'c2', instance: { provider: 'TWILIO' } },
    ]);
    wa.fetchMessageStatusFor.mockResolvedValue({ status: 'delivered', rawStatus: 'delivered' });

    await processor.process();

    expect(wa.fetchMessageStatusFor).toHaveBeenCalledTimes(1);
    expect(wa.fetchMessageStatusFor).toHaveBeenCalledWith('TWILIO', 'SM2');
    expect(wa.fetchMessageStatusFor).not.toHaveBeenCalledWith('EVOLUTION', 'BAE5xxxx');
    expect(repo.applyReconciledDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm2', newStatus: 'DELIVERED' }),
    );
  });

  it('continues past a per-row poll failure', async () => {
    const { processor, repo, wa } = makeMocks();
    repo.findUnconfirmedSent.mockResolvedValue([
      twilioRow({ id: 'm1', providerMessageId: 'SM1', campaignId: 'c1' }),
      twilioRow({ id: 'm2', providerMessageId: 'SM2', campaignId: 'c2' }),
    ]);
    wa.fetchMessageStatusFor
      .mockRejectedValueOnce(new Error('twilio 500'))
      .mockResolvedValueOnce({ status: 'delivered', rawStatus: 'delivered' });

    await expect(processor.process()).resolves.toBeUndefined();
    expect(wa.fetchMessageStatusFor).toHaveBeenCalledWith('TWILIO', 'SM2');
    expect(repo.applyReconciledDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm2', newStatus: 'DELIVERED' }),
    );
  });
});
