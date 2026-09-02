import { z } from "zod";

const fieldSchema = z.enum([
  "name",
  "city",
  "group",
  "phoneE164",
  "tags",
  "whatsappValid",
  // B.4 — espelho de backend/src/schemas/contracts/filter.schema.ts. Paridade
  // BYTE-A-BYTE: se o assistente aceitar algo que o back rejeita, o disparo
  // volta 400.
  "lastFailureReason",
]);
const opSchema = z.enum([
  "eq",
  "ne",
  "contains",
  "startsWith",
  "endsWith",
  "in",
  "notIn",
  "isNull",
  "notNull",
]);

export type Rule = {
  field:
    | "name"
    | "city"
    | "group"
    | "phoneE164"
    | "tags"
    | "whatsappValid"
    | "lastFailureReason";
  op:
    | "eq"
    | "ne"
    | "contains"
    | "startsWith"
    | "endsWith"
    | "in"
    | "notIn"
    | "isNull"
    | "notNull";
  value?: string | number | boolean | string[];
};

export type FilterGroup = {
  combinator: "and" | "or";
  rules: Array<Rule | HistoryRule | FilterGroup>;
};

const ruleSchema: z.ZodType<Rule> = z.object({
  field: fieldSchema,
  op: opSchema,
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .optional(),
});

/**
 * Espelho do enum Prisma `FailureReason` (backend/prisma/schema.prisma). O
 * front não importa @prisma/client, então os 11 valores são mantidos à mão
 * aqui — se o enum do back mudar, este array precisa mudar junto (nenhum
 * teste automático garante a sincronia entre os dois arquivos).
 */
export const FAILURE_REASONS = [
  "SEM_WHATSAPP",
  "OPT_OUT",
  "MARKETING_DESLIGADO",
  "SEM_CONSENTIMENTO",
  "FORA_DA_JANELA",
  "LIMITE_DIARIO",
  "TELEFONE_INVALIDO",
  "TEMPLATE_INDISPONIVEL",
  "CANAL_FORA",
  "INDETERMINADO",
  "OUTRO",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * F2 T9 — rótulo em PT-BR de cada `FailureReason`, espelhando
 * `FAILURE_REASON_LABELS` de `backend/src/modules/campaigns/failure-reason.ts`
 * byte-a-byte (o back não expõe esse mapa fora do endpoint
 * `/campaigns/:id/failure-reasons`, que é escopado por campanha — a coluna de
 * contatos precisa do rótulo sem depender de uma campanha específica).
 * Consumida pela coluna de contatos e por qualquer outro lugar que precise
 * mostrar o motivo sem reclassificar o slug por conta própria.
 */
export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  SEM_WHATSAPP: "Número não tem WhatsApp",
  OPT_OUT: "Destinatário optou por sair (opt-out)",
  MARKETING_DESLIGADO: "Desligou mensagens de marketing",
  SEM_CONSENTIMENTO: "Sem consentimento para esta finalidade",
  FORA_DA_JANELA: "Fora da janela de atendimento de 24h",
  LIMITE_DIARIO: "Limite diário de marketing do destinatário estourado",
  TELEFONE_INVALIDO: "Telefone inválido",
  TEMPLATE_INDISPONIVEL: "Template indisponível no provedor",
  CANAL_FORA: "Canal fora do ar ou desautorizado",
  INDETERMINADO: "Falha indeterminada — resultado da entrega é desconhecido",
  OUTRO: "Outro motivo",
};

export type HistoryRule = {
  kind: "history";
  event: "received" | "failed" | "replied";
  negate: boolean;
  campaignIds?: string[];
  templateIds?: string[];
  failureReason?: FailureReason;
};

