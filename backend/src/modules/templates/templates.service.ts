import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  TemplateStatus,
  TemplateCategory,
  TemplateKind as PrismaTemplateKind,
  ChannelProvider,
  Prisma,
} from '@prisma/client';
import type { Env } from '../../shared/config/env.schema';
import {
  TemplatesRepository,
  type TemplateUpdateData,
} from './templates.repository';
import {
  MetaCredentialsNotConfiguredError,
  TemplateActiveCampaignError,
  TemplateInUseError,
  TemplateMetaNameConflictError,
  TemplateNotDraftError,
  TemplateNotFoundError,
  TemplateNotTwilioError,
  ZernioCredentialsNotConfiguredError,
} from './errors/templates.errors';
import { ValidationError } from '../../shared/errors/domain.error';
import { AuditService } from '../../shared/audit/audit.service';
import { TwilioContentService } from '../whatsapp-providers/twilio-content.service';
import {
  buildTwilioContentTypes,
  validateTwilioTemplateInput,
  type TwilioContentTypeName,
} from './twilio-template-validation';
import { mapTwilioApprovalStatus } from './template-approval-sync.processor';
import {
  buildZernioComponents,
  extractZernioButtonTexts,
  validateZernioTemplateInput,
} from './zernio-template-validation';
import {
  CONSENT_BUTTON_CHOICES,
  auditConsentButtons,
  auditZernioTemplateRow,
  extractQuickReplyLabels,
  isZernioOptInButton,
  isZernioOptOutButton,
  readDeclaredConsentButtons,
  reconcileConsentButtonRoles,
  squashButton,
  type DeclaredConsentButton,
} from '../../schemas/contracts/consent-button.schema';
import {
  ZernioTemplateService,
  mapZernioTemplateStatus,
  type ZernioTemplateItem,
} from '../whatsapp-providers/zernio-template.service';
import {
  extractTemplateVariables,
  buttonsConfigSchema,
  listConfigSchema,
  pollConfigSchema,
  templateStatusEnum,
  templateCategoryEnum,
  type CreateTemplate,
  type UpdateTemplate,
  type TemplateKind,
  type CreateTwilioTemplate,
  type UpdateTwilioDraft,
  type CreateZernioTemplate,
  type DeclareConsentButtons,
} from '../../schemas/contracts/template.schema';

/**
 * Content type Twilio → kind local (apresentação): tipos com botões viram
 * BUTTONS; text/media ficam TEXT (não existe kind de mídia). Para envio o
 * kind é irrelevante em TWILIO — o adapter usa só ContentSid + variables.
 */
const TWILIO_TEMPLATE_KIND: Record<TwilioContentTypeName, PrismaTemplateKind> =
  {
    'twilio/text': PrismaTemplateKind.TEXT,
    'twilio/media': PrismaTemplateKind.TEXT,
    'twilio/quick-reply': PrismaTemplateKind.BUTTONS,
    'twilio/call-to-action': PrismaTemplateKind.BUTTONS,
  };

/**
 * Rascunho editável/submetível: `draft` (escrito pelo createTwilio e pelo
 * approval-sync para templates nunca submetidos) ou null (rows legados
 * sincronizados antes do T4).
 */
