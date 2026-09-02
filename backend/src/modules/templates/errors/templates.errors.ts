import {
  ConflictError,
  DomainError,
  NotFoundError,
} from '../../../shared/errors/domain.error';

export class TemplateNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('Template', id);
  }
}

export class MetaCredentialsNotConfiguredError extends DomainError {
  constructor() {
    super({
      code: 'templates.meta_not_configured',
      message: 'Meta credentials are not configured',
      status: 503,
      detail: 'Set META_BUSINESS_ACCOUNT_ID and META_ACCESS_TOKEN in env.',
    });
  }
}

export class ZernioCredentialsNotConfiguredError extends DomainError {
  constructor() {
    super({
      code: 'templates.zernio_not_configured',
      message: 'Zernio não está configurado neste ambiente.',
      status: 400,
      detail: 'Set ZERNIO_API_KEY and ZERNIO_BASE_URL in env.',
    });
  }
}

export class TemplateMetaNameConflictError extends ConflictError {
  constructor(metaName: string) {
    super(
      `Template with metaName "${metaName}" already exists`,
      'template.meta_name_conflict',
    );
  }
}

export class TemplateInUseError extends ConflictError {
  constructor(id: string, count: number) {
    super(`Template ${id} is used by ${count} campaign(s)`, 'template.in_use');
  }
}

// ── twilio-platform T4 ───────────────────────────────────────────────────────

/** Operação Twilio (submit/draft) num template que não é TWILIO com HX. */
export class TemplateNotTwilioError extends ConflictError {
  constructor(id: string) {
    super(
      `Este template não é um template Twilio com Content SID — a operação vale apenas para templates do provedor TWILIO (id: ${id}).`,
      'template.not_twilio',
    );
  }
}

/** Submit/edição fora do estado rascunho — pós-submissão é imutável. */
export class TemplateNotDraftError extends ConflictError {
  constructor(id: string, rawStatus: string | null | undefined) {
    super(
      `Este template já foi submetido à aprovação (status atual: ${
        rawStatus ?? 'desconhecido'
      }) — templates submetidos são imutáveis; crie um novo template (ex.: sufixo _v2). (id: ${id})`,
      'template.twilio_not_draft',
    );
  }
}

/** DELETE bloqueado: campanha ativa (rodando/na fila/agendada) usa o template. */
export class TemplateActiveCampaignError extends ConflictError {
  constructor(id: string, count: number) {
    super(
      `Não é possível excluir o template: ${count} campanha(s) ativa(s) (em execução, na fila ou agendadas) ainda o utilizam. Cancele ou conclua essas campanhas antes de excluir. (id: ${id})`,
      'template.active_campaign',
    );
  }
}