// Espelho fiel de backend/src/schemas/contracts/filter.schema.ts
// (historyRuleSchema). Paridade BYTE-A-BYTE de validação: se o wizard aceitar
// algo que o backend rejeita, o disparo volta 400.
export const historyRuleSchema: z.ZodType<HistoryRule> = z
  .object({
    kind: z.literal("history"),
    event: z.enum(["received", "failed", "replied"]),
    negate: z.boolean(),
    campaignIds: z.array(z.string().min(1)).max(100).optional(),
    templateIds: z.array(z.string().min(1)).max(100).optional(),
    // F2 T5: tightened from F1's z.string().min(1) to a closed z.enum with
    // the same 11 members as the backend's z.nativeEnum(FailureReason).
    failureReason: z.enum(FAILURE_REASONS).optional(),
  })
  // Restrições globais §48: um nó de histórico sem alvo (nenhuma campanha ou
  // template) casaria com "qualquer envio", o que silenciosamente vira um
  // filtro vazio (ou universal) no backend — nunca o que o operador quis
  // dizer. failureReason só faz sentido quando o evento é uma falha; nos
  // outros eventos ele é um campo órfão que não tem contrapartida no Prisma.
  .superRefine((rule, ctx) => {
    const hasCampaigns = (rule.campaignIds?.length ?? 0) > 0;
    const hasTemplates = (rule.templateIds?.length ?? 0) > 0;

    if (!hasCampaigns && !hasTemplates) {
      // Médio (review F1 T2): emitir SÓ em `path:['campaignIds']` fixava a
      // culpa nesse campo mesmo quando foi templateIds que o operador tentou
      // preencher (e errou) — o front não tinha como saber em qual dos dois
      // campos desenhar o erro. Emitir um addIssue por campo (mesma
      // mensagem) deixa os dois inputs marcáveis.
      const message =
        "history rule requires a non-empty target: at least one of campaignIds/templateIds";
      ctx.addIssue({ code: "custom", message, path: ["campaignIds"] });
      ctx.addIssue({ code: "custom", message, path: ["templateIds"] });
    }

    if (rule.failureReason !== undefined && rule.event !== "failed") {
      ctx.addIssue({
        code: "custom",
        message: 'failureReason is only allowed when event is "failed"',
        path: ["failureReason"],
      });
    }
  });

export const filterGroupSchema: z.ZodType<FilterGroup> = z.object({
  combinator: z.enum(["and", "or"]),
  rules: z.array(
    z.union([ruleSchema, historyRuleSchema, z.lazy(() => filterGroupSchema)]),
  ),
});

export const variableMapSchema = z.record(
  z.string(),
  z.discriminatedUnion("source", [
    z.object({ source: z.literal("field"), field: z.string() }),
    z.object({ source: z.literal("literal"), value: z.string() }),
  ]),
);
export type VariableMap = z.infer<typeof variableMapSchema>;

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const scheduleConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("IMMEDIATE") }),
  z.object({
    type: z.literal("ONCE_AT"),
    runAt: z.coerce.date(),
  }),
  z.object({
    type: z.literal("DAILY_AT"),
    time: z.string().regex(TIME_REGEX, "Use formato HH:mm"),
  }),
  z.object({
    type: z.literal("WEEKLY"),
    time: z.string().regex(TIME_REGEX, "Use formato HH:mm"),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1, "Selecione ao menos um dia"),
  }),
  z.object({
    type: z.literal("INTERVAL"),
    everyMinutes: z
      .number()
      .int()
      .min(5)
      .max(60 * 24 * 30),
  }),
]);
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;
export type ScheduleType = ScheduleConfig["type"];

/**
 * C2 — a organização opera em MANAUS (UTC-4, sem horário de verão). O default
 * anterior (America/Sao_Paulo, UTC-3) fazia toda campanha agendada disparar 1h
 * mais cedo. Espelha `TIMEZONE_DEFAULT` do backend
 * (backend/src/schemas/contracts/schedule.schema.ts). O fuso é gravado POR
 * CAMPANHA: campanhas já criadas mantêm o fuso que têm.
 */
export const TIMEZONE_DEFAULT = "America/Manaus";

