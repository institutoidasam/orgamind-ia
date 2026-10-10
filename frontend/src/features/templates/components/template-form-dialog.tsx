import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { HTTPError } from 'ky';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  GENERIC_TEMPLATE_PROVIDERS,
  TEMPLATE_LANGUAGE_OPTIONS,
  createTemplateSchema,
  extractVariables,
  type CreateTemplate,
  type Template,
  type TemplateKind,
  type UpdateTemplate,
} from '../schemas';
import { useCreateTemplate, useUpdateTemplate } from '../api';
import { type ChannelProvider } from '@/features/whatsapp/api';
import { PROVIDER_LABEL, useProviderScope } from '@/features/whatsapp/provider-scope';

type Mode =
  | { mode: 'create' }
  | { mode: 'edit'; initialData: Template };

type TemplateFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Mode;

/**
 * Pure factory for the form's default values — used both as the initial
 * value passed to react-hook-form and as the source for `form.reset`
 * whenever the dialog reopens or the edited template changes. Keeping this
 * outside the component lets us depend on the *contents* of `props` rather
 * than fighting React's identity comparisons.
 *
 * `defaultProvider` seeds the provider select for a *new* template — the
 * caller resolves it from the current global provider scope (falling back to
 * EVOLUTION when the scope is `'all'`). Edit mode ignores it: the provider
 * always comes from the template being edited.
 */
function defaultValuesFor(
  props: Mode,
  defaultProvider: ChannelProvider,
): FormValues {
  if (props.mode === 'edit') {
    return {
      metaName: props.initialData.metaName,
      language: props.initialData.language,
      body: props.initialData.body,
      category: props.initialData.category,
      kind: props.initialData.kind ?? 'TEXT',
      interactiveConfig: props.initialData.interactiveConfig ?? null,
      twilioContentSid: props.initialData.twilioContentSid ?? '',
      provider: props.initialData.provider,
    };
  }
  return {
    metaName: '',
    language: 'pt_BR',
    body: '',
    category: 'UTILITY',
    kind: 'TEXT',
    interactiveConfig: null,
    twilioContentSid: '',
    provider: defaultProvider,
  };
}

/**
 * Form values use the *input* shape of `createTemplateSchema` — fields
 * that have `.default(...)` in zod become required in the inferred output
 * type, but the form actually accepts them as optional inputs that the
 * resolver fills in with defaults. In edit mode `metaName` is shown
 * disabled because Meta names are immutable.
 */
type FormValues = z.input<typeof createTemplateSchema>;

// Per-kind JSON placeholders shown in the textarea — copy/paste, edit, save.
// Promoted to dedicated UI editors in a future wave.
const INTERACTIVE_PLACEHOLDERS: Record<Exclude<TemplateKind, 'TEXT'>, string> = {
  LIST: JSON.stringify(
    {
      title: 'Como podemos ajudar?',
      description: 'Olá {{nome}}, escolha uma opção:',
      buttonText: 'Ver opções',
      footerText: 'Atendimento OrgaMind',
      sections: [
        {
          title: 'Suporte',
          rows: [
            { rowId: 'sec1-row1', title: 'Problema técnico', description: 'Reportar um bug' },
            { rowId: 'sec1-row2', title: 'Dúvida geral' },
          ],
        },
      ],
    },
    null,
    2,
  ),
  BUTTONS: JSON.stringify(
    {
      description: 'Olá {{nome}}, podemos confirmar seu agendamento?',
      footerText: 'OrgaMind',
      buttons: [
        { buttonId: 'yes', title: 'Sim' },
        { buttonId: 'no', title: 'Não' },
      ],
    },
    null,
    2,
  ),
  POLL: JSON.stringify(
    {
      question: 'Qual o melhor horário, {{nome}}?',
      options: ['Manhã', 'Tarde', 'Noite'],
      selectableOptionsCount: 1,
    },
    null,
    2,
  ),
};

/**
 * Outcome of parsing the JSON-textarea into an interactive config for a
 * submit. For TEXT kind there is nothing to parse, so it succeeds with a
 * `null` config. For interactive kinds the raw text is `JSON.parse`d; a parse
 * failure is reported as an error message (mirroring the previous inline
 * `e instanceof Error ? e.message : 'JSON inválido'` behaviour) so the caller
 * can surface it next to the textarea and via a toast.
 */
