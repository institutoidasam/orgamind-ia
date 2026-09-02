import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import type { Env } from '../../shared/config/env.schema';
import { DomainError } from '../../shared/errors/domain.error';

/**
 * WhatsApp approval request attached to a Content template
 * (`approval_requests` in the ContentAndApprovals payload).
 */
export type TwilioContentApproval = {
  name?: string;
  category?: string;
  /** raw Twilio status: received|pending|approved|rejected|paused|disabled|… */
  status?: string;
  rejectionReason?: string;
};

/** One Content template + its WhatsApp approval, normalized. */
export type TwilioContentItem = {
  /** Content SID (`HX…`). */
  sid: string;
  friendlyName: string;
  language?: string;
  /** Sample-value map, e.g. `{"1":"João"}` — keys are the template variables. */
  variables: Record<string, string>;
  /** Content types object, e.g. `{"twilio/text":{body:"Olá {{1}}"}}`. */
  types: Record<string, { body?: string; [k: string]: unknown }>;
  /** Absent when the template was never submitted for approval (draft). */
  approval?: TwilioContentApproval;
};

/**
 * Payload to create (POST /v1/Content) or edit (PUT /v1/Content/{sid}, drafts
 * only) a Content template. `types` is the raw Twilio content-types object,
 * e.g. `{"twilio/quick-reply": {body, actions}}` — built by
 * buildTwilioContentTypes (templates module) from the validated input.
 */
export type TwilioCreateContentInput = {
  friendlyName: string;
  language: string;
  /** Sample-value map (`{"1":"João"}`) — required by Meta for approval. */
  variables: Record<string, string>;
  types: Record<string, unknown>;
};

/**
 * Client for Twilio's Content API (host `content.twilio.com`, JSON — unlike
 * the form-encoded Messages API on `api.twilio.com`). Auth is the same HTTP
 * Basic `AccountSid:AuthToken` pair the TwilioCloudAdapter uses.
 *
 * There is NO approval webhook on Twilio's side — polling
 * `GET /v1/ContentAndApprovals` is the canonical reconciliation, done by the
 * repeatable `template-approval-sync` job.
 */
@Injectable()
export class TwilioContentService {
  private readonly logger = new Logger(TwilioContentService.name);
  private readonly http: AxiosInstance;
  /**
   * False on deploys without the Twilio credential group — callers (the
   * approval-sync tick) must no-op instead of hitting Twilio with empty
   * Basic auth every 2 minutes.
   */
  readonly configured: boolean;

  constructor(config: ConfigService<Env>) {
    const accountSid = config.get('TWILIO_ACCOUNT_SID', { infer: true }) ?? '';
    const authToken = config.get('TWILIO_AUTH_TOKEN', { infer: true }) ?? '';
    this.configured = accountSid.length > 0 && authToken.length > 0;
    // Optional override so tests/dev can point at a fake server; production
    // always talks to the real host.
    const baseURL =
      config.get('TWILIO_CONTENT_BASE_URL', { infer: true })?.trim() ||
      'https://content.twilio.com';
    this.http = axios.create({
      baseURL,
      auth: { username: accountSid, password: authToken },
      timeout: 15_000,
    });
  }

