// twilio-platform T5 — form "Novo template Twilio" (Content API).
//
// Cria um RASCUNHO na Twilio (POST /templates/twilio) ou edita um rascunho
// existente (PATCH /templates/:id/twilio-draft — nome e idioma imutáveis).
// A validação inline espelha as mensagens PT-BR agregadas do backend via
// twilioTemplateFormSchema; o preview ao lado desenha o balão WhatsApp com as
// variáveis substituídas pelas amostras e os botões do tipo escolhido.
import { useEffect, useRef, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ExternalLink, ImageIcon, Phone, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
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
import { extractApiError } from '@/lib/api-error';
import { useCreateTwilioTemplate, useUpdateTwilioDraft } from '../api';
import {
  CTA_MAX_PHONE_ACTIONS,
  CTA_MAX_URL_ACTIONS,
  CTA_TITLE_MAX,
  QUICK_REPLY_ID_MAX,
  QUICK_REPLY_MAX_ACTIONS,
  QUICK_REPLY_TITLE_MAX,
  TWILIO_BODY_LIMITS,
  TWILIO_CONTENT_TYPES,
  TWILIO_CONTENT_TYPE_LABEL,
  buildCreateTwilioTemplate,
  deriveQuickReplyId,
  detectTwilioVariables,
  renderTwilioPreviewBody,
  twilioTemplateFormSchema,
  type TwilioContentType,
  type TwilioTemplateFormValues,
} from '../twilio-schemas';

type Mode =
  | {
      /** Novo rascunho; `initialValues` pré-preenche (fluxo clonar-e-corrigir). */
      mode: 'create';
      initialValues?: Partial<TwilioTemplateFormValues>;
    }
  | {
      /** Edita um rascunho existente — nome e idioma ficam desabilitados. */
      mode: 'editDraft';
      templateId: string;
      initialValues: TwilioTemplateFormValues;
    };

type TwilioTemplateFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Mode;

const BASE_DEFAULTS: TwilioTemplateFormValues = {
  name: '',
  language: 'pt_BR',
  category: 'UTILITY',
  contentType: 'twilio/text',
  body: '',
  samples: [],
  media: [],
  quickReplies: [],
  ctaUrls: [],
  ctaPhones: [],
};

/** Contador `usado/limite` — vermelho quando estoura. */
function CharCounter({ length, max }: { length: number; max: number }) {
  return (
    <span
      className={
        length > max
          ? 'text-[11px] tabular-nums text-destructive'
          : 'text-[11px] tabular-nums text-muted-foreground'
      }
    >
      {length}/{max}
    </span>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

export function TwilioTemplateFormDialog(props: TwilioTemplateFormDialogProps) {
  const { open, onOpenChange } = props;
  const isEditDraft = props.mode === 'editDraft';

  const create = useCreateTwilioTemplate();
  const updateDraft = useUpdateTwilioDraft();

  const form = useForm<TwilioTemplateFormValues>({
    resolver: zodResolver(twilioTemplateFormSchema),
    defaultValues: { ...BASE_DEFAULTS, ...props.initialValues },
  });

  const samplesArray = useFieldArray({ control: form.control, name: 'samples' });
  const mediaArray = useFieldArray({ control: form.control, name: 'media' });
  const quickRepliesArray = useFieldArray({
    control: form.control,
    name: 'quickReplies',
  });
  const ctaUrlsArray = useFieldArray({ control: form.control, name: 'ctaUrls' });
  const ctaPhonesArray = useFieldArray({
    control: form.control,
    name: 'ctaPhones',
  });

  // Payloads de quick-reply editados manualmente (por field id do RHF) — só os
  // NÃO editados continuam sendo derivados do título.
  const manualIds = useRef<Set<string>>(new Set());

  // Erro agregado do backend (DomainError PT-BR) exibido inline no dialog.
  const [serverError, setServerError] = useState<string | null>(null);

  const contentType = form.watch('contentType');
  const bodyValue = form.watch('body') ?? '';
  const categoryValue = form.watch('category');
  const samplesValue = form.watch('samples') ?? [];
  const quickRepliesValue = form.watch('quickReplies') ?? [];
  const ctaUrlsValue = form.watch('ctaUrls') ?? [];
  const ctaPhonesValue = form.watch('ctaPhones') ?? [];
  const mediaValue = form.watch('media') ?? [];

  const bodyLimit = TWILIO_BODY_LIMITS[contentType];

  // Amostras seguem as variáveis detectadas no body (e nas URLs de CTA),
  // preservando valores já digitados. `detectedKey` estabiliza a dependência.
  const detected = detectTwilioVariables(
    bodyValue,
    contentType === 'twilio/call-to-action'
      ? ctaUrlsValue.map((a) => a?.url ?? '')
      : [],
  );
  const detectedKey = detected.join(',');
  const replaceSamples = samplesArray.replace;
  useEffect(() => {
    const vars = detectedKey ? detectedKey.split(',') : [];
    const current = form.getValues('samples') ?? [];
    if (
      current.length === vars.length &&
      current.every((s, i) => s.variable === vars[i])
    ) {
      return;
    }
    const byVariable = new Map(current.map((s) => [s.variable, s.value]));
    replaceSamples(
      vars.map((v) => ({ variable: v, value: byVariable.get(v) ?? '' })),
    );
  }, [detectedKey, form, replaceSamples]);

  /** Troca de tipo semeia a primeira row da coleção correspondente. */
  function handleContentTypeChange(next: TwilioContentType) {
    form.setValue('contentType', next);
    form.clearErrors();
    if (next === 'twilio/media' && mediaArray.fields.length === 0) {
      mediaArray.append({ url: '' });
    }
    if (next === 'twilio/quick-reply' && quickRepliesArray.fields.length === 0) {
      quickRepliesArray.append({ title: '', id: '' });
    }
    if (
      next === 'twilio/call-to-action' &&
      ctaUrlsArray.fields.length === 0 &&
      ctaPhonesArray.fields.length === 0
    ) {
      ctaUrlsArray.append({ title: '', url: '' });
    }
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    const payload = buildCreateTwilioTemplate(values);
    try {
      if (props.mode === 'editDraft') {
        // O PATCH twilio-draft não aceita `name` (imutável) — remove do
        // payload de criação em vez de duplicar o builder.
        const draft: Partial<typeof payload> = { ...payload };
        delete draft.name;
        await updateDraft.mutateAsync({
          id: props.templateId,
          input: draft as Omit<typeof payload, 'name'>,
        });
        toast.success('Rascunho atualizado na Twilio');
      } else {
        await create.mutateAsync(payload);
        toast.success('Rascunho criado na Twilio');
      }
      onOpenChange(false);
    } catch (err) {
      const apiErr = await extractApiError(err);
      if (apiErr.code === 'template.meta_name_conflict') {
        form.setError('name', {
          message: 'Já existe um template com esse nome.',
        });
      }
      // DomainError PT-BR (ex.: template.twilio_invalid agrega TODOS os
      // problemas) — inline no dialog, além do toast.
      setServerError(apiErr.message);
      toast.error(apiErr.title, { description: apiErr.message });
    }
  });

  const isPending = create.isPending || updateDraft.isPending;
  const errors = form.formState.errors;

  const previewBody = renderTwilioPreviewBody(bodyValue, samplesValue);
  const previewButtons: Array<{ icon: 'reply' | 'link' | 'phone'; title: string }> =
    contentType === 'twilio/quick-reply'
      ? quickRepliesValue.map((a) => ({ icon: 'reply' as const, title: a.title }))
      : contentType === 'twilio/call-to-action'
        ? [
            ...ctaUrlsValue.map((a) => ({ icon: 'link' as const, title: a.title })),
            ...ctaPhonesValue.map((a) => ({
              icon: 'phone' as const,
              title: a.title,
            })),
          ]
        : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {isEditDraft ? 'Editar rascunho Twilio' : 'Novo template Twilio'}
          </DialogTitle>
          <DialogDescription>
            O template é criado como rascunho na Twilio — a submissão à
            aprovação da Meta é um passo separado, na lista.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
          <form onSubmit={onSubmit} className="space-y-3" noValidate>
            <div className="space-y-1">
              <Label htmlFor="twilio-name">Nome</Label>
              <Input
                id="twilio-name"
                autoComplete="off"
                disabled={isEditDraft}
                placeholder="convite_apoiadores"
                {...form.register('name', {
                  onChange: (e) => {
                    // Nome de aprovação é minúsculo — normaliza ao digitar.
                    e.target.value = e.target.value.toLowerCase();
                  },
                })}
              />
              <p className="text-xs text-muted-foreground">
                Somente minúsculas, números e _ — é o nome enviado à aprovação
                da Meta{isEditDraft ? ' (imutável em rascunhos)' : ''}.
              </p>
              <FieldError message={errors.name?.message} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="twilio-language">Idioma</Label>
                <Input
                  id="twilio-language"
                  autoComplete="off"
                  disabled={isEditDraft}
                  placeholder="pt_BR"
                  {...form.register('language')}
                />
                <FieldError message={errors.language?.message} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="twilio-category">Categoria</Label>
                <Select
                  value={categoryValue}
                  onValueChange={(v) =>
                    form.setValue(
                      'category',
                      v as TwilioTemplateFormValues['category'],
                    )
                  }
                >
                  <SelectTrigger id="twilio-category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UTILITY">UTILITY</SelectItem>
                    <SelectItem value="MARKETING">MARKETING</SelectItem>
                    <SelectItem value="AUTHENTICATION">
                      AUTHENTICATION
                    </SelectItem>
                  </SelectContent>
                </Select>
                {categoryValue === 'MARKETING' && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Marketing custa ~8x mais que Utility por conversa.
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="twilio-content-type">Tipo</Label>
              <Select
                value={contentType}
                onValueChange={(v) =>
                  handleContentTypeChange(v as TwilioContentType)
                }
              >
                <SelectTrigger id="twilio-content-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TWILIO_CONTENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TWILIO_CONTENT_TYPE_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="twilio-body">Corpo da mensagem</Label>
                <CharCounter length={bodyValue.length} max={bodyLimit} />
              </div>
              <Textarea
                id="twilio-body"
                rows={5}
                placeholder="Olá {{1}}, sua entrega chega em {{2}}."
                {...form.register('body')}
              />
              <p className="text-xs text-muted-foreground">
                Use {'{{1}}'}, {'{{2}}'}, … — sequenciais, sem começar nem
                terminar a mensagem.
              </p>
              <FieldError message={errors.body?.message} />
            </div>

            {samplesArray.fields.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium">
                  Amostras das variáveis (obrigatórias para aprovação)
                </p>
                {samplesArray.fields.map((field, index) => (
                  <div key={field.id} className="space-y-1">
                    <Label htmlFor={`twilio-sample-${index}`}>
                      {`Amostra {{${field.variable}}}`}
                    </Label>
                    <Input
                      id={`twilio-sample-${index}`}
                      autoComplete="off"
                      placeholder="ex.: João"
                      {...form.register(`samples.${index}.value`)}
                    />
                    <FieldError
                      message={errors.samples?.[index]?.value?.message}
                    />
                  </div>
                ))}
              </div>
            )}

            {contentType === 'twilio/media' && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium">Mídia (URLs públicas https)</p>
                {mediaArray.fields.map((field, index) => (
                  <div key={field.id} className="space-y-1">
                    <div className="flex gap-1">
                      <Input
                        aria-label={`URL da mídia ${index + 1}`}
                        autoComplete="off"
                        placeholder="https://exemplo.com/imagem.png"
                        {...form.register(`media.${index}.url`)}
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remover mídia ${index + 1}`}
                        disabled={mediaArray.fields.length <= 1}
                        onClick={() => mediaArray.remove(index)}
                      >
                        <X />
                      </Button>
                    </div>
                    <FieldError message={errors.media?.[index]?.url?.message} />
                  </div>
                ))}
                <FieldError message={errors.media?.root?.message} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => mediaArray.append({ url: '' })}
                >
                  <Plus /> Adicionar mídia
                </Button>
              </div>
            )}

            {contentType === 'twilio/quick-reply' && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium">
                  Botões de resposta rápida (1 a {QUICK_REPLY_MAX_ACTIONS})
                </p>
                {quickRepliesArray.fields.map((field, index) => (
                  <div key={field.id} className="space-y-1">
                    <div className="flex items-start gap-1">
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center justify-between">
                          <Label htmlFor={`twilio-qr-title-${index}`}>
                            {`Título do botão ${index + 1}`}
                          </Label>
                          <CharCounter
                            length={quickRepliesValue[index]?.title.length ?? 0}
                            max={QUICK_REPLY_TITLE_MAX}
                          />
                        </div>
                        <Input
                          id={`twilio-qr-title-${index}`}
                          autoComplete="off"
                          placeholder="Sim, pode"
                          {...form.register(`quickReplies.${index}.title`, {
                            onChange: (e) => {
                              // Deriva o payload do título até ser editado
                              // manualmente (chave = field id estável do RHF).
                              if (!manualIds.current.has(field.id)) {
                                form.setValue(
                                  `quickReplies.${index}.id`,
                                  deriveQuickReplyId(e.target.value),
                                );
                              }
                            },
                          })}
                        />
                        <FieldError
                          message={errors.quickReplies?.[index]?.title?.message}
                        />
                        <Label
                          htmlFor={`twilio-qr-id-${index}`}
                          className="text-muted-foreground"
                        >
                          {`Payload do botão ${index + 1}`}
                        </Label>
                        <Input
                          id={`twilio-qr-id-${index}`}
                          autoComplete="off"
                          className="font-mono text-xs"
                          {...form.register(`quickReplies.${index}.id`, {
                            onChange: () => manualIds.current.add(field.id),
                          })}
                        />
                        <p className="text-[11px] text-muted-foreground">
                          Volta no webhook como ButtonPayload (≤
                          {QUICK_REPLY_ID_MAX} caracteres).
                        </p>
                        <FieldError
                          message={errors.quickReplies?.[index]?.id?.message}
                        />
                      </div>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remover botão ${index + 1}`}
                        disabled={quickRepliesArray.fields.length <= 1}
                        onClick={() => quickRepliesArray.remove(index)}
                      >
                        <X />
                      </Button>
                    </div>
                  </div>
                ))}
                <FieldError message={errors.quickReplies?.root?.message} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    quickRepliesArray.fields.length >= QUICK_REPLY_MAX_ACTIONS
                  }
                  onClick={() => quickRepliesArray.append({ title: '', id: '' })}
                >
                  <Plus /> Adicionar botão
                </Button>
              </div>
            )}

            {contentType === 'twilio/call-to-action' && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium">
                  Ações (até {CTA_MAX_URL_ACTIONS} links +{' '}
                  {CTA_MAX_PHONE_ACTIONS} telefone)
                </p>
                {ctaUrlsArray.fields.map((field, index) => (
                  <div key={field.id} className="space-y-1">
                    <div className="flex items-start gap-1">
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center justify-between">
                          <Label htmlFor={`twilio-cta-url-title-${index}`}>
                            {`Título do link ${index + 1}`}
                          </Label>
                          <CharCounter
                            length={ctaUrlsValue[index]?.title.length ?? 0}
                            max={CTA_TITLE_MAX}
                          />
                        </div>
                        <Input
                          id={`twilio-cta-url-title-${index}`}
                          autoComplete="off"
                          placeholder="Abrir site"
                          {...form.register(`ctaUrls.${index}.title`)}
                        />
                        <FieldError
                          message={errors.ctaUrls?.[index]?.title?.message}
                        />
                        <Label htmlFor={`twilio-cta-url-${index}`}>
                          {`URL do link ${index + 1}`}
                        </Label>
                        <Input
                          id={`twilio-cta-url-${index}`}
                          autoComplete="off"
                          placeholder="https://exemplo.com/{{1}}"
                          {...form.register(`ctaUrls.${index}.url`)}
                        />
                        <FieldError
                          message={errors.ctaUrls?.[index]?.url?.message}
                        />
                      </div>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remover link ${index + 1}`}
                        onClick={() => ctaUrlsArray.remove(index)}
                      >
                        <X />
                      </Button>
                    </div>
                  </div>
                ))}
                <FieldError message={errors.ctaUrls?.root?.message} />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={ctaUrlsArray.fields.length >= CTA_MAX_URL_ACTIONS}
                    onClick={() => ctaUrlsArray.append({ title: '', url: '' })}
                  >
                    <Plus /> Adicionar link
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      ctaPhonesArray.fields.length >= CTA_MAX_PHONE_ACTIONS
                    }
                    onClick={() =>
                      ctaPhonesArray.append({ title: '', phone: '' })
                    }
                  >
                    <Plus /> Adicionar telefone
                  </Button>
                </div>
                {ctaPhonesArray.fields.map((field, index) => (
                  <div key={field.id} className="space-y-1">
                    <div className="flex items-start gap-1">
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center justify-between">
                          <Label htmlFor={`twilio-cta-phone-title-${index}`}>
                            Título do telefone
                          </Label>
                          <CharCounter
                            length={ctaPhonesValue[index]?.title.length ?? 0}
                            max={CTA_TITLE_MAX}
                          />
                        </div>
                        <Input
                          id={`twilio-cta-phone-title-${index}`}
                          autoComplete="off"
                          placeholder="Ligar"
                          {...form.register(`ctaPhones.${index}.title`)}
                        />
                        <FieldError
                          message={errors.ctaPhones?.[index]?.title?.message}
                        />
                        <Label htmlFor={`twilio-cta-phone-${index}`}>
                          Telefone (E.164)
                        </Label>
                        <Input
                          id={`twilio-cta-phone-${index}`}
                          autoComplete="off"
                          placeholder="+5592999999999"
                          {...form.register(`ctaPhones.${index}.phone`)}
                        />
                        <FieldError
                          message={errors.ctaPhones?.[index]?.phone?.message}
                        />
                      </div>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Remover telefone"
                        onClick={() => ctaPhonesArray.remove(index)}
                      >
                        <X />
                      </Button>
                    </div>
                  </div>
                ))}
                <FieldError message={errors.ctaPhones?.root?.message} />
              </div>
            )}

            {serverError && (
              <div
                role="alert"
                className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
              >
                {serverError}
              </div>
            )}

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
                  : isEditDraft
                    ? 'Salvar rascunho'
                    : 'Criar rascunho'}
              </Button>
            </DialogFooter>
          </form>

          {/* Preview estilo WhatsApp — balão verde-claro + botões desenhados */}
          <aside className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Preview</p>
            <div
              data-testid="twilio-preview"
              className="rounded-lg bg-[#efe7dd] p-3 dark:bg-[#0b141a]"
            >
              <div className="max-w-full rounded-lg rounded-tl-none bg-[#d9fdd3] px-2.5 py-1.5 text-sm text-neutral-900 shadow-sm dark:bg-[#005c4b] dark:text-neutral-50">
                {contentType === 'twilio/media' && (
                  <div className="mb-1.5 flex h-20 items-center justify-center rounded-md bg-black/10 dark:bg-white/10">
                    <ImageIcon
                      className="size-6 opacity-50"
                      aria-label="Mídia"
                    />
                  </div>
                )}
                <p className="whitespace-pre-wrap break-words">
                  {previewBody || (
                    <span className="opacity-50">Corpo da mensagem…</span>
                  )}
                </p>
                {mediaValue.length > 0 &&
                  contentType === 'twilio/media' &&
                  mediaValue[0]?.url && (
                    <p className="mt-1 truncate text-[10px] opacity-60">
                      {mediaValue[0].url}
                    </p>
                  )}
              </div>
              {previewButtons.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {previewButtons.map((b, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-white py-1.5 text-sm font-medium text-sky-600 shadow-sm dark:bg-[#1f2c33] dark:text-sky-400"
                    >
                      {b.icon === 'link' && <ExternalLink className="size-3.5" />}
                      {b.icon === 'phone' && <Phone className="size-3.5" />}
                      <span className="truncate">
                        {b.title || <span className="opacity-50">Botão…</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
