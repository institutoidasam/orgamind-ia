import {
  NotFoundError,
  ConflictError,
  DomainError,
  ValidationError,
} from '../../../shared/errors/domain.error';
import type { SendCheck } from '../send-checks';

export class CampaignNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('Campaign', id);
  }
}

export class CampaignAlreadyDispatchedError extends ConflictError {
  constructor(status: string) {
    super(
      `Campaign already in status ${status}; cannot run`,
      'campaign.already_dispatched',
    );
  }
}

/**
 * ZE — a campanha já acabou (COMPLETED / FAILED / CANCELLED): não se dispara um
 * novo lote de algo terminal. Uma campanha CONCLUÍDA, por definição, não tem
 * pendentes; uma CANCELADA foi interrompida de propósito.
 */
export class CampaignBatchNotAllowedError extends ConflictError {
  constructor(status: string) {
    super(
      `Campanha em status ${status}: não é possível enviar um novo lote.`,
      'campaign.batch_not_allowed',
    );
  }
}

/** ZE — não sobrou ninguém pendente: não há o que enviar. */
export class CampaignNoPendingRecipientsError extends ConflictError {
  constructor() {
    super(
      'Não há mais contatos pendentes nesta campanha — todos já foram enviados, ' +
        'pulados pelo gate de consentimento ou são inalcançáveis para marketing.',
      'campaign.no_pending_recipients',
    );
  }
}

/**
 * A.4 — o lote pedido é maior do que o público que ainda resta.
 *
 * 400 e não 409 de propósito: não é um conflito de estado, é um NÚMERO ERRADO
 * no corpo da requisição — e a resposta carrega o número certo para a tela
 * poder se corrigir sozinha.
 */
export class CampaignBatchSizeExceedsPendingError extends ValidationError {
  constructor(requested: number, pending: number) {
    super(
      `Você pediu ${requested} contatos, mas restam apenas ${pending} nesta campanha. ` +
        `Ajuste o tamanho do lote para ${pending} ou menos.`,
      `requested batch size ${requested} exceeds pending audience ${pending}`,
      'campaign.batch_size_exceeds_pending',
    );
  }
}

export class MessageNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('Message', id);
  }
}

export class MessageNotRetryableError extends ConflictError {
  constructor(status: string) {
    super(
      `Message in status ${status} cannot be retried (only FAILED messages can be retried)`,
      'message.not_retryable',
    );
  }
}

/**
 * Raised when an operator tries to retry a message whose delivery outcome is
 * INDETERMINATE (a send timeout, or a worker crash mid-send) — ANY provider,
 * not just Twilio (see `INDETERMINATE_DELIVERY_CODES`). The provider may have
 * accepted+billed+delivered it, so an automatic resend would risk a duplicate
 * — the operator must verify at the provider first. The message is
 * deliberately provider-NEUTRAL: this error fires for Twilio, Zernio and
 * GoZap alike, and naming the wrong one here would be the same "message names
 * the wrong provider" mistake the processor's B3 guard fixes on the send
 * path.
 */
export class MessageDeliveryIndeterminateError extends ConflictError {
  constructor() {
    super(
      'Esta mensagem falhou por timeout/indeterminação — ela PODE ter sido entregue. ' +
        'Verifique no painel do provedor antes de reenviar (o reenvio automático está ' +
        'desabilitado para evitar cobrança e entrega duplicadas).',
      'message.delivery_indeterminate',
    );
  }
}

/**
 * O contato desta mensagem FALHADA já foi alcançado nesta campanha por outra
 * linha (SENT/DELIVERED/READ) ou tem uma em voo. Reenviar duplicaria a entrega.
 */
export class MessageContactAlreadyReachedError extends ConflictError {
  constructor() {
    super(
      'Este contato já recebeu (ou está recebendo) esta campanha — reenviar duplicaria a mensagem.',
      'message.contact_already_reached',
    );
  }
}

/**
 * ★ I15 (revisão de integração) — "LIBERAR AS NÃO CONFIRMADAS" SÓ VALE PARA UMA
 * CAMPANHA CANCELADA.
 *
 * Declarar que as mensagens ENVIADAS de uma campanha nunca chegaram é um ato
 * grave: ele devolve aquelas pessoas para a audiência do mesmo template, e se a
 * declaração estiver errada elas recebem o mesmo texto duas vezes. A porta só
 * abre depois que o operador CANCELOU a campanha — um ato visível, anterior e
 * independente, que também garante que nada mais vai sair por ela enquanto a
 * liberação roda.
 */
export class CampaignNotCancelledError extends ConflictError {
  constructor(status: string) {
    super(
      `Só é possível liberar as mensagens não confirmadas de uma campanha CANCELADA — ` +
        `esta está em ${status}. Cancele a campanha primeiro.`,
      'campaign.not_cancelled',
    );
  }
}

/**
 * ★ I15 — a liberação em massa exige intenção explícita.
 *
 * O corpo precisa trazer `confirm: true`. Não é burocracia: o operador acabou
 * de ver a prévia com o NÚMERO de pessoas afetadas, e este campo é o "sim, são
 * essas". Sem ele, um POST acidental (retry de cliente HTTP, link colado)
 * devolveria milhares de eleitores para a fila de um template que talvez eles
 * já tenham recebido.
 */
export class CampaignReleaseNotConfirmedError extends ConflictError {
  constructor() {
    super(
      'Confirmação ausente: veja antes quantas mensagens serão liberadas e reenvie com confirm=true.',
      'campaign.release_not_confirmed',
    );
  }
}

