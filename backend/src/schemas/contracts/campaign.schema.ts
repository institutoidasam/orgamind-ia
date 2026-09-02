import { z } from 'zod';
import { filterGroupSchema } from './filter.schema';
import { scheduleConfigSchema, timezoneSchema } from './schedule.schema';

export const variableMapSchema = z.record(
  z.string(),
  z.discriminatedUnion('source', [
    z.object({ source: z.literal('field'), field: z.string() }),
    z.object({ source: z.literal('literal'), value: z.string() }),
  ]),
);

/**
 * "Limitar aos N primeiros contatos" da lista filtrada.
 *
 * Ausente/null = sem limite (todo mundo que casa com o filtro) — o
 * comportamento de sempre. Os "N primeiros" são por ORDEM DE CADASTRO
 * (Contact.id asc), a MESMA ordem em que o disparo pagina a audiência.
 */
export const audienceLimitSchema = z.number().int().positive().nullish();

/**
 * A.1 — o `limit` na CRIAÇÃO virou legado, e legado que continua sendo aceito
 * continua sendo criado.
 *
 * "Limitar aos primeiros N" recorta `id <= (id do N-ésimo contato)` ANTES de
 * qualquer exclusão (ver `applyAudienceLimit`). Numa campanha nova não há
 * `Message` própria a excluir, então o recorte cai SEMPRE sobre as mesmas N
 * pessoas mais antigas — foi assim que o cliente mandou "para 500" três vezes
 * seguidas e nunca saiu dos mesmos 500. Quem dimensiona o envio agora é o LOTE.
 *
 * Ausente e `null` continuam válidos (cliente antigo que manda o campo vazio);
 * qualquer número é 400 com uma frase que diz para onde ir.
 *
 * ★ `z.null().optional()` e NÃO `z.custom`: `z.custom` é irrepresentável em
 * JSON Schema, e o `main.ts` monta o OpenAPI no boot fora de produção —
 * `openapi-representability.spec.ts` existe exatamente para pegar isso.
 */
export const legacyLimitRejectedSchema = z
  .null({
    error:
      'Campanhas novas não usam "Limitar aos primeiros": quem dimensiona o envio é o 1º lote. ' +
      'Crie a campanha e escolha quantos enviar agora em "Enviar agora para N".',
  })
  .optional();

export const previewCampaignSchema = z.object({
  filters: filterGroupSchema,
  /**
   * A prévia tem de contar e AMOSTRAR exatamente quem vai receber. Sem o limite
   * aqui, a tela mostraria 13.400 e o disparo mandaria para 200 — ou pior,
   * mostraria as 10 pessoas erradas.
   */
  limit: audienceLimitSchema,
  /**
   * ★ O template escolhido no passo 1 do assistente.
   *
   * Com ele a prévia aplica a MESMA exclusão que o disparo vai aplicar — quem
   * já está em outra campanha deste template não entra (spec 2026-08-12) — e
   * devolve `excludedSameTemplate`, o número que a tela usa para explicar por
   * que a audiência encolheu.
   *
   * Opcional: a campanha ainda não existe neste passo, e as chamadas que não
   * escolheram template precisam continuar funcionando igual.
   */
  templateId: z.string().min(1).optional(),
  /**
   * ★ Pedido do cliente 2026-08-25 — "excluir quem já recebeu" só excluía
   * quem já estava numa campanha do MESMO template (`excludedSameTemplate`
   * acima). Uma campanha nova com um template DIFERENTE de uma anterior não
   * excluía ninguém: é o que o operador via como "a opção não funciona".
   *
   * `false` (default) preserva o comportamento de sempre — só o mesmo
   * template. `true` amplia a exclusão para QUALQUER campanha anterior
   * (anti-join em Message por CONTATO, não por template).
   */
  excludeAnyPreviousCampaign: z.boolean().optional().default(false),
});

/**
 * Body for the campaign wizard's "send analysis" (anti-ban checks) step:
 * an inline filter group + target instance + schedule, run before the
 * campaign is persisted.
 */