export const createCampaignSchema = z.object({
  name: z.string().min(1),
  templateId: z.string(),
  defaultInstanceId: z.string().cuid("Selecione a conexão"),
  filters: filterGroupSchema,
  variableMap: variableMapSchema,
  schedule: scheduleConfigSchema.default({ type: "IMMEDIATE" }),
  timezone: z.string().default(TIMEZONE_DEFAULT),
  /**
   * Typing-indicator delay in ms. 0 disables the indicator (current
   * behaviour). Operators tend to set 1500–2500ms for small batches to
   * mimic a human typing.
   */
  presenceDelayMs: z.number().int().min(0).max(60_000).optional(),
  /**
   * C1b — a finalidade declarada da campanha (key de ConsentPurpose). O gate de
   * dispatch só envia para quem consentiu PARA ESTA finalidade: consentir para
   * `convite_atividades` não autoriza `captacao_recursos` (LGPD art. 8º §4º —
   * autorização genérica é nula).
   *
   * Obrigatória em canal OFICIAL (TWILIO/META/ZERNIO) — o backend recusa a
   * criação sem ela, e o wizard bloqueia o avanço do passo 1. Opcional em
   * EVOLUTION (base legada + override), onde o gate segue existindo por força da
   * LGPD, mas não do contrato com a Meta.
   */
  purposeKey: z.string().min(1).optional(),
  /**
   * When true, bypasses the server-side blocking send-checks. The wizard only
   * sends this after the operator ticks "Entendo o risco" in the send-analysis
   * panel.
   */
  override: z.boolean().optional(),
  // A.1 — "Limitar aos primeiros N" saiu do contrato: o backend recusa o campo
  // (400) e quem dimensiona o envio é o 1º lote. Ver `legacyLimitRejectedSchema`
  // em backend/src/schemas/contracts/campaign.schema.ts.
  /**
   * Pedido do cliente (2026-08-25) — "excluir quem já recebeu" só excluía
   * quem já estava numa campanha do MESMO template. Ligado, a exclusão passa
   * a valer para QUALQUER campanha anterior (ativa ou cancelada). Espelha
   * `createCampaignSchema.excludeAnyPreviousCampaign` do backend
   * (`backend/src/schemas/contracts/campaign.schema.ts`). O front não repete
   * o `.default(false)` do backend — duplicar o default criaria duas fontes
   * da verdade; o wizard já nasce com o toggle desligado (estado local).
   */
  excludeAnyPreviousCampaign: z.boolean().optional(),
  /**
   * Pedido do cliente (2026-08-25) — o operador concorda, ao criar a
   * campanha, com a janela de horário comercial (8h–20h) do canal. Espelha
   * `createCampaignSchema.respeitarJanelaDeEnvio` do backend
   * (`backend/src/schemas/contracts/campaign.schema.ts`) — a janela
   * (`Channel.sendWindow*`) só tem efeito visível em canal DE SESSÃO
   * (EVOLUTION); canais OFICIAIS (ZERNIO em produção) nunca a respeitaram.
   * `true` (default no backend) mantém o comportamento atual; o wizard já
   * nasce com o toggle ligado.
   */
  respeitarJanelaDeEnvio: z.boolean().optional(),
});
export type CreateCampaign = z.infer<typeof createCampaignSchema>;

export type CampaignSummary = {
  id: string;
  name: string;
  templateId: string;
  /**
   * O canal por onde a campanha envia. Já vinha no fio (`listAll` devolve a
   * linha inteira da campanha) e só não estava declarado — é ele que liga a
   * linha da lista à quota do canal, sem uma consulta por linha.
   */
  defaultInstanceId?: string;
  /** Fuso da campanha (default America/Manaus). Usado para o horário do reset. */
  timezone?: string;
  template?: { metaName: string; language: string };
  totalRecipients: number;
  status: "DRAFT" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  scheduleType?: ScheduleType;
  scheduleEnabled?: boolean;
  nextRunAt?: string | Date | null;
  lastRunAt?: string | Date | null;
  runCount?: number;
  createdAt: string | Date;
  startedAt?: string | Date | null;
  finishedAt?: string | Date | null;
  statusCounts?: Array<{ status: string; _count: number }>;
};