  /**
   * Full template catalog + approval statuses in one call, following
   * `meta.next_page_url` (Twilio paginates with PageToken; `page=` is not
   * supported) until exhausted. Malformed items are logged and skipped —
   * one bad shape must never abort the whole sync.
   */
  async listContentAndApprovals(): Promise<TwilioContentItem[]> {
    const items: TwilioContentItem[] = [];
    // Hard page cap so a misbehaving cursor can never loop forever
    // (100 items/page × 50 = 5k templates, far beyond a WABA's catalog).
    const MAX_PAGES = 50;
    let url: string | null = '/v1/ContentAndApprovals?PageSize=100';
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const { data } = await this.http.get<{
        contents?: unknown[];
        meta?: { next_page_url?: string | null };
      }>(url);
      const contents = Array.isArray(data?.contents) ? data.contents : [];
      for (const raw of contents) {
        const item = this.parseItem(raw);
        if (item) items.push(item);
      }
      const next = data?.meta?.next_page_url;
      url = typeof next === 'string' && next.length > 0 ? next : null;
      if (url && page === MAX_PAGES - 1) {
        this.logger.warn(
          `listContentAndApprovals hit the ${MAX_PAGES}-page cap; remaining pages skipped`,
        );
      }
    }
    return items;
  }

  /**
   * Cria um Content template (rascunho) — `POST /v1/Content` (JSON).
   * Retorna o `sid` (HX…) do rascunho criado; a submissão à aprovação é um
   * passo separado (submitApproval).
   */
  async createContent(
    input: TwilioCreateContentInput,
  ): Promise<{ sid: string }> {
    this.assertConfigured();
    let data: unknown;
    try {
      ({ data } = await this.http.post('/v1/Content', toContentBody(input)));
    } catch (err) {
      throw this.twilioError(
        err,
        'twilio_content.create_failed',
        'Falha ao criar o template na Twilio',
      );
    }
    const sid = (data as Record<string, unknown> | null)?.sid;
    if (typeof sid !== 'string' || sid.length === 0) {
      throw new DomainError({
        code: 'twilio_content.invalid_response',
        message:
          'A Twilio não retornou o SID do template criado — resposta inesperada.',
        status: 502,
      });
    }
    return { sid };
  }

  /**
   * Submete um rascunho à aprovação do WhatsApp —
   * `POST /v1/Content/{sid}/ApprovalRequests/whatsapp` (path minúsculo).
   * `name` segue `^[a-z0-9_]+$` (validado antes, no módulo templates).
   * Retorna o status inicial reportado pela Twilio (normalmente `received`).
   */
  async submitApproval(
    sid: string,
    request: { name: string; category: string },
  ): Promise<{ status: string }> {
    this.assertConfigured();
    try {
      const { data } = await this.http.post(
        `/v1/Content/${sid}/ApprovalRequests/whatsapp`,
        { name: request.name, category: request.category },
      );
      const status = (data as Record<string, unknown> | null)?.status;
      return { status: typeof status === 'string' ? status : 'received' };
    } catch (err) {
      throw this.twilioError(
        err,
        'twilio_content.submit_failed',
        'Falha ao submeter o template à aprovação na Twilio',
      );
    }
  }

  /**
   * Edita um rascunho — `PUT /v1/Content/{sid}`. A Twilio SÓ aceita antes da
   * submissão à aprovação (template submetido é imutável); a recusa vira um
   * DomainError PT-BR orientando o clone (`_v2`).
   */
  async updateDraft(
    sid: string,
    input: TwilioCreateContentInput,
  ): Promise<void> {
    this.assertConfigured();
    try {
      await this.http.put(`/v1/Content/${sid}`, toContentBody(input));
    } catch (err) {
      const mapped = this.twilioError(
        err,
        'twilio_content.update_rejected',
        'A Twilio recusou a edição do template',
      );
      throw new DomainError({
        code: mapped.code,
        message: `${mapped.message} — templates já submetidos à aprovação são imutáveis; crie um novo template (ex.: sufixo _v2).`,
        status: mapped.status,
        detail: mapped.detail,
        cause: err,
      });
    }
  }

  /**
   * Exclui um Content template — `DELETE /v1/Content/{sid}?deleteInWaba=true`
   * (o query remove também da WABA, dossiê §3.1). 404 é tolerado: o objetivo
   * é convergência, e "já não existe na Twilio" é o estado desejado.
   */
  async deleteContent(sid: string): Promise<void> {
    this.assertConfigured();
    try {
      await this.http.delete(`/v1/Content/${sid}`, {
        params: { deleteInWaba: 'true' },
      });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        this.logger.warn(
          `deleteContent(${sid}): já removido na Twilio (404) — seguindo`,
        );
        return;
      }
      throw this.twilioError(
        err,
        'twilio_content.delete_failed',
        'Falha ao excluir o template na Twilio',
      );
    }
  }

  /**
   * Status de aprovação de UM template —
   * `GET /v1/Content/{sid}/ApprovalRequests`. Retorna `null` quando o
   * template nunca foi submetido (sem bloco `whatsapp`). A reconciliação em
   * lote continua sendo listContentAndApprovals (job approval-sync).
   */
  async fetchApprovalStatus(
    sid: string,
  ): Promise<TwilioContentApproval | null> {
    this.assertConfigured();
    let data: unknown;
    try {
      ({ data } = await this.http.get(`/v1/Content/${sid}/ApprovalRequests`));
    } catch (err) {
      throw this.twilioError(
        err,
        'twilio_content.approval_fetch_failed',
        'Falha ao consultar o status de aprovação na Twilio',
      );
    }
    const whatsapp = (data as Record<string, unknown> | null)?.whatsapp;
    if (typeof whatsapp !== 'object' || whatsapp === null) return null;
    const w = whatsapp as Record<string, unknown>;
    return {
      name: asOptionalString(w.name),
      category: asOptionalString(w.category),
      status: asOptionalString(w.status),
      rejectionReason: asOptionalString(w.rejection_reason),
    };
  }

  /** Deploy sem o grupo de credenciais Twilio → operações de escrita falham cedo. */
  private assertConfigured(): void {
    if (this.configured) return;
    throw new DomainError({
      code: 'twilio_content.not_configured',
      message: 'Credenciais Twilio não configuradas neste ambiente.',
      status: 503,
      detail: 'Defina TWILIO_ACCOUNT_SID e TWILIO_AUTH_TOKEN no env.',
    });
  }

  /**
   * Erro da Content API → DomainError com a mensagem REAL da Twilio (body
   * `{message, code}`) e código estável `twilio_content.<motivo>`. HTTP:
   * 404 preserva 404, demais 4xx viram 400 (erro do input do operador,
   * nunca o 401 upstream — confundiria com autenticação do orgamind), 5xx/rede
   * viram 502.
   */
  private twilioError(
    err: unknown,
    code: string,
    ptPrefix: string,
  ): DomainError {
    if (err instanceof DomainError) return err;
    if (axios.isAxiosError(err) && err.response) {
      const { status, data } = err.response;
      const body = (data ?? {}) as Record<string, unknown>;
      const twilioMessage =
        typeof body.message === 'string' && body.message.length > 0
          ? body.message
          : undefined;
      const twilioCode = body.code;
      return new DomainError({
        code,
        message: twilioMessage
          ? `${ptPrefix}: ${twilioMessage}`
          : `${ptPrefix} (HTTP ${status}).`,
        status: status === 404 ? 404 : status >= 500 ? 502 : 400,
        detail:
          twilioCode !== undefined ? `Código Twilio ${String(twilioCode)}` : undefined,
        cause: err,
      });
    }
    return new DomainError({
      code,
      message: `${ptPrefix}: falha de comunicação com a Twilio.`,
      status: 502,
      cause: err,
    });
  }

  /**
   * Normalize one raw ContentAndApprovals item. Returns `null` (never throws)
   * for malformed shapes — the caller logs a summary; here we log the culprit.
   */
  private parseItem(raw: unknown): TwilioContentItem | null {
    try {
      if (typeof raw !== 'object' || raw === null) {
        this.logger.warn(
          `Skipping malformed ContentAndApprovals item: ${JSON.stringify(raw)}`,
        );
        return null;
      }
      const r = raw as Record<string, unknown>;
      const sid = typeof r.sid === 'string' && r.sid.length > 0 ? r.sid : null;
      if (!sid) {
        this.logger.warn(
          `Skipping ContentAndApprovals item without sid (friendly_name=${String(
            r.friendly_name ?? '<none>',
          )})`,
        );
        return null;
      }
      const approvalRaw =
        typeof r.approval_requests === 'object' && r.approval_requests !== null
          ? (r.approval_requests as Record<string, unknown>)
          : undefined;
      return {
        sid,
        friendlyName:
          typeof r.friendly_name === 'string' ? r.friendly_name : '',
        language: typeof r.language === 'string' ? r.language : undefined,
        variables:
          typeof r.variables === 'object' && r.variables !== null
            ? (r.variables as Record<string, string>)
            : {},
        types:
          typeof r.types === 'object' && r.types !== null
            ? (r.types as TwilioContentItem['types'])
            : {},
        approval: approvalRaw
          ? {
              name: asOptionalString(approvalRaw.name),
              category: asOptionalString(approvalRaw.category),
              status: asOptionalString(approvalRaw.status),
              rejectionReason: asOptionalString(approvalRaw.rejection_reason),
            }
          : undefined,
      };
    } catch (err) {
      this.logger.warn(
        `Skipping ContentAndApprovals item (parse error): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** camelCase interno → shape snake_case do body JSON da Content API. */
function toContentBody(input: TwilioCreateContentInput) {
  return {
    friendly_name: input.friendlyName,
    language: input.language,
    variables: input.variables,
    types: input.types,
  };
}
