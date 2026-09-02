// ZB — form "Novo template Zernio": o primeiro caminho do orgamind para criar um
// template COM BOTÕES na Meta.
//
// O editor de botões é o ponto do produto onde o operador escreve o rótulo de
// que TODA a coleta de consentimento depende. Como o Zernio não transporta
// payload de quick_reply, o clique só é reconhecido pelo RÓTULO — e um rótulo
// fora da lista fechada derruba o clique EM SILÊNCIO. Por isso:
//
//   - o rótulo de um botão de consentimento é um SELECT sobre a lista que o
//     backend reconhece (não texto livre). É impossível digitar um rótulo morto;
//   - a lista é BUSCADA (GET /templates/consent-buttons), nunca copiada;
//   - se a lista não carregar, o modo consentimento fica DESABILITADO — jamais
//     um fallback hardcoded, porque o fallback é a divergência;
//   - o que está em jogo é dito em português na tela, não escondido num tooltip.
import { useEffect, useMemo, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, ExternalLink, Plus, ShieldCheck, X } from 'lucide-react';
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
import { useConsentButtonChoices, useCreateZernioTemplate } from '../api';
import {
  ZERNIO_BUTTON_ROLE_LABEL,
  ZERNIO_BUTTON_TEXT_MAX,
  ZERNIO_MAX_QUICK_REPLIES,
  ZERNIO_MAX_URL_BUTTONS,
  ZERNIO_BODY_MAX,
  buildCreateZernioTemplate,
  detectZernioVariables,
  makeZernioTemplateFormSchema,
  optInPresetButtons,
  type ConsentButtonChoices,
  type ZernioButtonRole,
  type ZernioTemplateFormValues,
} from '../zernio-schemas';
import { useProviders } from '@/features/whatsapp/api';

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

const EMPTY_CHOICES: ConsentButtonChoices = { optIn: [], optOut: [] };

const BASE_DEFAULTS: ZernioTemplateFormValues = {
  channelId: '',
  name: '',
  language: 'pt_BR',
  category: 'MARKETING',
  body: '',
  samples: [],
  footer: '',
  buttons: [],
};

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