export const preflightChecksSchema = z.object({
  filters: filterGroupSchema,
  defaultInstanceId: z.string(),
  schedule: scheduleConfigSchema.default({ type: 'IMMEDIATE' }),
  timezone: timezoneSchema,
  /**
   * C1b — quando informada, o preflight devolve também quantos da audiência
   * consentiram para ESTA finalidade e quantos o gate vai pular. Opcional: o
   * wizard chama o preflight antes de o operador ter escolhido a finalidade.
   */
  purposeKey: z.string().min(1).optional(),
});
export type PreflightChecksInput = z.infer<typeof preflightChecksSchema>;

export const createCampaignSchema = z.object({
  name: z.string().min(1),
  templateId: z.string(),
  defaultInstanceId: z.string(),
  filters: filterGroupSchema,
  /**
   * When set, the campaign is a broadcast: recipients resolve dynamically from
   * the segment's CURRENT filters on every run. `filters` then holds a snapshot
   * for display/fallback only. Plain campaigns leave this null.
   */
  segmentId: z.string().optional(),
  variableMap: variableMapSchema,
  schedule: scheduleConfigSchema.default({ type: 'IMMEDIATE' }),
  timezone: timezoneSchema,
  /**
   * Typing-indicator delay (ms) applied to every send for this campaign.
   * 0 = disabled (default). Capped at 60 s — anything more would stall
   * the worker for longer than a typical job timeout.
   */
  presenceDelayMs: z.number().int().min(0).max(60_000).optional().default(0),
  /**
   * C1 — finalidade declarada da campanha (key de ConsentPurpose). O gate exige
   * consentimento ATIVO do contato PARA ESTA finalidade: consentir para
   * `convite_atividades` não autoriza `captacao_recursos` (art. 8º §4º —
   * autorização genérica é nula).
   *
   * Opcional no schema apenas para não quebrar clientes legados; uma campanha
   * SEM finalidade não passa ninguém no gate (fail-safe: sem finalidade não há
   * consentimento válido a checar).
   */
  purposeKey: z.string().min(1).optional(),
  /**
   * When true, bypasses any `block`-severity send-check (the operator has
   * acknowledged the anti-ban risk). Defaults to false: a blocking check
   * rejects the create with CampaignBlockedError.
   *
   * C1 — como override de CONSENTIMENTO é INEXPRIMÍVEL em canal oficial
   * (TWILIO/META/ZERNIO): lá o campo é ignorado pelo gate. Onde sobrevive
   * (EVOLUTION) exige `overrideJustification` e teto de 100 destinatários.
   */
  override: z.boolean().optional().default(false),
  /**
   * Justificativa do override de consentimento (obrigatória quando `override`
   * é usado em canal EVOLUTION). Persistida e auditada: "o operador assumiu o
   * risco" não é hipótese legal do art. 7º, então o mínimo é que fique escrito
   * QUEM assumiu e POR QUÊ.
   */
  overrideJustification: z.string().trim().min(10).optional(),
  /**
   * LEGADO — ver `legacyLimitRejectedSchema`. Campanhas já criadas mantêm o
   * valor gravado (a coluna e a guarda de `applyAudienceLimit` continuam de pé);
   * campanhas NOVAS não podem mais nascer com ele.
   */
  limit: legacyLimitRejectedSchema,
  /**
   * ★ Pedido do cliente 2026-08-25 — ver o mesmo campo em
   * `previewCampaignSchema`. Persistido na campanha porque quem materializa
   * a audiência de fato é o DISPARO (run/lotes/redisparo/tick), não a
   * prévia — um valor que só existisse na tela deixaria a campanha
   * despachar com a rede de sempre (só mesmo template).
   *
   * `false` (default) preserva o comportamento de sempre.
   */
  excludeAnyPreviousCampaign: z.boolean().optional().default(false),
  /**
   * ★ Pedido do cliente 2026-08-25 — "respeita a janela de horário de
   * envio?". A janela (Channel.sendWindow*) só é aplicada pelo worker a
   * canais DE SESSÃO (unofficial, ex. EVOLUTION) — canais OFICIAIS (hoje só
   * a ZERNIO em produção) nunca a respeitaram, porque a Cloud API tem seus
   * próprios limites de envio. Este campo dá ao operador um botão explícito
   * por campanha; hoje ele só tem efeito visível em canal de sessão.
   *
   * `true` (default) mantém o comportamento atual onde a janela já se
   * aplicava.
   */
  respeitarJanelaDeEnvio: z.boolean().optional().default(true),
});