function isTwilioDraft(raw: string | null | undefined): boolean {
  return !raw || raw === 'draft';
}

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly repo: TemplatesRepository,
    private readonly config: ConfigService<Env>,
    private readonly audit: AuditService,
    private readonly twilioContent: TwilioContentService,
    private readonly zernioTemplates: ZernioTemplateService,
  ) {}

  /**
   * A lista — com o VEREDITO dos botões junto (`consentButtons`).
   *
   * O frontend não pode calcular isso: quem sabe se "Bora, quero!" é reconhecido
   * como aceite é o reconhecedor, e ele é uma LISTA FECHADA que vive aqui. Se a
   * UI tivesse uma cópia, as duas divergiriam no primeiro rótulo novo — e a
   * divergência não dá erro: apaga consentimento em silêncio. Então o backend diz
   * o veredito, e a UI só o exibe (e oferece a classificação).
   *
   * `null` = não há nada a dizer (não é ZERNIO, ou não tem resposta rápida).
   */
  async list(provider?: ChannelProvider) {
    const rows = await this.repo.listAll(provider);
    return rows.map((row) => ({
      ...row,
      consentButtons: this.consentButtonsVerdict(row),
    }));
  }

  private consentButtonsVerdict(row: {
    provider: string | null;
    components: unknown;
    consentButtonRoles: unknown;
  }) {
    if (row.provider !== 'ZERNIO') return null;
    const labels = extractQuickReplyLabels(row.components);
    if (labels.length === 0) return null;
    return {
      /** Os rótulos COMO A META OS GUARDOU — é o que volta no clique. */
      labels,
      declared: readDeclaredConsentButtons(row.consentButtonRoles),
      /** Vazio = o clique de cada botão é legível. Não-vazio = não dispara. */
      problems: auditZernioTemplateRow({
        components: row.components,
        consentButtonRoles: row.consentButtonRoles,
      }),
    };
  }

  async create(input: CreateTemplate) {
    // Multi-provider channels — defensive default mirroring
    // createTemplateSchema's `.default('EVOLUTION')`, for callers that build
    // the input directly instead of going through the zod DTO pipe.
    const provider: ChannelProvider = input.provider ?? 'EVOLUTION';

    // ZB — este caminho grava `status: APPROVED` sem falar com provedor nenhum
    // (ver abaixo). Para EVOLUTION isso é correto (não há aprovação da Meta);
    // para ZERNIO seria uma MENTIRA: uma row aprovada de um template que não
    // existe na Meta, que passa no gate de campanha e só quebra no envio. O
    // refine do zod já barra isso no DTO — aqui é o backstop para quem constrói
    // o input direto (worker, teste, script).
    if (provider === 'ZERNIO') {
      throw new ValidationError(
        'Templates ZERNIO não podem ser criados por aqui (a row nasceria APROVADA sem existir na Meta). Use "Novo template Zernio", que cria o template de verdade na Meta e nasce pendente de aprovação.',
        `provider=${provider}`,
        'template.zernio_requires_remote_create',
      );
    }

    const existing = await this.repo.findByMetaName(input.metaName);
    if (existing) throw new TemplateMetaNameConflictError(input.metaName);

    const kind: TemplateKind = input.kind ?? 'TEXT';
    const interactiveConfig = this.validateInteractiveConfig(
      kind,
      input.interactiveConfig,
    );

    // Variables are sourced from the body for TEXT, and from every operator-
    // authored string in the interactive config otherwise — that way runtime
    // variable enrichment (in the worker) covers list rows, button labels,
    // and poll options the same way it covers TEXT bodies.
    const variableSource =
      kind === 'TEXT'
        ? (input.body ?? '')
        : collectInteractiveStrings(kind, interactiveConfig);
    const variables = extractTemplateVariables(variableSource);

    const created = await this.repo.create({
      metaName: input.metaName,
      language: input.language,
      body: input.body ?? '',
      variables,
      // Manually-created templates default to APPROVED — the Evolution
      // (non-Cloud) provider doesn't require Meta approval flow. Meta sync
      // overrides this by writing the actual Meta-reported status.
      status: TemplateStatus.APPROVED,
      category: input.category,
      kind: kind,
      interactiveConfig:
        interactiveConfig === undefined
          ? Prisma.JsonNull
          : (interactiveConfig as Prisma.InputJsonValue),
      // Optional Twilio Content SID for official cold sends. `null`/absent
      // leave the column empty; the processor falls back to `metaName`.
      twilioContentSid: input.twilioContentSid ?? null,
      provider,
    });
    await this.audit.log('template.create', 'Template', created.id, {
      metaName: created.metaName,
      language: created.language,
      category: created.category,
      kind: created.kind,
      provider: created.provider,
    });
    return created;
  }

  async update(id: string, input: UpdateTemplate) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new TemplateNotFoundError(id);

    this.assertZernioNotForgeableByPatch(existing, input);

    // Multi-provider channels — twilioContentSid only makes sense for the
    // TWILIO provider. A partial update can't be validated in isolation (it
    // may only touch one of the two fields), so we validate the EFFECTIVE
    // (merged with the existing row) combination — but only when the
    // operator actually touches one of the two fields, so an unrelated
    // update (e.g. `language`) on a legacy/inconsistent row isn't blocked.
    if (input.provider !== undefined || input.twilioContentSid !== undefined) {
      const effectiveProvider: ChannelProvider =
        input.provider ?? existing.provider ?? 'EVOLUTION';
      const effectiveTwilioContentSid =
        input.twilioContentSid !== undefined
          ? input.twilioContentSid
          : (existing.twilioContentSid ?? null);
      this.validateProviderTwilioConsistency(
        effectiveProvider,
        effectiveTwilioContentSid,
      );
    }

    // Determine the effective kind for this update — defaults to the stored
    // value when the operator doesn't change it. Falls back to 'TEXT' if
    // `existing.kind` is unexpectedly missing (legacy rows, partial fixtures).
    const effectiveKind: TemplateKind = input.kind ?? existing.kind ?? 'TEXT';

    // Validate interactiveConfig only when the operator is touching it or the
    // kind itself is changing. When neither field is supplied, leave the
    // record alone.
    const touchingConfig =
      input.interactiveConfig !== undefined || input.kind !== undefined;
    const incomingConfig = touchingConfig
      ? (input.interactiveConfig ?? existing.interactiveConfig)
      : undefined;
    const validatedConfig = touchingConfig
      ? this.validateInteractiveConfig(effectiveKind, incomingConfig)
      : undefined;

    // Re-extract variables when body or interactive config changes. For
    // interactive kinds we walk every string in the config so {{var}} tokens
    // anywhere in the structure survive.
    const variables = this.computeUpdatedVariables({
      effectiveKind,
      input,
      existing,
      touchingConfig,
      validatedConfig,
    });

    const updated = await this.repo.update(
      id,
      this.buildTemplateUpdateData({
        input,
        touchingConfig,
        validatedConfig,
        variables,
      }),
    );
    await this.audit.log('template.update', 'Template', id, {
      ...input,
      ...(variables !== undefined && { variables }),
    });
    return updated;
  }

  /**
   * Decide the new `variables` array for an update, or `undefined` to leave the
   * stored value untouched.
   *
   * - TEXT (incl. switching *to* TEXT): recompute from the body — the new body
   *   when supplied & changed, otherwise the existing body when switching to
   *   TEXT — so stale interactive-derived tokens (list rows, button labels,
   *   poll options) are dropped. Unchanged body with no kind switch -> leave
   *   as-is (`undefined`).
   * - non-TEXT, touching config: re-extract from every string in the config.
   */
  private computeUpdatedVariables(args: {
    effectiveKind: TemplateKind;
    input: UpdateTemplate;
    existing: { kind?: string | null; body?: string | null };
    touchingConfig: boolean;
    validatedConfig: unknown;
  }): string[] | undefined {
    const { effectiveKind, input, existing, touchingConfig, validatedConfig } =
      args;
    if (effectiveKind === 'TEXT') {
      const switchingToText = input.kind === 'TEXT' && existing.kind !== 'TEXT';
      if (input.body !== undefined && input.body !== existing.body) {
        return extractTemplateVariables(input.body);
      }
      if (switchingToText) {
        return extractTemplateVariables(input.body ?? existing.body ?? '');
      }
      return undefined;
    }
    if (touchingConfig && validatedConfig !== undefined) {
      return extractTemplateVariables(
        collectInteractiveStrings(effectiveKind, validatedConfig),
      );
    }
    return undefined;
  }

  /**
   * Build the conditional-spread payload for `repo.update` — only fields the
   * operator actually supplied are written, plus the recomputed `variables`
   * and (when touched) the normalized `interactiveConfig`.
   */
  private buildTemplateUpdateData(args: {
    input: UpdateTemplate;
    touchingConfig: boolean;
    validatedConfig: unknown;
    variables: string[] | undefined;
  }): TemplateUpdateData {
    const { input, touchingConfig, validatedConfig, variables } = args;
    return {
      ...(input.language !== undefined && { language: input.language }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.category !== undefined && {
        category: input.category,
      }),
      ...(input.status !== undefined && {
        status: input.status,
      }),
      ...(input.kind !== undefined && {
        kind: input.kind,
      }),
      ...(touchingConfig && {
        interactiveConfig:
          validatedConfig === undefined
            ? Prisma.JsonNull
            : (validatedConfig as Prisma.InputJsonValue),
      }),
      ...(input.twilioContentSid !== undefined && {
        twilioContentSid: input.twilioContentSid,
      }),
      ...(input.provider !== undefined && { provider: input.provider }),
      ...(variables !== undefined && { variables }),
    };
  }

  /**
   * A PORTA LATERAL do `create` — trancada aqui.
   *
   * O `create` recusa `provider: 'ZERNIO'` (uma row nasceria APROVADA sem existir
   * na Meta). Mas o `updateTemplateSchema` aceita `provider` E `status`: um
   * ADMIN criava um template EVOLUTION (passa) e depois dava
   * `PATCH { provider: 'ZERNIO', status: 'APPROVED' }` — e pronto, a MESMA
   * mentira, com botões em `interactiveConfig` (shape do Evolution, com
   * buttonId) que a Meta nunca viu. Ela passava no gate de campanha e só
   * explodia no envio, com a campanha já agendada.
   *
   * Duas regras, e nenhuma tem exceção:
   *  1. NADA vira ZERNIO por PATCH. Template ZERNIO nasce em `POST /templates/
   *     zernio`, que fala com a Meta de verdade.
   *  2. O `status` de uma row ZERNIO é da META, não do operador. Quem o escreve é
   *     o webhook `template.status_updated` e o sync (que vão direto no repo).
   *     Um `PATCH status=APPROVED` aqui é fabricação de aprovação.
   */
  private assertZernioNotForgeableByPatch(
    existing: { provider: string | null; status: TemplateStatus },
    input: UpdateTemplate,
  ): void {
    if (input.provider === 'ZERNIO' && existing.provider !== 'ZERNIO') {
      throw new ValidationError(
        'Um template não pode virar ZERNIO por edição (a row ficaria "aprovada" sem existir na Meta). Use "Novo template Zernio", que cria o template de verdade na Meta e nasce pendente de aprovação.',
        `provider=${String(existing.provider)} → ZERNIO`,
        'template.zernio_requires_remote_create',
      );
    }
    if (
      existing.provider === 'ZERNIO' &&
      input.status !== undefined &&
      input.status !== existing.status
    ) {
      throw new ValidationError(
        'O status de um template ZERNIO é definido pela Meta (aprovação/pausa) — o orgamind apenas o espelha. Não é editável por aqui.',
        `status=${existing.status} → ${input.status}`,
        'template.zernio_status_not_editable',
      );
    }
  }

  /**
   * Multi-provider channels — twilioContentSid references a Twilio-approved
   * Content template and only makes sense for provider=TWILIO. Shared by
   * `update` (validated against the EFFECTIVE/merged values); `create`'s
   * equivalent check lives in createTemplateSchema (zod refine) since the
   * full input is available there in one shot.
   */
  private validateProviderTwilioConsistency(
    provider: ChannelProvider,
    twilioContentSid: string | null,
  ): void {
    if (provider === 'TWILIO' && !twilioContentSid) {
      throw new ValidationError(
        'Templates do provedor TWILIO exigem o campo twilioContentSid (Content SID aprovado).',
        `provider=${provider}`,
        'template.twilio_content_sid_required',
      );
    }
    if (provider !== 'TWILIO' && twilioContentSid) {
      throw new ValidationError(
        'twilioContentSid só é permitido para templates do provedor TWILIO.',
        `provider=${provider}`,
        'template.twilio_content_sid_not_allowed',
      );
    }
  }

  /**
   * Validate `interactiveConfig` against the per-kind schema. TEXT kind
   * forbids interactive config; non-TEXT kinds require it. Returns the
   * parsed config (typed) or `undefined` when none is needed.
   */
  private validateInteractiveConfig(kind: TemplateKind, raw: unknown): unknown {
    if (kind === 'TEXT') {
      // TEXT templates ignore interactiveConfig — clear it on persist so the
      // DB doesn't carry stale shapes from a previous kind.
      return undefined;
    }
    if (raw === undefined || raw === null) {
      throw new ValidationError(
        'interactiveConfig is required for non-TEXT templates',
        `kind=${kind}`,
        'template.interactive_config_required',
      );
    }
    const schema =
      kind === 'LIST'
        ? listConfigSchema
        : kind === 'BUTTONS'
          ? buttonsConfigSchema
          : pollConfigSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError(
        'interactiveConfig is invalid for the given kind',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; '),
        'template.interactive_config_invalid',
      );
    }
    return parsed.data;
  }

  // ── ZB: criar template COM BOTÕES no Zernio ──────────────────────────────

  /**
   * A lista fechada de rótulos de consentimento que a UI pode oferecer.
   *
   * Servida crua (`GET /templates/consent-buttons`) porque o frontend NÃO PODE
   * ter uma cópia: duas listas divergem no primeiro rótulo novo, e a divergência
   * aqui não dá erro — apaga consentimento em silêncio. Sem cópia, não há o que
   * divergir.
   */
  consentButtonChoices() {
    return CONSENT_BUTTON_CHOICES;
  }

  /**
   * POST /templates/zernio — cria o template DE VERDADE na Meta (via Zernio) e
   * grava a row local como PENDING.
   *
   * A ordem dos passos é a garantia:
   *
   *  1. VALIDA (agregado, PT-BR) — inclusive o casamento rótulo↔reconhecedor.
   *     Um template submetido é IMUTÁVEL na Meta: se o rótulo errado passar e for
   *     aprovado, não se corrige um campo — cria-se outro template e espera-se
   *     mais 24h. O gate TEM de ser antes do POST.
   *  2. Cria na Meta. `status` vem PENDING — jamais fabricamos APPROVED.
   *  3. RELÊ o template e reconfere o rótulo EFETIVO (o que a Meta guardou é o
   *     que volta no clique). Se o botão de opt-in deixou de ser reconhecível,
   *     NÃO persiste: uma row utilizável em campanha que colhe zero é pior do que
   *     nenhuma row.
   *  4. Persiste pelo MESMO upsert do sync (round-trip fiel, idempotente).
   */
  async createZernio(input: CreateZernioTemplate) {
    if (!this.zernioTemplates.configured) {
      throw new ZernioCredentialsNotConfiguredError();
    }

    // Passo 1 — o gate. Antes de qualquer I/O: um input inválido não merece uma
    // ida à Meta, e um rótulo não reconhecido não merece nascer.
    const problems = validateZernioTemplateInput(input);
    if (problems.length > 0) {
      throw new ValidationError(
        `Template Zernio inválido: ${problems.join(' ')}`,
        problems.join('\n'),
        'template.zernio_invalid',
      );
    }

    const channel = await this.repo.findZernioChannel(input.channelId);
    if (!channel) {
      throw new ValidationError(
        'Canal Zernio inválido: escolha um canal ZERNIO ativo com conta WhatsApp configurada (o catálogo de templates é por conta).',
        `channelId=${input.channelId}`,
        'template.zernio_channel_invalid',
      );
    }

    // A identidade REAL de um template de canal é a chave composta — checar por
    // `metaName` global recusaria um nome que outra WABA legitimamente já usa.
    const duplicate = await this.repo.findByChannelAndName({
      provider: 'ZERNIO',
      channelId: channel.id,
      metaName: input.name,
      language: input.language,
    });
    if (duplicate) throw new TemplateMetaNameConflictError(input.name);

    const components = buildZernioComponents(input);

    // Passo 2 — a Meta, de verdade.
    const remote = await this.zernioTemplates.create(channel.zernioAccountId, {
      name: input.name,
      language: input.language,
      category: input.category,
      components,
    });

    // Passo 3 — o round-trip. É o que transforma a garantia de INTENÇÃO em
    // garantia de FATO.
    await this.assertRemoteConsentLabelsIntact(
      channel.zernioAccountId,
      input,
      remote.id,
    );

    const declaredRoles: DeclaredConsentButton[] = input.buttons
      .filter((b) => b.type === 'QUICK_REPLY')
      .map((b) => ({
        text: b.text,
        role: b.type === 'QUICK_REPLY' ? b.role : 'NONE',
      }));

    const body = input.body;
    const created = await this.repo.upsertZernioTemplate({
      channelId: channel.id,
      metaName: input.name,
      language: input.language,
      data: {
        body,
        variables: extractTemplateVariables(body),
        // PENDING (ou o que a Meta disser) — nunca APPROVED fabricado. O gate de
        // campanha continua fechado até o webhook/sync trazer a aprovação.
        status: mapZernioTemplateStatus(remote.status),
        category: input.category,
        // Os components CRUS são a fonte de verdade dos botões — é o que o sync
        // reescreve por cima. Gravar os botões em `interactiveConfig` (o shape do
        // Evolution) faria as duas fontes divergirem no primeiro sync.
        kind:
          input.buttons.length > 0
            ? PrismaTemplateKind.BUTTONS
            : PrismaTemplateKind.TEXT,
        components: components as Prisma.InputJsonValue,
        // A DECLARAÇÃO do operador, persistida. É o que faz o gate de campanha
        // saber que o "Ver proposta" deste template é um botão comum (e não um
        // "sim" cujo rótulo o sistema não lê) — e é o que o sync reconcilia se a
        // Meta reescrever um rótulo.
        consentButtonRoles: declaredRoles,
        zernioTemplateId: remote.id || null,
        zernioStatusRaw: remote.status ?? null,
        lastZernioSyncAt: new Date(),
      },
    });

    await this.audit.log('template.zernio_create', 'Template', created.id, {
      metaName: input.name,
      channelId: channel.id,
      status: remote.status,
      zernioTemplateId: remote.id,
      // Registrar o papel dos botões é o que torna auditável, meses depois, POR
      // QUE um clique virou consentimento.
      buttons: input.buttons.map((b) => ({
        type: b.type,
        text: b.text,
        role: b.type === 'QUICK_REPLY' ? b.role : undefined,
      })),
    });
    return created;
  }

  /**
   * Relê o template recém-criado e reconfere que os rótulos de consentimento
   * continuam sendo RECONHECIDOS na forma em que a Meta os guardou.
   *
   * Por que isto não é paranoia: o rótulo que chega no webhook quando a pessoa
   * toca o botão é o rótulo armazenado do lado da Meta, não o que mandamos. Se
   * ele foi truncado ou reescrito a ponto de sair da lista fechada, cada clique
   * some em silêncio — o modo de falha que este trabalho inteiro existe para
   * fechar. Melhor recusar a row do que deixar a campanha rodar sobre ela.
   *
   * Uma FALHA DE LEITURA (timeout, 404 de propagação) não bloqueia: o template já
   * existe na Meta e a validação local já garantiu o rótulo. Aqui a ausência de
   * prova não é prova de problema — mas fica o warn.
   */
  private async assertRemoteConsentLabelsIntact(
    accountId: string,
    input: CreateZernioTemplate,
    zernioTemplateId: string,
  ): Promise<void> {
    const consentButtons = input.buttons.filter(
      (b) => b.type === 'QUICK_REPLY' && b.role !== 'NONE',
    );
    if (consentButtons.length === 0) return;

    let remote: ZernioTemplateItem | null;
    try {
      remote = await this.zernioTemplates.getByName(accountId, input.name);
    } catch (err) {
      this.logger.warn(
        `Zernio: não consegui reler o template "${input.name}" para conferir os rótulos de consentimento: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (!remote) return; // ainda não propagou — a validação local já garantiu

    const effective = extractZernioButtonTexts(remote.components);
    if (effective.length === 0) return;

    const unrecognized = consentButtons.filter((b) => {
      // Casa o botão pelo rótulo enviado; se a Meta o alterou, o `find` falha e
      // o botão entra na lista de problemas — que é exatamente o que queremos.
      const match = effective.find(
        (t) => squashButton(t) === squashButton(b.text),
      );
      if (!match) return true;
      return b.type === 'QUICK_REPLY' && b.role === 'OPT_IN'
        ? !isZernioOptInButton(match)
        : !isZernioOptOutButton(match);
    });

    if (unrecognized.length === 0) return;

    // ★ A REJEIÇÃO SÓ VALE SE O TEMPLATE MORRER NA META.
    //
    // Recusar a row local e deixar o template lá era uma rejeição de 60 minutos:
    // o `syncFromZernio` roda de hora em hora, lista TUDO da conta e faz upsert —
    // o template voltaria SOZINHO, como uma row normal, e uma vez APROVADO
    // passaria no gate de campanha. "Não persisti" não é o mesmo que "não
    // existe": o que decide é o que está na Meta.
    //
    // Se o DELETE falhar, a row continua não nascendo E o operador é instruído a
    // apagar no painel — mas o gate de campanha ainda o pegaria (o sync o
    // importaria SEM declaração de papel, e um rótulo não reconhecido sem papel
    // declarado não passa no gate). Cinto e suspensório.
    let removed = true;
    try {
      await this.zernioTemplates.delete(accountId, input.name);
    } catch (err) {
      removed = false;
      this.logger.error(
        `Zernio: template "${input.name}" (id ${zernioTemplateId}) tem rótulo de consentimento não reconhecido e NÃO consegui apagá-lo na Meta: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    throw new ValidationError(
      `O template foi criado na Meta (id ${zernioTemplateId}), mas os rótulos que ela guardou NÃO são reconhecidos pelo sistema: ${unrecognized
        .map((b) => `"${b.text}"`)
        .join(
          ', ',
        )}. Os cliques nesses botões não gravariam consentimento — o template NÃO foi habilitado no orgamind${
        removed
          ? ' e foi APAGADO na Meta'
          : ' — e NÃO consegui apagá-lo na Meta: apague-o no painel do Zernio'
      }. Crie outro com um rótulo da lista.`,
      `rótulos efetivos: ${effective.join(' | ')}`,
      'template.zernio_button_label_unrecognized_remote',
    );
  }

  // ── ZB — a declaração de papel dos botões de um template IMPORTADO ────────

  /**
   * PATCH /templates/:id/consent-buttons — o operador diz o que cada botão de
   * resposta rápida SIGNIFICA, e o sistema confere contra o reconhecedor.
   *
   * Por que este endpoint existe: um template criado direto no painel do
   * Zernio/Meta (o caminho de sempre, até ontem) chega pelo sync SEM declaração
   * de papel. Do rótulo sozinho é INDECIDÍVEL se "Bora, quero!" é um botão comum
   * ou o "sim" de um opt-in — e a diferença entre os dois é 13.400 consentimentos
   * documentados ou zero. Então o gate de campanha bloqueia o template até
   * alguém DIZER; este é o lugar de dizer.
   *
   * O que ele NÃO faz: aceitar uma declaração que o reconhecedor desmente. Marcar
   * "Bora, quero!" como OPT_IN é rejeitado aqui — porque o clique continuaria
   * indo para o lixo, e uma declaração que mente é pior do que nenhuma.
   */
  async declareConsentButtons(id: string, input: DeclareConsentButtons) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new TemplateNotFoundError(id);
    if (existing.provider !== 'ZERNIO') {
      throw new ValidationError(
        'Só templates ZERNIO precisam de declaração de papel dos botões — nos outros provedores o clique volta com um id que nós escolhemos.',
        `provider=${String(existing.provider)}`,
        'template.consent_buttons_not_zernio',
      );
    }

    const labels = extractQuickReplyLabels(existing.components);
    if (labels.length === 0) {
      throw new ValidationError(
        'Este template não tem botões de resposta rápida — não há o que classificar.',
        `metaName=${existing.metaName}`,
        'template.consent_buttons_absent',
      );
    }

    // A declaração é sobre os rótulos QUE A META TEM. Um texto que não existe
    // mais (ou que nunca existiu) não pode entrar: seria uma declaração sobre um
    // botão fantasma, e o gate a ignoraria em silêncio.
    const byLabel = new Map(
      input.buttons.map((b) => [squashButton(b.text), b.role]),
    );
    const declared: DeclaredConsentButton[] = [];
    const missing: string[] = [];
    for (const text of labels) {
      const role = byLabel.get(squashButton(text));
      if (!role) {
        missing.push(text);
        continue;
      }
      declared.push({ text, role });
    }
    if (missing.length > 0) {
      throw new ValidationError(
        `Todos os botões precisam de um papel declarado — faltou: ${missing
          .map((t) => `"${t}"`)
          .join(', ')}.`,
        `rótulos na Meta: ${labels.join(' | ')}`,
        'template.consent_buttons_incomplete',
      );
    }

    const problems = auditConsentButtons(
      declared.map((b, i) => ({ position: i + 1, text: b.text, role: b.role })),
    );
    if (problems.length > 0) {
      throw new ValidationError(
        `Declaração inválida: ${problems.join(' ')}`,
        problems.join('\n'),
        'template.zernio_button_roles_invalid',
      );
    }

    const updated = await this.repo.update(id, {
      consentButtonRoles: declared,
    });
    await this.audit.log('template.consent_buttons', 'Template', id, {
      metaName: existing.metaName,
      buttons: declared,
    });
    return updated;
  }

  // ── twilio-platform T4: criar/submeter/editar rascunho na Content API ─────

  /**
   * POST /templates/twilio — valida (agregando TODOS os problemas em PT-BR),
   * cria o RASCUNHO na Twilio (POST /v1/Content) e grava o row local:
   * provider TWILIO, status PENDING, twilioApprovalStatus 'draft'. A
   * submissão à aprovação é o passo seguinte (submitTwilioApproval).
   */
  async createTwilio(input: CreateTwilioTemplate) {
    this.assertTwilioTemplateInputValid(input, input.name);

    const existing = await this.repo.findByMetaName(input.name);
    if (existing) throw new TemplateMetaNameConflictError(input.name);

    const types = buildTwilioContentTypes(input);
    const { sid } = await this.twilioContent.createContent({
      friendlyName: input.name,
      language: input.language,
      variables: input.variables,
      types,
    });

    const created = await this.repo.create({
      metaName: input.name,
      language: input.language,
      body: input.body,
      variables: Object.keys(input.variables),
      // PENDING até a Meta aprovar; o raw 'draft' marca que ainda nem foi
      // submetido (o enum local não tem DRAFT e PENDING nunca libera envio).
      status: TemplateStatus.PENDING,
      category: input.category,
      kind: TWILIO_TEMPLATE_KIND[input.contentType],
      // Types não-texto ficam no interactiveConfig com o shape EXATO enviado
      // à Twilio (round-trip fiel p/ edição de rascunho e exibição).
      interactiveConfig:
        input.contentType === 'twilio/text'
          ? Prisma.JsonNull
          : (types as Prisma.InputJsonValue),
      provider: 'TWILIO',
      twilioContentSid: sid,
      twilioApprovalStatus: 'draft',
    });
    await this.audit.log('template.twilio_create', 'Template', created.id, {
      metaName: created.metaName,
      contentType: input.contentType,
      twilioContentSid: sid,
    });
    return created;
  }

  /**
   * POST /templates/:id/twilio-submit — submete o rascunho à aprovação do
   * WhatsApp com name=metaName + categoria do row. Só rascunhos ('draft' ou
   * null legado); depois disso o template é imutável na Twilio.
   */
  async submitTwilioApproval(id: string) {
    const existing = await this.assertTwilioDraft(id);

    const { status } = await this.twilioContent.submitApproval(
      existing.twilioContentSid as string,
      { name: existing.metaName, category: existing.category },
    );

    const updated = await this.repo.update(id, {
      twilioApprovalStatus: status,
      status: mapTwilioApprovalStatus(status),
      lastTwilioSyncAt: new Date(),
    });
    await this.audit.log('template.twilio_submit', 'Template', id, {
      metaName: existing.metaName,
      status,
    });
    return updated;
  }

  /**
   * PATCH /templates/:id/twilio-draft — edita o rascunho na Twilio (PUT, só
   * pré-submissão) e espelha no row local. Nome e idioma são imutáveis
   * (Content API não aceita mudar language num PUT).
   */
  async updateTwilioDraft(id: string, input: UpdateTwilioDraft) {
    const existing = await this.assertTwilioDraft(id);

    if (input.language !== existing.language) {
      throw new ValidationError(
        'O idioma de um rascunho não pode ser alterado (limitação da Content API) — crie um novo template no idioma desejado.',
        `language=${existing.language} → ${input.language}`,
        'template.twilio_language_immutable',
      );
    }
    this.assertTwilioTemplateInputValid(input, existing.metaName);

    const types = buildTwilioContentTypes(input);
    await this.twilioContent.updateDraft(existing.twilioContentSid as string, {
      friendlyName: existing.metaName,
      language: input.language,
      variables: input.variables,
      types,
    });

    const updated = await this.repo.update(id, {
      body: input.body,
      category: input.category,
      variables: Object.keys(input.variables),
      kind: TWILIO_TEMPLATE_KIND[input.contentType],
      interactiveConfig:
        input.contentType === 'twilio/text'
          ? Prisma.JsonNull
          : (types as Prisma.InputJsonValue),
    });
    await this.audit.log('template.twilio_draft_update', 'Template', id, {
      metaName: existing.metaName,
      contentType: input.contentType,
    });
    return updated;
  }

  /**
   * Validação pré-Twilio (função pura) — agrega TODOS os problemas em PT-BR
   * num único ValidationError, para o operador corrigir tudo de uma vez.
   */
  private assertTwilioTemplateInputValid(
    input: UpdateTwilioDraft,
    name: string,
  ): void {
    const problems = validateTwilioTemplateInput({ ...input, name });
    if (problems.length === 0) return;
    throw new ValidationError(
      `Template Twilio inválido: ${problems.join(' ')}`,
      problems.join('\n'),
      'template.twilio_invalid',
    );
  }

  /**
   * Gate comum de submit/edição: o row existe, é TWILIO com Content SID e
   * ainda está em rascunho. Retorna o row para o caller.
   */
  private async assertTwilioDraft(id: string) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new TemplateNotFoundError(id);
    if (existing.provider !== 'TWILIO' || !existing.twilioContentSid) {
      throw new TemplateNotTwilioError(id);
    }
    if (!isTwilioDraft(existing.twilioApprovalStatus)) {
      throw new TemplateNotDraftError(id, existing.twilioApprovalStatus);
    }
    return existing;
  }

  async delete(id: string) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new TemplateNotFoundError(id);

    // T4: campanha ATIVA (rodando/na fila/agendada) → bloqueio com mensagem
    // específica; vem ANTES do check genérico (que conta qualquer campanha).
    const active = await this.repo.countActiveCampaignsUsingTemplate(id);
    if (active > 0) throw new TemplateActiveCampaignError(id, active);

    const inUse = await this.repo.findInUseByCampaigns(id);
    if (inUse > 0) throw new TemplateInUseError(id, inUse);

    // T4: template TWILIO com Content SID também sai da Twilio/WABA
    // (deleteInWaba=true). Antes do delete local: se a Twilio recusar, o row
    // permanece e nada fica órfão lá (404 é tolerado pelo service).
    if (existing.provider === 'TWILIO' && existing.twilioContentSid) {
      await this.twilioContent.deleteContent(existing.twilioContentSid);
    }

    const deleted = await this.repo.delete(id);
    await this.audit.log('template.delete', 'Template', id, {
      metaName: existing.metaName,
    });
    return deleted;
  }

  async syncFromMeta() {
    const wabaId = this.config.get('META_BUSINESS_ACCOUNT_ID', { infer: true });
    const token = this.config.get('META_ACCESS_TOKEN', { infer: true });
    if (!wabaId || !token) throw new MetaCredentialsNotConfiguredError();

    const authHeaders = { Authorization: `Bearer ${token}` };
    const baseUrl = `https://graph.facebook.com/v22.0/${wabaId}/message_templates`;

    let synced = 0;
    let skipped = 0;

    // Meta's Graph API caps each page at 100 items and returns the next page's
    // absolute URL under `data.paging.next`. Follow it until exhausted, with a
    // hard page cap so a misbehaving cursor can never loop forever.
    const MAX_PAGES = 50;
    let nextUrl: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data } = await axios.get(
        nextUrl ?? baseUrl,
        // The `next` URL already carries the cursor + limit query params, so
        // only the first (base) request needs `params`; both need auth + timeout.
        nextUrl
          ? { headers: authHeaders, timeout: 15_000 }
          : { headers: authHeaders, params: { limit: 100 }, timeout: 15_000 },
      );

      for (const t of data.data ?? []) {
        try {
          const body: string =
            t.components?.find((c: any) => c.type === 'BODY')?.text ?? '';
          const variables = extractTemplateVariables(body);

          // Meta reports statuses beyond our enum (PAUSED, DISABLED, IN_APPEAL…)
          // and legacy categories (OTP…). Normalize each unknown value to a safe
          // default rather than letting an out-of-enum value blow up the Prisma
          // write (and abort the whole sync). PENDING is the safe non-sending
          // default for unknown statuses; UTILITY for unknown categories.
          const status = this.normalizeStatus(t.status, t.name);
          const category = this.normalizeCategory(t.category, t.name);

          await this.repo.upsertByMetaName({
            metaName: t.name,
            language: t.language,
            body,
            variables,
            status,
            category,
          });
          synced++;
        } catch (err) {
          // One bad item (e.g. a transient DB error) must not abort the sync —
          // skip it, count it, and keep going so the rest of the catalog lands.
          skipped++;
          this.logger.warn(
            `Skipped template sync for "${t?.name ?? '<unknown>'}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      nextUrl = data.paging?.next;
      if (!nextUrl) break;
      if (page === MAX_PAGES - 1) {
        this.logger.warn(
          `Template sync hit the ${MAX_PAGES}-page cap; remaining pages skipped`,
        );
      }
    }
    await this.audit.log('template.sync', 'Template', undefined, {
      synced,
      skipped,
    });
    return { synced, skipped };
  }

  /**
   * ZC — sync do catálogo de templates do Zernio, **por CANAL**.
   *
   * O Zernio não tem catálogo da organização: cada conta WhatsApp (WABA) expõe o
   * seu, e `accountId` é obrigatório na query. Por isso o upsert casa pela
   * identidade completa — (provider, channelId, metaName, language) — e não pelo
   * `metaName`: duas WABAs podem ter um `boas_vindas` cada, com corpos e ids da
   * Meta diferentes, e o unique global fazia o 2º canal sobrescrever o 1º.
   *
   * Idempotente: rodar duas vezes não duplica nem cria row nova.
   *
   * Resiliência em dois níveis, ambos deliberados:
   *  - falha de REDE em UMA conta → loga e segue para as outras (as já
   *    processadas não se perdem, e "não consegui ler" nunca vira "0 templates");
   *  - item torto (status novo da Meta, categoria legada, erro de escrita) →
   *    pula, conta e segue. Um `DISABLED` já derrubou o sync inteiro no Zod.
   */
  async syncFromZernio() {
    if (!this.zernioTemplates.configured) {
      throw new ZernioCredentialsNotConfiguredError();
    }

    const channels = await this.repo.listActiveZernioAccounts();

    let synced = 0;
    let skipped = 0;

    for (const channel of channels) {
      let templates: ZernioTemplateItem[];
      try {
        templates = await this.zernioTemplates.list(channel.zernioAccountId);
      } catch (err) {
        this.logger.warn(
          `Zernio template sync failed for account "${channel.name}" (${
            channel.zernioAccountId
          }): ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      const now = new Date();
      for (const t of templates) {
        try {
          const body = extractZernioBody(t.components);
          const consentButtonRoles = await this.reconcileSyncedConsentButtons(
            channel,
            t,
          );
          await this.repo.upsertZernioTemplate({
            channelId: channel.id,
            metaName: t.name,
            language: t.language,
            data: {
              body,
              // ★ A declaração de papel dos botões, RECONCILIADA com os rótulos
              // que a Meta reporta agora. Sem isto, o sync era o buraco por onde
              // um template de opt-in criado no painel do Zernio — com o botão
              // "Bora, quero!", que o reconhecedor não lê — entrava APROVADO e
              // selecionável na campanha, e cada um dos 13.400 cliques no "sim"
              // ia para o lixo sem uma linha de log. Ver o gate em
              // campaigns.service (assertTemplateConsentButtonsUsable).
              consentButtonRoles:
                consentButtonRoles.length > 0
                  ? consentButtonRoles
                  : Prisma.JsonNull,
              // As variáveis saem do BODY; os `components` guardam a estrutura
              // completa (header/botões), que é o que permite montar o array
              // posicional de templateParams sem chutar.
              variables: extractTemplateVariables(body),
              status: mapZernioTemplateStatus(t.status),
              category: this.normalizeCategory(t.category, t.name),
              zernioTemplateId: t.id || null,
              components: t.components ?? Prisma.JsonNull,
              // O raw preserva o diagnóstico que o enum perde (DISABLED e
              // PENDING_DELETION viram ambos PAUSED).
              zernioStatusRaw: t.status ?? null,
              lastZernioSyncAt: now,
            },
          });
          synced++;
        } catch (err) {
          skipped++;
          this.logger.warn(
            `Skipped Zernio template sync for "${t?.name ?? '<unknown>'}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    await this.audit.log('template.sync_zernio', 'Template', undefined, {
      synced,
      skipped,
    });
    return { synced, skipped };
  }

  /**
   * O sync olha o rótulo — e é aqui que ele olha.
   *
   * A declaração de papel é do OPERADOR e o rótulo é da META: quando a Meta
   * reescreve/trunca um rótulo, a declaração antiga deixa de valer para ele, e o
   * botão volta a "não declarado" — que o gate de campanha BLOQUEIA. É o que
   * impede uma row aprovada e utilizável de colher zero depois de um round-trip
   * silencioso.
   *
   * Um template importado (criado no painel do Zernio) chega, por construção, sem
   * declaração nenhuma: fica bloqueado até alguém dizer o que os botões
   * significam (`PATCH /templates/:id/consent-buttons`). O WARN é para o log; o
   * bloqueio é o que protege a campanha.
   */
  private async reconcileSyncedConsentButtons(
    channel: { id: string },
    t: ZernioTemplateItem,
  ): Promise<DeclaredConsentButton[]> {
    const labels = extractQuickReplyLabels(t.components);
    if (labels.length === 0) return [];

    const existing = await this.repo.findZernioTemplate({
      channelId: channel.id,
      metaName: t.name,
      language: t.language,
      zernioTemplateId: t.id || undefined,
    });
    const declared = reconcileConsentButtonRoles(
      readDeclaredConsentButtons(existing?.consentButtonRoles),
      labels,
    );

    const problems = auditZernioTemplateRow({
      components: t.components,
      consentButtonRoles: declared,
    });
    if (problems.length > 0) {
      this.logger.warn(
        `Zernio: template "${t.name}" tem botões que o sistema não sabe ler — NÃO poderá ser usado em campanha até ser classificado: ${problems.join(' ')}`,
      );
    }
    return declared;
  }

  /**
   * ZC — o webhook `whatsapp.template.status_updated` chegou: atualiza o status
   * NA HORA, sem polling.
   *
   * É isto que torna o job de reconciliação uma REDE DE SEGURANÇA (1h) em vez do
   * mecanismo principal: o balde do Zernio é de 60 req/min POR CHAVE e é o MESMO
   * do envio — um sync agressivo competiria com a campanha.
   *
   * A Meta **não manda a category nem o status anterior** neste evento, então o
   * upsert casa por templateId (ou por canal+nome+idioma) e toca SÓ o status.
   * Evento de um template que o orgamind não conhece → `false` (quem chama loga);
   * o sync de 1h o traz depois.
   */
  async applyZernioTemplateStatus(args: {
    channelId: string;
    zernioTemplateId?: string;
    metaName: string;
    language: string;
    status?: string;
    reason?: string;
  }): Promise<boolean> {
    const existing = await this.repo.findZernioTemplate(args);
    if (!existing) return false;

    // 'NONE' é como a Meta diz "sem motivo" num template aprovado — gravá-lo
    // faria a UI exibir "Motivo: NONE" num template saudável.
    const reason =
      args.reason && args.reason.toUpperCase() !== 'NONE' ? args.reason : null;

    await this.repo.update(existing.id, {
      status: mapZernioTemplateStatus(args.status),
      zernioStatusRaw: args.status ?? null,
      zernioRejectionReason: reason,
      lastZernioSyncAt: new Date(),
    });
    await this.audit.log('template.status_updated', 'Template', existing.id, {
      metaName: args.metaName,
      status: args.status,
      reason,
    });
    return true;
  }

  /**
   * Validate a Meta-reported status against our enum, mapping any unknown
   * value (PAUSED, DISABLED, IN_APPEAL, …) to a safe PENDING default and
   * logging it. Keeps out-of-enum values from blowing up the Prisma write.
   */
  private normalizeStatus(raw: unknown, metaName: string): TemplateStatus {
    const parsed = templateStatusEnum.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.logger.warn(
      `Template "${metaName}" has unknown Meta status "${String(
        raw,
      )}" — defaulting to PENDING`,
    );
    return TemplateStatus.PENDING;
  }

  /**
   * Validate a Meta-reported category against our enum, mapping any unknown
   * or missing value (legacy OTP, …) to a safe UTILITY default and logging it.
   */
  private normalizeCategory(raw: unknown, metaName: string): TemplateCategory {
    const candidate = raw ?? 'UTILITY';
    const parsed = templateCategoryEnum.safeParse(candidate);
    if (parsed.success) return parsed.data;
    this.logger.warn(
      `Template "${metaName}" has unknown Meta category "${String(
        raw,
      )}" — defaulting to UTILITY`,
    );
    return TemplateCategory.UTILITY;
  }
}

type ListCfg = {
  title?: string;
  description?: string;
  buttonText?: string;
  footerText?: string;
  sections?: Array<{
    title?: string;
    rows?: Array<{ title?: string; description?: string }>;
  }>;
};
type ButtonsCfg = {
  title?: string;
  description?: string;
  footerText?: string;
  buttons?: Array<{ title?: string }>;
};
type PollCfg = { question?: string; options?: string[] };

/**
 * Per-kind string collectors. Each returns every operator-authored string for
 * that kind (falsy entries are dropped by the caller via `filter(Boolean)`),
 * preserving the original first-seen ordering that `Template.variables` relies
 * on. TEXT has no interactive strings, so it contributes nothing.
 */
const INTERACTIVE_STRING_COLLECTORS: Record<
  TemplateKind,
  (cfg: unknown) => Array<string | undefined>
> = {
  TEXT: () => [],
  LIST: (cfg) => {
    const c = cfg as ListCfg;
    return [
      c.title,
      c.description,
      c.buttonText,
      c.footerText,
      ...(c.sections ?? []).flatMap((s) => [
        s.title,
        ...(s.rows ?? []).flatMap((r) => [r.title, r.description]),
      ]),
    ];
  },
  BUTTONS: (cfg) => {
    const c = cfg as ButtonsCfg;
    return [
      c.title,
      c.description,
      c.footerText,
      ...(c.buttons ?? []).map((b) => b.title),
    ];
  },
  POLL: (cfg) => {
    const c = cfg as PollCfg;
    return [c.question, ...(c.options ?? [])];
  },
};

/**
 * Walk every operator-authored string in an interactive config and join
 * them. Used to feed `extractTemplateVariables` so {{var}} tokens inside
 * list rows / button labels / poll options end up in `Template.variables`,
 * which the worker uses to enrich runtime variables from the contact.
 */
function collectInteractiveStrings(kind: TemplateKind, cfg: unknown): string {
  if (cfg === null || cfg === undefined) return '';
  return INTERACTIVE_STRING_COLLECTORS[kind](cfg).filter(Boolean).join('\n');
}

/**
 * ZC — o texto do componente BODY dos `components` da Meta.
 *
 * `Template.body` continua sendo a coluna que a UI mostra e de onde as variáveis
 * `{{n}}` são extraídas; os `components` crus ficam guardados à parte porque são
 * eles que preservam a ESTRUTURA (header, botões) que o body sozinho perde.
 *
 * O `type` vem MAIÚSCULO na listagem, mas o OpenAPI declara minúsculo — aceitar
 * os dois custa uma linha e evita um catálogo silenciosamente sem corpo.
 */
export function extractZernioBody(components: unknown): string {
  if (!Array.isArray(components)) return '';
  for (const c of components) {
    if (typeof c !== 'object' || c === null) continue;
    const comp = c as Record<string, unknown>;
    if (String(comp.type ?? '').toUpperCase() !== 'BODY') continue;
    return typeof comp.text === 'string' ? comp.text : '';
  }
  return '';
}