export type CampaignDetail = CampaignSummary & {
  filters: FilterGroup;
  variableMap: VariableMap;
  scheduleConfig?: ScheduleConfig | null;
  timezone?: string;
  /** A finalidade declarada — é ela que o gate de consentimento consulta. */
  purposeKey?: string | null;
  template: {
    id: string;
    metaName: string;
    language: string;
    body: string;
    variables: string[];
  };
  statusCounts: Array<{ status: string; _count: number }>;
  /**
   * GATE SILENCIOSO — quantos o gate bloqueou. Sem estes números a campanha
   * aparecia com ZERO em todos os contadores e o operador concluía que o
   * sistema tinha quebrado (o dele achou, por horas, que era o agendamento).
   */
  skippedNoConsent?: number;
  skippedSuppressed?: number;
  skippedTotal?: number;
  /**
   * F2 T8 — CONTATOS distintos com falha retryável ainda não alcançados nesta
   * campanha (`countUnreachedFailedContacts` no back). Difere de
   * `statusCounts.FAILED`: uma pessoa com 3 tentativas FAILED conta 1 aqui e 3
   * lá. É este número — não a contagem bruta de linhas — que "Reenviar
   * falhas" de fato reenfileira.
   */
  retryableFailedCount?: number;
};

export type PreviewResult = {
  count: number;
  sample: { id: string; name: string | null; phoneE164: string }[];
  /**
   * ★ Quantos NÃO entraram por já estarem em outra campanha do mesmo template
   * (spec 2026-08-12). O dono escolheu a regra "sempre ligada, sem desligar" —
   * em troca a tela tem de DIZER o que aconteceu, senão o operador vê 88 onde
   * esperava 500 e não faz ideia do porquê. Foi exatamente esse tipo de
   * silêncio que custou a tarde de 2026-08-11.
   *
   * Opcional para tolerar resposta de um backend anterior a esta versão.
   */
  excludedSameTemplate?: number;
  /**
   * B.4 — quantos casaram o filtro mas são inválidos confirmados
   * (`whatsappValid: false` OU `lastFailureReason` em SEM_WHATSAPP/
   * TELEFONE_INVALIDO — ver `excludeInvalidGroup()` em `exclude-invalid.ts`)
   * e por isso não entraram na prévia. Mesmo motivo do opcional acima: tolera
   * uma resposta de um backend ainda sem este campo (Task 15, em paralelo).
   */
  excludedInvalid?: number;
};

export type PreflightResult = {
  total: number;
  reachable: number;
  invalid: number;
  unknown: number;
};

export type CheckSeverity = "info" | "warn" | "block";

export type SendCheck = {
  code:
    "VOLUME" | "FREQUENCY" | "REACHABILITY" | "OVERLAP" | "WINDOW" | "OPT_OUT";
  severity: CheckSeverity;
  message: string;
};

/**
 * C1b — quantos da audiência filtrada consentiram para a finalidade escolhida.
 * `null` enquanto não há finalidade: sem ela não existe número honesto a exibir.
 */
export type ConsentSummary = {
  purposeKey: string;
  /** Consentimento EXPLÍCITO (grant ativo para a finalidade). */
  withConsent: number;
  /**
   * Elegíveis só pela janela de atendimento de 24h (responderam há pouco e a
   * finalidade é a de serviço), sem opt-in explícito. O gate os autoriza.
   */
  viaOpenWindow: number;
  /**
   * O que o GATE deixaria passar: `withConsent ∪ viaOpenWindow`. É este — e não
   * `withConsent` — o número que a UI usa para decidir se há o que disparar:
   * usar o outro faria a tela bloquear um envio que o backend autorizaria.
   */
  eligible: number;
  /** Serão pulados pelo gate (SKIPPED_NO_CONSENT / SKIPPED_SUPPRESSED). */
  withoutConsent: number;
};

export type SendAnalysisResult = {
  recipients: number;
  reachability: {
    total: number;
    reachable: number;
    invalid: number;
    unknown: number;
  };
  checks: SendCheck[];
  consent?: ConsentSummary | null;
};