/**
 * Os status de `Message` que o operador pode FILTRAR na tela da campanha.
 *
 * Os `SKIPPED_*` entraram depois do incidente do "gate silencioso": o seletor
 * do frontend já oferecia "Sem consentimento", mas o enum não conhecia o
 * status — a chamada voltava 400 e a lista dos pulados era, na prática,
 * inalcançável pela API. Quem foi bloqueado pelo gate precisa ser LISTÁVEL,
 * senão o operador vê zero em tudo e conclui que o sistema quebrou.
 */
export const messageStatusEnum = z.enum([
  'QUEUED',
  'SENDING',
  'WAITING_INSTANCE',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'CANCELLED',
  'SKIPPED_NO_CONSENT',
  'SKIPPED_SUPPRESSED',
  'SKIPPED_NO_OPTIN',
]);

export const listCampaignMessagesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  status: messageStatusEnum.optional(),
  search: z.string().optional(),
});

/**
 * ZE — "enviar agora para [N] contatos".
 *
 * O teto de 5000 não é burocracia: é o tamanho a partir do qual um "lote" deixa
 * de ser um lote e vira o disparo inteiro — e disparo inteiro já tem botão
 * próprio (`/run`). Na prática o limite real é o tier diário do número, e quem o
 * aplica é o worker (que ADIA o excedente, não falha).
 */
export const sendCampaignBatchSchema = z.object({
  size: z.coerce.number().int().min(1).max(5000),
});

/**
 * ZE — a aba "enviados × não enviados × inalcançáveis".
 *
 * `skipped` é a 4ª aba, nascida do gate silencioso: quem o gate de
 * consentimento pulou não cai em NENHUM dos outros três grupos (não tem
 * mensagem enviada, não é inalcançável de marketing e sai de `pending` porque
 * já foi "tratado"). Sem esta aba, esses contatos simplesmente somem da tela.
 *
 * `failed` é a 5ª aba (F2 T7): quem tem uma Message FAILED nesta campanha.
 * Antes ficava implícito em `pending` (se ainda elegível para um novo lote) e
 * o MOTIVO da falha era invisível — o operador não tinha como distinguir
 * "telefone inválido" de "canal fora do ar" sem abrir mensagem por mensagem.
 */
export const listCampaignRecipientsQuerySchema = z.object({
  group: z
    .enum(['sent', 'pending', 'unreachable', 'skipped', 'failed'])
    .default('pending'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * "Disparar novamente". Default: reenvia a quem NÃO recebeu (unreached) —
 * reavaliando o gate para os pulados. `resendToAll: true` reabre a audiência
 * INTEIRA (mode 'full'): só por intenção explícita, e a tela confirma antes
 * dizendo quantos já receberam.
 */
export const redispatchCampaignSchema = z.object({
  resendToAll: z.boolean().default(false),
});
export type RedispatchCampaign = z.infer<typeof redispatchCampaignSchema>;

export type VariableMap = z.infer<typeof variableMapSchema>;
export type PreviewCampaign = z.infer<typeof previewCampaignSchema>;
export type CreateCampaign = z.infer<typeof createCampaignSchema>;
export type SendCampaignBatch = z.infer<typeof sendCampaignBatchSchema>;
export type ListCampaignRecipientsQuery = z.infer<
  typeof listCampaignRecipientsQuerySchema
>;
export type ListCampaignMessagesQuery = z.infer<
  typeof listCampaignMessagesQuerySchema
>;