export type ParseInteractiveConfigResult =
  | { ok: true; config: unknown }
  | { ok: false; message: string };

/**
 * Pure parse of the interactive-config textarea for the submit path. TEXT
 * templates carry no config (`null`); interactive kinds must contain valid
 * JSON. No side effects — the caller decides what to do with the result.
 */
export function parseInteractiveConfig(
  kind: TemplateKind,
  configText: string,
): ParseInteractiveConfigResult {
  if (kind === 'TEXT') return { ok: true, config: null };
  try {
    return { ok: true, config: JSON.parse(configText) };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'JSON inválido',
    };
  }
}

/**
 * Pure builder for the create/update mutation payload. Returns a mode-tagged
 * descriptor so the caller can dispatch to the right mutation. Mirrors the
 * previous inline construction exactly: only TEXT kind sends `body` on update
 * (interactive kinds tolerate the backend's stored empty body); on create the
 * body is forced to non-empty for TEXT and an empty placeholder otherwise; for
 * both, `interactiveConfig` is `null` for TEXT and the parsed config for
 * interactive kinds; create applies the `pt_BR`/`UTILITY` fallbacks.
 *
 * Multi-provider channels: `provider` is always included (the form makes it a
 * required, explicit choice). For `twilioContentSid`:
 *  - create omits it when empty — the backend defaults an absent field to
 *    `null`, and its create schema rejects an empty string outright.
 *  - edit always sends it (empty → explicit `null`, never omitted). Omitting
 *    it on edit would mean "leave unchanged" server-side, which — after
 *    switching a template away from TWILIO — would leave a stale Content SID
 *    in place and trip the backend's effective-value consistency check (see
 *    `templates.service.ts` `update()`).
 */
export function buildTemplatePayload(args: {
  mode: 'create' | 'edit';
  id?: string;
  kind: TemplateKind;
  values: FormValues;
  interactiveConfig: unknown;
}):
  | { mode: 'create'; input: CreateTemplate }
  | { mode: 'edit'; id: string; input: UpdateTemplate } {
  const { mode, kind, values, interactiveConfig } = args;
  const provider: ChannelProvider = values.provider ?? 'EVOLUTION';
  if (mode === 'edit') {
    return {
      mode: 'edit',
      id: args.id as string,
      input: {
        language: values.language,
        // Only send body for TEXT kind — interactive kinds tolerate the
        // backend's stored empty body.
        ...(kind === 'TEXT' ? { body: values.body ?? '' } : {}),
        category: values.category,
        kind,
        interactiveConfig: kind === 'TEXT' ? null : interactiveConfig,
        provider,
        twilioContentSid: values.twilioContentSid ? values.twilioContentSid : null,
      },
    };
  }
  return {
    mode: 'create',
    input: {
      metaName: values.metaName,
      language: values.language ?? 'pt_BR',
      category: values.category ?? 'UTILITY',
      // Force body to non-empty for TEXT, empty placeholder for others.
      body: kind === 'TEXT' ? (values.body ?? '') : '',
      kind,
      interactiveConfig: kind === 'TEXT' ? null : interactiveConfig,
      provider,
      // Only send the Content SID when the operator entered one — an empty
      // string would fail the backend's HX validation.
      ...(values.twilioContentSid
        ? { twilioContentSid: values.twilioContentSid }
        : {}),
    },
  };
}

/**
 * Side-effect descriptor for a failed submit. The caller translates this into
 * the concrete effects (field error, config error, toast). Keeping the mapping
 * pure makes the various error → message cases independently testable.
 */
export type TemplateSubmitError =
  | { kind: 'metaNameConflict'; field: 'metaName'; fieldMessage: string; toast: string }
  | { kind: 'interactiveInvalid'; configError: string; toast: string }
  | {
      kind: 'providerTwilioMismatch';
      field: 'twilioContentSid';
      fieldMessage: string;
      toast: string;
    }
  | {
      /**
       * ZB — o backend recusa criar/editar um template ZERNIO por aqui (a row
       * nasceria "aprovada" sem existir na Meta). Sem este ramo o erro caía no
       * genérico ("Falha ao salvar template"), sem campo em erro e sem uma pista
       * de que o caminho certo é o botão ao lado.
       */
      kind: 'zernioRequiresRemoteCreate';
      field: 'provider';
      fieldMessage: string;
      toast: string;
    }
  | { kind: 'forbidden'; toast: string }
  | { kind: 'serverError'; toast: string }
  | { kind: 'generic'; toast: string }
  | { kind: 'network'; toast: string };