/**
 * A4 — raised when a retry/redispatch is already running for this campaign and
 * a second, concurrent invocation (double-click / two operators) tries to
 * start another. Serialising these per campaign prevents duplicate
 * jobs/batches → duplicate WhatsApp messages.
 */
export class CampaignOperationInProgressError extends ConflictError {
  constructor() {
    super(
      'Já existe um reenvio/redisparo em andamento para esta campanha. Aguarde concluir antes de tentar novamente.',
      'campaign.operation_in_progress',
    );
  }
}

/**
 * Raised when a campaign create/run is attempted while at least one `block`
 * send-check is present and the operator has not passed an explicit override.
 * The blocking checks are attached so the API/UI can show exactly what to
 * resolve.
 */
export class CampaignBlockedError extends ConflictError {
  constructor(public readonly blockingChecks: SendCheck[]) {
    super(
      `Campaign blocked by ${blockingChecks.length} check(s); override required`,
      'campaign.blocked',
    );
  }
}

/**
 * Multi-provider channels (T7) — a template built for one provider (e.g. a
 * Twilio Content SID template) cannot be sent through a channel of a
 * different provider (e.g. an Evolution/Baileys number): the send adapter is
 * chosen from the CHANNEL's provider, so a mismatched template would either
 * fail at the adapter or silently send the wrong content. Checked at
 * campaign create() AND run() — the template or channel may have been
 * edited (or reassigned) after the campaign was created.
 */
export class CampaignTemplateProviderMismatchError extends DomainError {
  constructor(templateProvider: string, channelProvider: string) {
    super({
      code: 'campaign.template_provider_mismatch',
      message:
        `O provedor do template (${templateProvider}) não corresponde ao provedor do canal selecionado (${channelProvider}). ` +
        'Escolha um template e um canal do mesmo provedor.',
      status: 400,
      detail: `templateProvider=${templateProvider} channelProvider=${channelProvider}`,
    });
  }
}

/**
 * ZC6 — gate de campanha: só template APPROVED entra.
 *
 * O gate existia SÓ no wizard do frontend (`approvedTemplates`), o que o tornava
 * uma sugestão, não uma garantia: qualquer chamada direta à API disparava com um
 * template PENDING/REJECTED/PAUSED. Isso importa mais no ZERNIO do que em
 * qualquer outro provedor, porque lá o status muda SOZINHO — a Meta pausa ou
 * desabilita um template aprovado (webhook `template.status_updated`) e uma
 * campanha agendada tentaria disparar em cima dele, tomando rejeição em massa
 * (132001/132015) e derrubando o quality rating do número.
 *
 * Por isso a checagem vive no MESMO ponto do guard de provedor (T7), que toda
 * rota de envio real atravessa — create(), run() e dispatchAudience().
 */
export class CampaignTemplateNotApprovedError extends DomainError {
  constructor(metaName: string, status: string) {
    super({
      code: 'campaign.template_not_approved',
      message:
        `O template "${metaName}" não está aprovado pela Meta (status: ${status}). ` +
        'Só templates APROVADOS podem ser disparados — aguarde a aprovação ou escolha outro.',
      status: 400,
      detail: `metaName=${metaName} status=${status}`,
    });
  }
}

/**
 * ★ O template tem botões cujos CLIQUES o sistema não sabe ler — e por isso não
 * dispara.
 *
 * O Zernio não transporta payload de quick_reply: o clique chega como o RÓTULO,
 * e o reconhecimento é uma LISTA FECHADA (schemas/contracts/consent-button.
 * schema.ts). Um template de opt-in criado no painel do Zernio com o botão
 * "Bora, quero!" é APROVADO pela Meta, importado pelo sync como uma row normal e
 * — sem este gate — selecionável na campanha: os 13.400 cliques no "sim" cairiam
 * no `isZernioOptInButton() → false` e NENHUM consentimento seria gravado, sem um
 * único erro no log. O operador acharia que documentou 13.400 aceites e teria
 * documentado zero, e só descobriria quando alguém pedisse a prova.
 *
 * Do rótulo sozinho é INDECIDÍVEL se um botão é o "sim" de um opt-in ou um
 * "Ver mais" inofensivo. Então quem decide é o operador: ou o template nasce pelo
 * orgamind (rótulo escolhido de lista), ou os papéis são declarados em
 * `PATCH /templates/:id/consent-buttons`. Enquanto ninguém disser, não passa —
 * uma campanha que colhe zero é pior do que uma campanha que não sai.
 */
export class CampaignTemplateConsentButtonsError extends DomainError {
  constructor(metaName: string, problems: string[]) {
    super({
      code: 'campaign.template_consent_buttons_unrecognized',
      message:
        `O template "${metaName}" tem botões cujo clique o sistema não sabe interpretar, então ele não pode ser disparado: ` +
        problems.join(' '),
      status: 400,
      detail: problems.join('\n'),
    });
  }
}

/**
 * Apagar uma campanha EM VOO (QUEUED/RUNNING) deixaria os jobs já enfileirados
 * no BullMQ apontando para Message que não existem mais (Cascade) — o worker
 * erraria em silêncio, job a job, e o operador não teria como saber quantas
 * mensagens chegaram a sair antes do sumiço.
 *
 * Cancelar primeiro é explícito e já existe (POST /campaigns/:id/cancel).
 */
export class CampaignInFlightError extends ConflictError {
  constructor(status: string) {
    super(
      `Campanha em status ${status}: cancele o disparo antes de apagar. ` +
        'Apagar uma campanha em voo deixaria mensagens já enfileiradas sem destino.',
      'campaign.in_flight',
    );
  }
}
