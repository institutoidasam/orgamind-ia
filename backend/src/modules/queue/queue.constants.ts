/**
 * Cleanup opts that EVERY repeatable add() must carry explicitly.
 *
 * Prod incident (2026-07-07): BullMQ snapshots the job opts inside the stored
 * repeat definition in Redis. The connection-reconciler's definition predated
 * the queue's defaultJobOptions cleanup rules, so its 30s ticks accumulated
 * ~76k completed-job records that the newer defaults never pruned. Passing
 * these opts at add() time bakes them into new definitions. NOTE: changing
 * these values does NOT update an ALREADY-STORED definition — you must delete
 * the queue's `bull:<name>:*` keys in Redis and restart the worker so the
 * definition re-registers.
 */
export const REPEATABLE_JOB_CLEANUP_OPTS = {
  removeOnComplete: { age: 3600, count: 10 },
  removeOnFail: { age: 86400, count: 50 },
} as const;

export const QUEUE_NAMES = {
  WHATSAPP_SEND: 'whatsapp.send-message',
  TOKEN_CHECK: 'whatsapp.check-token-expiry',
  CAMPAIGN_SCHEDULER: 'campaign.scheduler',
  CLEANUP_EVENTS: 'maintenance.cleanup-events',
  CONTACT_SYNC: 'whatsapp.contact-sync',
  CONTACT_SYNC_CRON: 'whatsapp.contact-sync.cron',
  CHAT_MEDIA_DOWNLOAD: 'chat.media-download',
  CHAT_HISTORY_SYNC: 'chat.history-sync',
  CONNECTION_RECONCILER: 'whatsapp.connection-reconciler',
  // O mesmo papel do CONNECTION_RECONCILER, para GOZAP: aquele é Evolution-only
  // (pula todo canal sem evolutionInstanceName) e deixava canais GoZap
  // pareados permanentemente "offline" aos olhos do roteador de envio.
  GOZAP_CONNECTION_RECONCILER: 'gozap.connection-reconciler',
  /**
   * A rede das mensagens estacionadas: varre pelo lado das MENSAGENS, não dos
   * canais, para que nenhum filtro de provedor consiga esconder uma parada.
   * Ver `parked-messages-sweeper.processor.ts` (incidente 2026-08-14).
   */
  PARKED_MESSAGES_SWEEP: 'messages.parked-sweep',
  SENDING_RECONCILER: 'campaign.sending-reconciler',
  TEMPLATE_APPROVAL_SYNC: 'templates.approval-sync',
  ZERNIO_TEMPLATE_SYNC: 'templates.zernio-sync',
  TWILIO_TIER_SYNC: 'twilio.tier-sync',
  ZERNIO_TIER_SYNC: 'zernio.tier-sync',
  ZERNIO_INBOX_SYNC: 'zernio.inbox-sync',
  // ZD — espelho dos disparos (`GET /broadcasts`) + volume diário
  // (`GET /analytics/inbox/volume`). Uma fila só para os dois: ambos bebem do
  // MESMO balde de 60 req/min, e `concurrency: 1` garante que nunca rodem em
  // paralelo dobrando o consumo.
  ZERNIO_BROADCAST_SYNC: 'zernio.broadcast-sync',
  // ZB — o caminho de ESCRITA: a campanha do orgamind vira um BROADCAST de verdade
  // no painel do Zernio (POST /broadcasts → /recipients → /send).
  ZERNIO_BROADCAST_DISPATCH: 'zernio.broadcast-dispatch',
  // ZW — o RECONCILIADOR LENTO do broadcast (GET /{id}/recipients).
  //
  // NÃO é a fonte da verdade do status: quem é, é o WEBHOOK. O desenho original
  // era o inverso (a doc descreve `message.sent` como "sent FROM THE INBOX" e não
  // promete os `message.*` para broadcast), mas a sondagem AO VIVO desmentiu os
  // dois lados: o webhook DISPARA para broadcast, em tempo real, com o wamid; e o
  // `/recipients` não devolve wamid, nem timestamps, nem errorCode — e reporta
  // todo mundo como `pending` indefinidamente.
  //
  // Sobrou para ele o papel de rede de segurança do que o webhook perdeu (ele é
  // at-least-once, mas vai para dead-letter depois de ~51h). Roda DEVAGAR: o
  // balde de 60 req/min é o MESMO do envio, e o envio tem prioridade.
  ZERNIO_BROADCAST_POLL: 'zernio.broadcast-poll',
  // ZB — o KILL-SWITCH: cancelar no Zernio os disparos em voo de uma campanha.
  // Fila (e não chamada direta) para que CampaignsService.cancel() não precise
  // depender do módulo de provedores — e para que o cancelamento sobreviva a um
  // erro de rede sem derrubar o cancel da campanha.
  ZERNIO_BROADCAST_CANCEL: 'zernio.broadcast-cancel',
  EXCEL_IMPORT: 'imports.excel',
  BOT_REPLY: 'bot.reply',
} as const;