/** True when at least one check would block the run without an override. */
export function hasBlockingCheck(checks: SendCheck[]): boolean {
  return checks.some((c) => c.severity === "block");
}

export type MessageStatus =
  | "QUEUED"
  | "WAITING_INSTANCE"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "CANCELLED"
  // C1/C2 — pulados pelo gate de consentimento. Terminais: a mensagem nunca
  // foi ao provedor.
  /** Sem consentimento ATIVO para a finalidade da campanha. */
  | "SKIPPED_NO_CONSENT"
  /** Na SuppressionList (revogação global — absoluta, nem override fura). */
  | "SKIPPED_SUPPRESSED"
  /** Legado (T8, gate binário de opt-in): não é mais escrito, mas há linhas. */
  | "SKIPPED_NO_OPTIN";

export type CampaignMessage = {
  id: string;
  campaignId: string;
  contactId: string;
  providerMessageId: string | null;
  status: MessageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  variables: Record<string, string>;
  queuedAt: string | Date;
  sentAt: string | Date | null;
  deliveredAt: string | Date | null;
  readAt: string | Date | null;
  failedAt: string | Date | null;
  contact: {
    id: string;
    name: string | null;
    phoneE164: string;
    optedOut: boolean;
    city: string | null;
    tags: string[];
    profilePictureUrl: string | null;
  };
};

export type ListMessagesResponse = {
  items: CampaignMessage[];
  total: number;
  page: number;
  pageSize: number;
};

export type ListMessagesQuery = {
  page?: number;
  pageSize?: number;
  status?: MessageStatus;
  search?: string;
};

export const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Rascunho",
  QUEUED: "Na fila",
  RUNNING: "Em curso",
  COMPLETED: "Concluída",
  FAILED: "Falhou",
  CANCELLED: "Cancelada",
};

// ── ZE — CAMPANHA EM LOTES ───────────────────────────────────────────────────
// Espelha os contratos do backend (campaigns.controller: /batch-summary,
// /batches, /recipients). Não há pacote compartilhado — os tipos são mantidos
// à mão dos dois lados, como o resto deste arquivo.

/** Os três números do painel + o resto do contexto da campanha. */
export type BatchSummary = {
  /** Tamanho da audiência da campanha. */
  total: number;
  /** CONTATOS (distintos) que já receberam — o "grupo de enviadas". */
  sent: number;
  /** Quem ainda falta. É exatamente quem o próximo lote pegaria. */
  pending: number;
  /**
   * Em fila: QUEUED + SENDING + WAITING_INSTANCE. É o que está a caminho.
   * Opcional porque uma API anterior a esta mudança não devolve o campo.
   */
  inFlight?: number;
  /**
   * Aguardando o canal reconectar (WAITING_INSTANCE), isolado do resto: é a
   * única parcela da fila que tem culpado e conserto.
   */
  waiting?: number;
  /**
   * Desligaram mensagens de marketing no WhatsApp (Meta 131026/130472). Nunca
   * receberão um template de MARKETING — insistir só queima cota do tier.
   */
  unreachable: number;
  /** Falhas (as transitórias podem ser retentadas pelo botão "Reenviar falhas"). */
  failed: number;
  /** Pulados pelo gate de consentimento/supressão. */
  skipped: number;
  /** Se a campanha é de MARKETING (só nela os inalcançáveis são excluídos). */
  isMarketing: boolean;
  status: string;
};

export type CampaignBatch = {
  id: string;
  /** 1, 2, 3… — é como o operador chama o lote. */
  seq: number;
  requested: number;
  queued: number;
  skipped: number;
  startedAt: string;
  finishedAt: string | null;
  statusCounts: Array<{ status: MessageStatus; count: number }>;
};