export function ZernioTemplateFormDialog({ open, onOpenChange }: Props) {
  const create = useCreateZernioTemplate();
  const consent = useConsentButtonChoices();
  const providers = useProviders();

  const zernioChannels =
    providers.data?.providers.find((p) => p.provider === 'ZERNIO')?.channels ?? [];

  // Sem a lista, o modo consentimento não abre. Nunca um fallback local: uma
  // lista local que diverge do backend é exatamente o bug que este form fecha.
  const choices = consent.data ?? EMPTY_CHOICES;
  const consentReady = consent.isSuccess && choices.optIn.length > 0;

  const schema = useMemo(() => makeZernioTemplateFormSchema(choices), [choices]);

  const form = useForm<ZernioTemplateFormValues>({
    resolver: zodResolver(schema),
    defaultValues: BASE_DEFAULTS,
  });

  const samplesArray = useFieldArray({ control: form.control, name: 'samples' });
  const buttonsArray = useFieldArray({ control: form.control, name: 'buttons' });

  const [serverError, setServerError] = useState<string | null>(null);

  const bodyValue = form.watch('body') ?? '';
  const categoryValue = form.watch('category');
  const channelValue = form.watch('channelId');
  const samplesValue = form.watch('samples') ?? [];
  const buttonsValue = form.watch('buttons') ?? [];

  // Só um canal Zernio? Não faça o operador escolher o óbvio.
  useEffect(() => {
    if (!channelValue && zernioChannels.length === 1) {
      form.setValue('channelId', zernioChannels[0]!.id);
    }
  }, [channelValue, zernioChannels, form]);

  // Amostras seguem as variáveis do body, preservando o que já foi digitado.
  const detected = detectZernioVariables(bodyValue);
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

  const quickReplyCount = buttonsValue.filter(
    (b) => b.type === 'QUICK_REPLY',
  ).length;
  const urlCount = buttonsValue.filter((b) => b.type === 'URL').length;
  const hasOptIn = buttonsValue.some(
    (b) => b.type === 'QUICK_REPLY' && b.role === 'OPT_IN',
  );

  /** O caminho feliz da campanha de reapresentação: um clique, sem montagem manual. */
  function seedOptInPreset() {
    buttonsArray.replace(optInPresetButtons(choices));
    form.clearErrors('buttons');
  }

  /**
   * Trocar o PAPEL reescreve o rótulo para um valor reconhecido daquele papel —
   * assim é impossível ficar com um "Ver mais" marcado como opt-in.
   */
  function handleRoleChange(index: number, role: ZernioButtonRole) {
    form.setValue(`buttons.${index}.role`, role);
    if (role === 'OPT_IN') form.setValue(`buttons.${index}.text`, choices.optIn[0] ?? '');
    if (role === 'OPT_OUT')
      form.setValue(`buttons.${index}.text`, choices.optOut[0] ?? '');
    if (role === 'NONE') form.setValue(`buttons.${index}.text`, '');
    form.clearErrors(`buttons.${index}.text`);
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await create.mutateAsync(buildCreateZernioTemplate(values));
      toast.success('Template criado na Meta — aguardando aprovação (até 24h)');
      form.reset(BASE_DEFAULTS);
      onOpenChange(false);
    } catch (err) {
      const apiErr = await extractApiError(err);
      if (apiErr.code === 'template.meta_name_conflict') {
        form.setError('name', {
          message: 'Já existe um template com esse nome neste canal.',
        });
      }
      setServerError(apiErr.message);
      toast.error(apiErr.title, { description: apiErr.message });
    }
  });

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Novo template Zernio</DialogTitle>
          <DialogDescription>
            O template é criado de verdade na Meta e nasce PENDENTE — a aprovação
            leva até 24h, e um template já submetido não pode ser corrigido, só
            recriado.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
          <form onSubmit={onSubmit} className="space-y-3" noValidate>
            <div className="space-y-1">
              <Label htmlFor="zernio-channel">Canal (conta WhatsApp)</Label>
              <Select
                value={channelValue}
                onValueChange={(v) => form.setValue('channelId', v)}
              >
                <SelectTrigger id="zernio-channel" className="w-full">
                  <SelectValue placeholder="Escolha o canal" />
                </SelectTrigger>
                <SelectContent>
                  {zernioChannels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                O catálogo de templates é por conta WhatsApp — o template nasce
                dentro desta.
              </p>
              <FieldError message={errors.channelId?.message} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="zernio-name">Nome</Label>
              <Input
                id="zernio-name"
                autoComplete="off"
                placeholder="reapresentacao_optin"
                {...form.register('name', {
                  onChange: (e) => {
                    e.target.value = e.target.value.toLowerCase();
                  },
                })}
              />
              <p className="text-xs text-muted-foreground">
                Minúsculas, números e _ , começando por letra.
              </p>
              <FieldError message={errors.name?.message} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="zernio-language">Idioma</Label>
                <Input
                  id="zernio-language"
                  autoComplete="off"
                  placeholder="pt_BR"
                  {...form.register('language')}
                />
                <FieldError message={errors.language?.message} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="zernio-category">Categoria</Label>
                <Select
                  value={categoryValue}
                  onValueChange={(v) =>
                    form.setValue(
                      'category',
                      v as ZernioTemplateFormValues['category'],
                    )
                  }
                >
                  <SelectTrigger id="zernio-category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  {/* Sem AUTHENTICATION: na Meta ele tem forma RÍGIDA (corpo
                      fixo + botão de código, sem quick reply arbitrária) e este
                      form só monta BODY/FOOTER/BUTTONS — submeter seria uma
                      rejeição certa, e mais uma rejeição no histórico da conta. */}
                  <SelectContent>
                    <SelectItem value="MARKETING">MARKETING</SelectItem>
                    <SelectItem value="UTILITY">UTILITY</SelectItem>
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
              <div className="flex items-center justify-between">
                <Label htmlFor="zernio-body">Corpo da mensagem</Label>
                <CharCounter length={bodyValue.length} max={ZERNIO_BODY_MAX} />
              </div>
              <Textarea
                id="zernio-body"
                rows={5}
                placeholder="Olá {{1}}! Podemos continuar te enviando novidades da campanha?"
                {...form.register('body')}
              />
              <p className="text-xs text-muted-foreground">
                Use {'{{1}}'}, {'{{2}}'}, … — a Meta só aceita variáveis
                numeradas, e exige uma amostra de cada uma.
              </p>
              <FieldError message={errors.body?.message} />
            </div>

            {samplesArray.fields.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium">
                  Amostras das variáveis (obrigatórias — sem elas a Meta rejeita)
                </p>
                {samplesArray.fields.map((field, index) => (
                  <div key={field.id} className="space-y-1">
                    <Label htmlFor={`zernio-sample-${index}`}>
                      {`Amostra {{${field.variable}}}`}
                    </Label>
                    <Input
                      id={`zernio-sample-${index}`}
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

            <div className="space-y-1">
              <Label htmlFor="zernio-footer">Rodapé (opcional)</Label>
              <Input
                id="zernio-footer"
                autoComplete="off"
                placeholder="Toque num botão para responder"
                {...form.register('footer')}
              />
              <FieldError message={errors.footer?.message} />
            </div>

            {/* ── EDITOR DE BOTÕES ─────────────────────────────────────────── */}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-medium">Botões</p>
                  <p className="text-[11px] text-muted-foreground">
                    Até {ZERNIO_MAX_QUICK_REPLIES} respostas rápidas OU até{' '}
                    {ZERNIO_MAX_URL_BUTTONS} links — não dá para misturar.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!consentReady}
                  onClick={seedOptInPreset}
                >
                  <ShieldCheck /> Preset de opt-in
                </Button>
              </div>

              {/* O QUE ESTÁ EM JOGO, em português, na tela do operador. */}
              <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>
                  O WhatsApp não devolve um identificador do botão — o sistema só
                  reconhece o clique pelo <strong>rótulo</strong>. Um botão de
                  opt-in com rótulo não reconhecido faz o clique da pessoa{' '}
                  <strong>ir para o lixo</strong>: ela acha que aceitou, e nenhum
                  consentimento é gravado. Por isso o rótulo dos botões de
                  consentimento é escolhido de uma lista, não digitado.
                </p>
              </div>

              {!consentReady && consent.isError && (
                <p className="text-xs text-destructive">
                  Não foi possível carregar a lista de rótulos reconhecidos — os
                  botões de consentimento ficam desabilitados. (Preferimos
                  bloquear a arriscar um rótulo que não grava o aceite.)
                </p>
              )}

              {buttonsArray.fields.map((field, index) => {
                const button = buttonsValue[index];
                const role = button?.role ?? 'NONE';
                const isConsent = role !== 'NONE';
                const isUrl = button?.type === 'URL';
                const buttonErrors = errors.buttons?.[index];
                return (
                  <div key={field.id} className="space-y-1 rounded-md border p-2.5">
                    <div className="flex items-start gap-1">
                      <div className="flex-1 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label htmlFor={`zernio-btn-type-${index}`}>
                              {`Tipo do botão ${index + 1}`}
                            </Label>
                            <Select
                              value={button?.type ?? 'QUICK_REPLY'}
                              onValueChange={(v) => {
                                form.setValue(
                                  `buttons.${index}.type`,
                                  v as 'QUICK_REPLY' | 'URL',
                                );
                                // Um botão de URL nunca é de consentimento: o
                                // clique num link não volta como mensagem.
                                if (v === 'URL')
                                  form.setValue(`buttons.${index}.role`, 'NONE');
                              }}
                            >
                              <SelectTrigger
                                id={`zernio-btn-type-${index}`}
                                className="w-full"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="QUICK_REPLY">
                                  Resposta rápida
                                </SelectItem>
                                <SelectItem value="URL">Link (URL)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          {!isUrl && (
                            <div className="space-y-1">
                              <Label htmlFor={`zernio-btn-role-${index}`}>
                                Papel
                              </Label>
                              <Select
                                value={role}
                                onValueChange={(v) =>
                                  handleRoleChange(index, v as ZernioButtonRole)
                                }
                              >
                                <SelectTrigger
                                  id={`zernio-btn-role-${index}`}
                                  className="w-full"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="NONE">
                                    {ZERNIO_BUTTON_ROLE_LABEL.NONE}
                                  </SelectItem>
                                  <SelectItem
                                    value="OPT_IN"
                                    disabled={!consentReady}
                                  >
                                    {ZERNIO_BUTTON_ROLE_LABEL.OPT_IN}
                                  </SelectItem>
                                  <SelectItem
                                    value="OPT_OUT"
                                    disabled={!consentReady}
                                  >
                                    {ZERNIO_BUTTON_ROLE_LABEL.OPT_OUT}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                        </div>

                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <Label htmlFor={`zernio-btn-text-${index}`}>
                              Rótulo
                            </Label>
                            {!isConsent && (
                              <CharCounter
                                length={button?.text.length ?? 0}
                                max={ZERNIO_BUTTON_TEXT_MAX}
                              />
                            )}
                          </div>
                          {isConsent ? (
                            // SELECT, não Input: é fisicamente impossível
                            // escrever aqui um rótulo que o sistema não reconhece.
                            <Select
                              value={button?.text ?? ''}
                              onValueChange={(v) =>
                                form.setValue(`buttons.${index}.text`, v, {
                                  shouldValidate: true,
                                })
                              }
                            >
                              <SelectTrigger
                                id={`zernio-btn-text-${index}`}
                                className="w-full"
                              >
                                <SelectValue placeholder="Escolha um rótulo reconhecido" />
                              </SelectTrigger>
                              <SelectContent>
                                {(role === 'OPT_IN'
                                  ? choices.optIn
                                  : choices.optOut
                                ).map((label) => (
                                  <SelectItem key={label} value={label}>
                                    {label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              id={`zernio-btn-text-${index}`}
                              autoComplete="off"
                              placeholder="Ver proposta"
                              {...form.register(`buttons.${index}.text`)}
                            />
                          )}
                          {isConsent && (
                            <p className="flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                              <ShieldCheck className="size-3.5" />
                              {role === 'OPT_IN'
                                ? 'Rótulo reconhecido: o clique GRAVA o consentimento.'
                                : 'Rótulo reconhecido: o clique silencia o contato.'}
                            </p>
                          )}
                          <FieldError message={buttonErrors?.text?.message} />
                        </div>

                        {isUrl && (
                          <div className="space-y-1">
                            <Label htmlFor={`zernio-btn-url-${index}`}>URL</Label>
                            <Input
                              id={`zernio-btn-url-${index}`}
                              autoComplete="off"
                              placeholder="https://exemplo.com.br/proposta"
                              {...form.register(`buttons.${index}.url`)}
                            />
                            <FieldError message={buttonErrors?.url?.message} />
                          </div>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remover botão ${index + 1}`}
                        onClick={() => buttonsArray.remove(index)}
                      >
                        <X />
                      </Button>
                    </div>
                  </div>
                );
              })}

              <FieldError message={errors.buttons?.root?.message} />
              <FieldError message={errors.buttons?.message} />

              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    urlCount > 0 || quickReplyCount >= ZERNIO_MAX_QUICK_REPLIES
                  }
                  onClick={() =>
                    buttonsArray.append({
                      type: 'QUICK_REPLY',
                      role: 'NONE',
                      text: '',
                      url: '',
                    })
                  }
                >
                  <Plus /> Resposta rápida
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={quickReplyCount > 0 || urlCount >= ZERNIO_MAX_URL_BUTTONS}
                  onClick={() =>
                    buttonsArray.append({
                      type: 'URL',
                      role: 'NONE',
                      text: '',
                      url: '',
                    })
                  }
                >
                  <ExternalLink /> Link
                </Button>
              </div>

              {hasOptIn && (
                <p className="text-[11px] text-muted-foreground">
                  Template de opt-in: o clique no botão de aceite vira um
                  consentimento DOCUMENTADO no livro-razão. O botão de recusa é
                  obrigatório — sem a saída, o aceite não é livre.
                </p>
              )}
            </div>

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
                disabled={create.isPending}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Criando...' : 'Criar na Meta'}
              </Button>
            </DialogFooter>
          </form>

          {/* Preview estilo WhatsApp */}
          <aside className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Preview</p>
            <div
              data-testid="zernio-preview"
              className="rounded-lg bg-[#efe7dd] p-3 dark:bg-[#0b141a]"
            >
              <div className="max-w-full rounded-lg rounded-tl-none bg-[#d9fdd3] px-2.5 py-1.5 text-sm text-neutral-900 shadow-sm dark:bg-[#005c4b] dark:text-neutral-50">
                <p className="whitespace-pre-wrap break-words">
                  {renderPreview(bodyValue, samplesValue) || (
                    <span className="opacity-50">Corpo da mensagem…</span>
                  )}
                </p>
                {form.watch('footer') && (
                  <p className="mt-1 text-[11px] opacity-60">
                    {form.watch('footer')}
                  </p>
                )}
              </div>
              {buttonsValue.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {buttonsValue.map((b, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-white py-1.5 text-sm font-medium text-sky-600 shadow-sm dark:bg-[#1f2c33] dark:text-sky-400"
                    >
                      {b.type === 'URL' && <ExternalLink className="size-3.5" />}
                      <span className="truncate">
                        {b.text || <span className="opacity-50">Botão…</span>}
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

/** Substitui {{n}} pelas amostras, para o preview. */
function renderPreview(
  body: string,
  samples: Array<{ variable: string; value: string }>,
): string {
  let out = body;
  for (const s of samples) {
    if (!s.value) continue;
    out = out.replaceAll(`{{${s.variable}}}`, s.value);
  }
  return out;
}