/** ZB — um lote de mensagens do orgamind para virar UM broadcast no Zernio. */
export type ZernioBroadcastDispatchJob = {
  campaignId: string;
  channelId: string;
  /** As Messages (já QUEUED) deste pedaço. O gate ainda roda sobre elas. */
  messageIds: string[];
  correlationId?: string;
};

/** ZB — pollar o status por destinatário de UM disparo. */
export type ZernioBroadcastPollJob = {
  /** O id LOCAL da linha ZernioBroadcast (não o id do Zernio). */
  localBroadcastId: string;
  channelId: string;
  /** Quantas vezes já pollamos — o polling desiste em algum momento. */
  attempt?: number;
};

/** ZB — cancelar no Zernio todos os disparos vivos de uma campanha. */
export type ZernioBroadcastCancelJob = {
  campaignId: string;
};

export type SendMessageJob = {
  messageId: string;
  campaignId: string;
  /**
   * Correlation id of the request that enqueued this job, used for log
   * tracing across HTTP -> queue -> worker. Optional because legacy jobs
   * persisted before this field was added may not have it.
   */
  correlationId?: string;
};

export type ContactSyncJob = {
  /** Up to 50 ids (matches /chat/whatsappNumbers batch limit). */
  contactIds: string[];
  triggeredBy: 'create' | 'import' | 'backfill' | 'periodic';
  correlationId?: string;
};

export type ChatHistorySyncJob = {
  instanceId: string;
  maxPagesPerChat?: number;
};

/**
 * Excel contact-import job (A8 deeper fix). The uploaded .xlsx is base64-encoded
 * into the payload (files are ≤10MB capped, so this is simple and avoids any
 * shared-volume dependency between api and worker). `batchId` points at the
 * PENDING ImportBatch row the controller created up-front.
 */
export type ExcelImportJob = {
  batchId: string;
  filename: string;
  /** base64-encoded .xlsx buffer (≤10MB). */
  fileBase64: string;
  /**
   * C4 (§3.3) — finalidade padrão do lote de fichas de papel, quando a planilha
   * não traz a coluna `finalidade`. A coluna da LINHA sempre vence.
   */
  purposeKey?: string;
  /**
   * C4 (§3.3) — o OPERADOR que subiu a planilha. Vira `ConsentEvent.actorUserId`:
   * um consentimento de papel não é ato do titular dentro do orgamind (alguém o
   * transcreveu), e o worker não tem `req.user` para descobrir isso sozinho.
   */
  actorUserId?: string;
  correlationId?: string;
};

export type ChatMediaDownloadJob = {
  messageMediaId: string;
  messageId: string;
  conversationId: string;
  instanceId: string;
  evolutionInstanceName: string;
  providerMessageId: string;
  remoteJid: string;
  kind: string;
  mimeType: string | null;
  fromMe: boolean;
  /**
   * Provider-hosted media URL (Twilio `MediaUrl0`). Present → the processor
   * downloads via TwilioMediaService (Basic Auth + redirect); absent/null →
   * Evolution path (getMediaBase64 by message key). Optional so jobs enqueued
   * before this field existed still deserialize.
   */
  mediaUrl?: string | null;
};

export type BotReplyJob = {
  conversationId: string;
  messageId: string;
  correlationId?: string;
};