export type SendBatchResult = {
  batchId: string;
  seq: number;
  requested: number;
  queued: number;
  skipped: number;
  /**
   * Contatos que NÃO entraram no lote porque já tinham mensagem viva nesta
   * campanha (um lote anterior ainda drenando).
   *
   * Fica FORA de `skipped` de propósito, do mesmo jeito que no backend:
   * `skipped` conta LINHAS de pulo gravadas pelo gate (existem no banco e
   * aparecem nos contadores); estas não geram linha nenhuma. É o número que
   * explica um `queued: 0` — sem ele, "0 enfileiradas" é uma resposta muda e a
   * reação natural do operador é clicar de novo.
   *
   * Opcional porque uma API anterior a esta mudança não devolve o campo.
   */
  skippedAlreadyLive?: number;
  /** Quantos ainda faltam DEPOIS deste lote. */
  remaining: number;
  /**
   * A.4 — o resumo pós-lote, na mesma resposta. Sem ele a tela redesenha com os
   * números de ANTES do envio até a próxima ronda do polling — e "Restam
   * 12.900" logo depois de mandar 500 é o que faz o operador clicar de novo.
   * Opcional: uma API anterior a esta mudança não o devolve.
   */
  summary?: BatchSummary;
};

/**
 * Os grupos da tela de destinatários, na ORDEM em que as abas aparecem.
 * Espelha `listCampaignRecipientsQuerySchema.group` de
 * backend/src/schemas/contracts/campaign.schema.ts — um grupo que só existe
 * de um lado é código morto: "failed" ficou meses no backend (rota, service e
 * `listFailedContactsPaged`) sem que a UI pudesse pedi-lo.
 */
export const RECIPIENT_GROUPS = [
  "sent",
  "pending",
  "unreachable",
  "skipped",
  "failed",
] as const;
export type RecipientGroup = (typeof RECIPIENT_GROUPS)[number];

export type CampaignRecipient = {
  id: string;
  name: string | null;
  phoneE164: string;
  marketingUndeliverableAt: string | null;
  marketingUndeliverableReason: string | null;
  /**
   * Por que o gate pulou este contato (`no_consent`, `suppressed`, …). Só vem
   * no grupo "skipped" — e é o que diz ao operador o que fazer a respeito.
   */
  skipReason?: string | null;
  /**
   * F2 — o motivo NORMALIZADO da falha, da Message FAILED mais recente deste
   * contato nesta campanha. Só vem no grupo "failed". `null` quando a falha é
   * anterior ao F2 (ou o canal não deu motivo nenhum).
   */
  failureReason?: FailureReason | null;
  /** O código cru do provedor, por baixo do motivo normalizado (diagnóstico). */
  errorCode?: string | null;
};

/**
 * F2 — uma linha de `GET /campaigns/:id/failure-reasons`: as Messages FAILED
 * da campanha agrupadas por motivo. É o mesmo denominador de
 * `BatchSummary.failed`, e ele é MAIOR que o `total` da lista de destinatários
 * falhados por TRÊS motivos que se acumulam:
 *
 *   1. conta MENSAGENS, não contatos — um contato que falhou duas vezes na
 *      campanha (retry que falhou de novo) conta duas aqui e uma na lista;
 *   2. NÃO passa pelo recorte de AUDIÊNCIA da lista (`resolveAudienceWhere` +
 *      `applyAudienceLimit`), e o `toPrismaWhere` da lista sempre AND-a
 *      `{ optedOut: false }`: quem falhou e depois respondeu "SAIR" continua
 *      contado aqui e some da lista;
 *   3. NÃO exclui quem já foi ALCANÇADO ou está EM VOO na campanha, exclusão
 *      que a lista aplica (`reachedOrInFlightInCampaign`) para não mostrar
 *      como "falha" alguém cuja falha transitória foi seguida de entrega no
 *      lote seguinte.
 *
 * Por isso o badge da aba ABERTA no `batch-panel` sai do `total` da própria
 * lista, e não daqui. O `label` vem pronto do backend (o mesmo
 * FAILURE_REASON_LABELS daqui).
 */
export type CampaignFailureReasonCount = {
  failureReason: FailureReason | null;
  count: number;
  label: string | null;
};

export type ListRecipientsResponse = {
  items: CampaignRecipient[];
  total: number;
  page: number;
  pageSize: number;
};