/**
 * Pure-ish (async only because the HTTP body is read) mapping of a thrown
 * submit error to a descriptor of what the form should do. Mirrors the
 * previous inline branching exactly:
 *  - `template.meta_name_conflict` → metaName field error + toast
 *  - `template.interactive_config_invalid` / `_required` → config error + toast
 *  - `template.twilio_content_sid_required` / `_not_allowed` → twilioContentSid
 *    field error + toast (multi-provider channels backstop — the form's own
 *    zod refines should already block this before the request goes out)
 *  - HTTP 403 → admin-only toast
 *  - HTTP >= 500 → server-error toast
 *  - other HTTP → generic save-failure toast
 *  - non-HTTP → network toast
 */
export async function mapTemplateSubmitError(
  err: unknown,
): Promise<TemplateSubmitError> {
  if (!(err instanceof HTTPError)) {
    return { kind: 'network', toast: 'Erro de rede' };
  }
  let code: string | undefined;
  let detail: string | undefined;
  try {
    const data = (await err.response.clone().json()) as
      | { code?: string; title?: string; detail?: string }
      | undefined;
    code = data?.code;
    detail = data?.detail;
  } catch {
    // ignore parse failure
  }
  if (code === 'template.meta_name_conflict') {
    return {
      kind: 'metaNameConflict',
      field: 'metaName',
      fieldMessage: 'metaName já existe',
      toast: 'Já existe um template com esse metaName',
    };
  }
  if (
    code === 'template.interactive_config_invalid' ||
    code === 'template.interactive_config_required'
  ) {
    return {
      kind: 'interactiveInvalid',
      configError: detail ?? 'Configuração inválida',
      toast: 'Configuração interativa inválida',
    };
  }
  if (
    code === 'template.twilio_content_sid_required' ||
    code === 'template.twilio_content_sid_not_allowed'
  ) {
    return {
      kind: 'providerTwilioMismatch',
      field: 'twilioContentSid',
      fieldMessage: detail ?? 'Content SID inconsistente com o provedor selecionado',
      toast: 'Provedor e Content SID inconsistentes',
    };
  }
  if (code === 'template.zernio_requires_remote_create') {
    return {
      kind: 'zernioRequiresRemoteCreate',
      field: 'provider',
      fieldMessage:
        'Template Zernio não é criado por aqui — use "Novo template Zernio".',
      toast:
        'Use "Novo template Zernio": o template precisa nascer na Meta (e os botões, com rótulo reconhecido).',
    };
  }
  if (code === 'template.zernio_status_not_editable') {
    return {
      kind: 'zernioRequiresRemoteCreate',
      field: 'provider',
      fieldMessage:
        detail ?? 'O status de um template Zernio é definido pela Meta.',
      toast: 'O status de um template Zernio quem define é a Meta.',
    };
  }
  if (err.response.status === 403) {
    return {
      kind: 'forbidden',
      toast: 'Apenas administradores podem alterar templates',
    };
  }
  if (err.response.status >= 500) {
    return { kind: 'serverError', toast: 'Erro do servidor. Tente novamente.' };
  }
  return { kind: 'generic', toast: 'Falha ao salvar template' };
}

export function TemplateFormDialog(props: TemplateFormDialogProps) {
  const { open, onOpenChange } = props;
  const isEdit = props.mode === 'edit';

  const create = useCreateTemplate();
  const update = useUpdateTemplate();

  // Multi-provider channels — a new template defaults to the current global
  // provider scope when it's pinned to a single provider, otherwise falls
  // back to GOZAP (pedido do cliente, 2026-08-25 — GOZAP é o provedor ativo).
  // Edit mode ignores this: the provider always comes from the template being
  // edited.
  //
  // ZB — ZERNIO NUNCA é o default aqui, mesmo com o escopo global em Zernio:
  // este endpoint não fala com a Meta, e o backend recusa provider=ZERNIO. Com o
  // escopo em Zernio, o botão "Novo template" abria um form PRÉ-SELECIONADO num
  // provedor que só dá 400 — um fluxo que falha mudo. O caminho certo é o botão
  // "Novo template Zernio", ao lado.
  //
  // TWILIO também nunca é o default: deixou de ser oferecido no select deste
  // form (GENERIC_TEMPLATE_PROVIDERS), então um escopo global em Twilio cairia
  // no mesmo problema — um valor pré-selecionado que não está entre as opções.
  const { scope } = useProviderScope();
  const defaultProviderForCreate: ChannelProvider =
    scope === 'all' || scope === 'ZERNIO' || scope === 'TWILIO'
      ? 'GOZAP'
      : scope;

  // Capture the *initial* defaults once for react-hook-form. The form
  // contents are subsequently kept in sync with the props via the
  // `form.reset` effect below — this matters when the parent passes a new
  // `initialData` for editing without remounting the dialog.
  const initialDefaultsRef = useRef<FormValues | null>(null);
  if (initialDefaultsRef.current === null) {
    initialDefaultsRef.current = defaultValuesFor(
      props,
      defaultProviderForCreate,
    );
  }

  const form = useForm<FormValues>({
    resolver: zodResolver(createTemplateSchema),
    defaultValues: initialDefaultsRef.current,
  });

  // Track the JSON-textarea state separately from the parsed config so the
  // operator can fix invalid JSON without losing keystrokes.
  const [configText, setConfigText] = useState<string>('');
  const [configError, setConfigError] = useState<string | null>(null);

  // Reset form whenever the dialog reopens or the edited template changes
  // (e.g. parent swaps `initialData`). The previous code memoised
  // `defaultValues` with an explicit `id` dep and the lint disable, which
  // hid the staleness bug — a new `initialData` for the same id wouldn't
  // refresh the form.
  const mode = props.mode;
  const initialData = props.mode === 'edit' ? props.initialData : null;
  useEffect(() => {
    if (!open) return;
    const next: FormValues =
      mode === 'edit' && initialData
        ? defaultValuesFor({ mode: 'edit', initialData }, defaultProviderForCreate)
        : defaultValuesFor({ mode: 'create' }, defaultProviderForCreate);
    form.reset(next);
    const initial = next.interactiveConfig;
    if (initial && typeof initial === 'object') {
      setConfigText(JSON.stringify(initial, null, 2));
    } else if (next.kind && next.kind !== 'TEXT') {
      setConfigText(
        INTERACTIVE_PLACEHOLDERS[next.kind as Exclude<TemplateKind, 'TEXT'>],
      );
    } else {
      setConfigText('');
    }
    setConfigError(null);
  }, [open, mode, initialData, form, defaultProviderForCreate]);

  const kindValue = form.watch('kind') ?? 'TEXT';
  const bodyValue = form.watch('body') ?? '';
  const providerValue = form.watch('provider') ?? 'EVOLUTION';

  // ZB — ZERNIO só aparece (e travado) quando o template EDITADO já é dele: um
  // template Zernio existe na Meta, e nem se cria nem se troca de provedor por
  // aqui. Na CRIAÇÃO a opção simplesmente não existe.
  const isZernioRow = providerValue === 'ZERNIO';
  // Mesmo tratamento para um template TWILIO legado (pedido do cliente,
  // 2026-08-25): a Twilio saiu do select, mas uma row TWILIO que já existe
  // continua editável — só travada, sem oferecer "voltar" pra Twilio.
  const isTwilioRow = providerValue === 'TWILIO';
  const providerOptions: ChannelProvider[] = isZernioRow
    ? ['ZERNIO']
    : isTwilioRow
      ? ['TWILIO']
      : GENERIC_TEMPLATE_PROVIDERS;

  // Idioma — SELECT com os poucos idiomas usados (pt_BR padrão); um template
  // legado com idioma fora da lista ainda aparece (opção extra ad-hoc) em vez
  // de sumir do select.
  const languageValue = form.watch('language') ?? 'pt_BR';
  const languageOptions = useMemo(() => {
    if (TEMPLATE_LANGUAGE_OPTIONS.some((o) => o.value === languageValue)) {
      return TEMPLATE_LANGUAGE_OPTIONS;
    }
    return [
      ...TEMPLATE_LANGUAGE_OPTIONS,
      { value: languageValue, label: `${languageValue} (importado)` },
    ];
  }, [languageValue]);

  // Detected variables: from body for TEXT, from config JSON for others.
  // We swallow JSON parse errors here — the operator-facing error is shown
  // alongside the textarea, not in the variable preview.
  const detectedVariables = useMemo(() => {
    if (kindValue === 'TEXT') return extractVariables(bodyValue);
    try {
      const parsed: unknown = configText ? JSON.parse(configText) : null;
      return extractVariables(JSON.stringify(parsed ?? {}));
    } catch {
      return [];
    }
  }, [kindValue, bodyValue, configText]);

  // Re-seed the JSON textarea when the operator switches kind on a fresh
  // (untouched) form — preserves their work otherwise.
  function handleKindChange(next: TemplateKind) {
    form.setValue('kind', next);
    setConfigError(null);
    if (next === 'TEXT') {
      form.setValue('interactiveConfig', null);
      return;
    }
    const placeholder =
      INTERACTIVE_PLACEHOLDERS[next as Exclude<TemplateKind, 'TEXT'>];
    if (!configText.trim()) {
      setConfigText(placeholder);
    }
  }

  // Multi-provider channels — the Content SID only makes sense for TWILIO.
  // Switching away from TWILIO clears whatever the operator had typed so a
  // stale SID never gets silently carried over to another provider, and
  // warns them so the field disappearing isn't a surprise.
  function handleProviderChange(next: ChannelProvider) {
    const hadSid = !!form.getValues('twilioContentSid');
    form.setValue('provider', next, { shouldValidate: true });
    if (next !== 'TWILIO' && hadSid) {
      form.setValue('twilioContentSid', '', { shouldValidate: true });
      toast.info(
        'O Content SID da Twilio foi removido — o provedor selecionado não é Twilio.',
      );
    }
  }

  const onSubmit = form.handleSubmit(async (values) => {
    const kind = values.kind ?? 'TEXT';

    // parse
    const parsed = parseInteractiveConfig(kind, configText);
    if (!parsed.ok) {
      setConfigError(parsed.message);
      toast.error('Configuração JSON inválida');
      return;
    }
    if (kind !== 'TEXT') setConfigError(null);

    // build
    const payload = buildTemplatePayload({
      mode: props.mode,
      id: props.mode === 'edit' ? props.initialData.id : undefined,
      kind,
      values,
      interactiveConfig: parsed.config,
    });

    // mutate
    try {
      if (payload.mode === 'edit') {
        await update.mutateAsync({ id: payload.id, input: payload.input });
        toast.success('Template atualizado');
      } else {
        await create.mutateAsync(payload.input);
        toast.success('Template criado');
      }
      onOpenChange(false);
    } catch (err) {
      // catch(map)
      const mapped = await mapTemplateSubmitError(err);
      if (mapped.kind === 'metaNameConflict') {
        form.setError(mapped.field, { message: mapped.fieldMessage });
      } else if (mapped.kind === 'interactiveInvalid') {
        setConfigError(mapped.configError);
      } else if (
        mapped.kind === 'providerTwilioMismatch' ||
        mapped.kind === 'zernioRequiresRemoteCreate'
      ) {
        form.setError(mapped.field, { message: mapped.fieldMessage });
      }
      toast.error(mapped.toast);
    }
  });

  const isPending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Editar template' : 'Novo template'}
          </DialogTitle>
          <DialogDescription>
            Use {'{{1}}'}, {'{{2}}'}, ... ou {'{{nome}}'} para variáveis. Elas
            são detectadas automaticamente.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="metaName">metaName</Label>
            <Input
              id="metaName"
              autoComplete="off"
              disabled={isEdit}
              placeholder="boas_vindas"
              {...form.register('metaName', {
                onChange: (e) => {
                  // Meta names are lowercase-only — normalise live so a user
                  // typing uppercase never trips the validation error.
                  e.target.value = e.target.value.toLowerCase();
                },
              })}
            />
            <p className="text-xs text-muted-foreground">
              Somente minúsculas, números e _ — ex.: convite_apoiadores
            </p>
            {form.formState.errors.metaName && (
              <p className="text-xs text-destructive">
                {form.formState.errors.metaName.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider">Provedor</Label>
            <Select
              value={providerValue}
              disabled={isZernioRow || isTwilioRow}
              onValueChange={(v) => handleProviderChange(v as ChannelProvider)}
            >
              <SelectTrigger id="provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* ZERNIO fora da lista: lá o template tem de nascer NA META
                    (botão "Novo template Zernio"), com o rótulo dos botões
                    casado com o reconhecedor de consentimento. */}
                {providerOptions.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PROVIDER_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Cada template pertence a um único provedor de envio.
            </p>
            {form.formState.errors.provider && (
              <p className="text-xs text-destructive">
                {form.formState.errors.provider.message}
              </p>
            )}
          </div>

          {providerValue === 'TWILIO' && (
            <div className="space-y-1">
              <Label htmlFor="twilioContentSid">Twilio Content SID</Label>
              <Input
                id="twilioContentSid"
                autoComplete="off"
                placeholder="HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                {...form.register('twilioContentSid')}
              />
              <p className="text-xs text-muted-foreground">
                Cole o Content SID do template aprovado na Twilio (envio
                oficial por template).
              </p>
              {form.formState.errors.twilioContentSid && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.twilioContentSid.message}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="language">Idioma</Label>
              <Select
                value={languageValue}
                onValueChange={(v) =>
                  form.setValue('language', v, { shouldValidate: true })
                }
              >
                <SelectTrigger id="language" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {languageOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.formState.errors.language && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.language.message}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="category">Categoria</Label>
              <Select
                value={form.watch('category')}
                onValueChange={(v) =>
                  form.setValue('category', v as FormValues['category'])
                }
              >
                <SelectTrigger id="category" className="w-full">
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MARKETING">MARKETING</SelectItem>
                  <SelectItem value="UTILITY">UTILITY</SelectItem>
                  <SelectItem value="AUTHENTICATION">AUTHENTICATION</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kind">Tipo</Label>
            <Select
              value={kindValue}
              onValueChange={(v) => handleKindChange(v as TemplateKind)}
            >
              <SelectTrigger id="kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TEXT">Texto</SelectItem>
                <SelectItem value="LIST">Lista interativa</SelectItem>
                <SelectItem value="BUTTONS">Botões</SelectItem>
                <SelectItem value="POLL">Enquete</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Listas, botões e enquetes só funcionam pelo Evolution (não-Meta).
            </p>
          </div>

          {kindValue === 'TEXT' ? (
            <div className="space-y-1">
              <Label htmlFor="body">Corpo da mensagem</Label>
              <Textarea
                id="body"
                rows={6}
                placeholder="Olá {{1}}, sua cidade é {{2}}"
                {...form.register('body')}
              />
              {form.formState.errors.body && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.body.message}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="interactiveConfig">
                Configuração ({kindValue}) — JSON
              </Label>
              <Textarea
                id="interactiveConfig"
                rows={12}
                spellCheck={false}
                className="font-mono text-xs"
                value={configText}
                onChange={(e) => {
                  setConfigText(e.target.value);
                  if (configError) setConfigError(null);
                }}
              />
              {configError ? (
                <p className="text-xs text-destructive">{configError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Cole/edite o JSON conforme o exemplo. Use {'{{nome}}'} em
                  qualquer string para interpolação por contato.
                </p>
              )}
            </div>
          )}

          {/* Pedido do cliente (2026-08-25): um informativo em PT-BR, visível
              na tela (nada de tooltip/popover), explicando como {{1}}, {{2}}
              funcionam. */}
          <div className="rounded-md border border-sky-200 bg-sky-50 p-2.5 text-xs leading-relaxed text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
            <p className="font-medium">
              Como funcionam as variáveis {'{{1}}'}, {'{{2}}'}…
            </p>
            <p className="mt-0.5">
              Cada {'{{1}}'}, {'{{2}}'} (ou {'{{nome}}'}) é um espaço que será
              preenchido com um dado do contato na hora do envio —{' '}
              {'{{1}}'} é a primeira variável, {'{{2}}'} a segunda, e assim
              por diante. Qual dado cada uma usa é escolhido ao montar a
              campanha. Se faltar aquele dado para um contato, a mensagem sai
              com esse trecho em branco.
            </p>
          </div>

          <div className="text-xs text-muted-foreground">
            {detectedVariables.length > 0 ? (
              <>
                Variáveis detectadas:{' '}
                {detectedVariables.map((v) => `{{${v}}}`).join(', ')}
              </>
            ) : (
              <>Nenhuma variável detectada.</>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending
                ? 'Salvando...'
                : isEdit
                  ? 'Salvar alterações'
                  : 'Criar template'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
