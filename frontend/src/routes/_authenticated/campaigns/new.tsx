import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { ShieldOff, Sliders } from 'lucide-react';
import { useProviders, type ChannelSummary } from '@/features/whatsapp/api';
import { ProviderBadge, useProviderScope } from '@/features/whatsapp/provider-scope';
import { useConsentPurposes, type ConsentPurpose } from '@/features/consent/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FilterBuilder } from '@/features/campaigns/components/filter-builder';
import {
  FacetFilters,
  type FacetSelection,
} from '@/features/campaigns/components/facet-filters';
import { LivePreview } from '@/features/campaigns/components/live-preview';
import { ActiveFilterChips } from '@/features/campaigns/components/active-filter-chips';
import { HistoryExclusionBlock } from '@/features/campaigns/components/history-exclusion-block';
import {
  ExtraContactsPicker,
  type ExtraContact,
} from '@/features/campaigns/components/extra-contacts-picker';
import { facetsToFilterGroup } from '@/features/campaigns/facets-to-filters';
import { materializeHistoryExclusion } from '@/features/campaigns/history-exclusion';
import { materializeExtraContacts } from '@/features/campaigns/extra-contacts';
import { SchedulePicker } from '@/features/campaigns/components/schedule-picker';
import { SaveAsSegmentDialog } from '@/features/campaigns/components/save-as-segment-dialog';
import { SendAnalysisPanel } from '@/features/campaigns/components/send-analysis-panel';
import { SameTemplateExclusionNotice } from '@/features/campaigns/components/same-template-exclusion-notice';
import { SegmentPicker } from '@/features/segments/components/segment-picker';
import { useSegment } from '@/features/segments/api';
import { useTemplates } from '@/features/templates/api';
import {
  useCreateCampaign,
  useSendFirstBatch,
  usePreviewCampaign,
  usePreflightCampaignChecks,
} from '@/features/campaigns/api';
import {
  hasBlockingCheck,
  TIMEZONE_DEFAULT,
  type FilterGroup,
  type VariableMap,
  type PreviewResult,
  type ScheduleConfig,
  type SendCheck,
  type ConsentSummary,
} from '@/features/campaigns/schemas';
import {
  hasExcludeInvalid,
  withExcludeInvalid,
  withoutExcludeInvalid,
} from '@/features/campaigns/exclude-invalid';
import {
  avisoDeQuota,
  capDeHoje,
  horaDoReset,
  quotaRestante,
  tamanhoInicialDoLote,
} from '@/features/campaigns/channel-quota';
import { resolveCampaignChannel } from '@/features/campaigns/resolve-channel';
import { extractApiError } from '@/lib/api-error';
import { toast } from 'sonner';

export const Route = createFileRoute('/_authenticated/campaigns/new')({
  component: NewCampaignPage,
});

const DRAFT_KEY = 'picoa:campaign-wizard-draft';
/** Mesmo teto de `sendCampaignBatchSchema` (backend) e do `<Input max=…>` do 1º lote. */
const MAX_BATCH_SIZE = 5000;

const CAMPAIGN_STEPS = [
  { label: 'Configurar', detail: 'Campanha e canal' },
  { label: 'Personalizar', detail: 'Dados dinâmicos' },
  { label: 'Público', detail: 'Destinatários' },
  { label: 'Revisar', detail: 'Agendamento e envio' },
] as const;

function renderCampaignProgress(step: number) {
  return (
    <nav aria-label="Progresso da campanha">
      <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-[var(--border)] sm:grid-cols-4">
        {CAMPAIGN_STEPS.map((item, index) => {
          const number = index + 1;
          const current = number === step;
          const complete = number < step;
          return (
            <li
              key={item.label}
              aria-current={current ? 'step' : undefined}
              className="flex items-center gap-2.5 bg-[var(--surface)] px-3 py-3"
            >
              <span
                className="grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold"
                style={{
                  background: current || complete ? 'var(--brand-navy)' : 'var(--surface-sunken)',
                  color: current || complete ? '#fff' : 'var(--foreground-muted)',
                  boxShadow: current ? 'inset 0 -2px 0 var(--brand-orange)' : undefined,
                }}
              >
                {number}
              </span>
              <span className="min-w-0">
                <span
                  className="block truncate text-xs font-semibold"
                  style={{ color: current ? 'var(--brand-primary)' : 'var(--foreground)' }}
                >
                  {item.label}
                </span>
                <span className="hidden truncate text-[11px] sm:block" style={{ color: 'var(--foreground-muted)' }}>
                  {item.detail}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function renderCampaignWizardHeader(step: number) {
  return (
    <>
      <header>
        <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.11em]" style={{ color: 'var(--brand-primary)' }}>
          Campanhas · nova campanha
        </p>
        <h1 className="text-2xl font-semibold tracking-tight" style={{ color: 'var(--brand-primary)' }}>
          Nova campanha — passo {step} de 4
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--foreground-muted)' }}>
          Configure o envio e revise a audiência antes de confirmar.
        </p>
      </header>
      {renderCampaignProgress(step)}
    </>
  );
}

/**
 * Pick a sensible default contact field for a template variable name —
 * "nome"/"name" → name, "cidade"/"city" → city, etc. Falls back to "name"
 * (the most common case for greeting templates) when no match.
 */
function guessFieldFor(varName: string): string {
  const v = varName.toLowerCase();
  if (/^(nome|name|cliente|contato|destinatario)/.test(v)) return 'name';
  if (/^(cidade|city|local)/.test(v)) return 'city';
  if (/^(grupo|group|categoria)/.test(v)) return 'group';
  if (/^(tel|phone|fone|whats)/.test(v)) return 'phoneE164';
  return 'name';
}

type WizardDraft = {
  step: number;
  name: string;
  templateId: string;
  defaultInstanceId: string;
  /** C1b — finalidade declarada da campanha (key de ConsentPurpose). */
  purposeKey?: string;
  variableMap: VariableMap;
  filters: FilterGroup;
  schedule?: ScheduleConfig;
  presenceDelayMs?: number;
  // A.1 — "Limitar aos primeiros N" saiu do wizard. Rascunhos antigos podem
  // carregar a chave; ela é simplesmente ignorada na leitura.
};

function loadDraft(): WizardDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WizardDraft;
  } catch {
    return null;
  }
}

function useWizardDraft() {
  // Read sessionStorage once on mount; subsequent renders use the cached
  // ref. Without this, loadDraft() ran on every render — wasteful, and
  // each useState initial value was being recomputed even though React
  // ignores it after the first render.
  const initialRef = useRef<WizardDraft | null>(null);
  if (initialRef.current === null) {
    initialRef.current = loadDraft() ?? ({} as WizardDraft);
  }
  const initial = initialRef.current;

  const [step, setStep] = useState<number>(() => initial.step ?? 1);
  const [name, setName] = useState<string>(() => initial.name ?? '');
  const [templateId, setTemplateId] = useState<string>(
    () => initial.templateId ?? '',
  );
  const [defaultInstanceId, setDefaultInstanceId] = useState<string>(
    () => initial.defaultInstanceId ?? '',
  );
  const [purposeKey, setPurposeKey] = useState<string>(
    () => initial.purposeKey ?? '',
  );
  const [variableMap, setVariableMap] = useState<VariableMap>(
    () => initial.variableMap ?? {},
  );
  const [filters, setFilters] = useState<FilterGroup>(() =>
    initialCampaignFilters(initial.filters),
  );
  const [schedule, setSchedule] = useState<ScheduleConfig>(
    () => initial.schedule ?? { type: 'IMMEDIATE' },
  );
  const [presenceDelayMs, setPresenceDelayMs] = useState<number>(
    () => initial.presenceDelayMs ?? 0,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // B.4 fix — "Excluir inválidos confirmados" nasce ligado (Task 16), então
    // `filters.rules` nunca é [] num assistente novo: o grupo de exclusão já
    // está lá. "Vazio" é definido contra o filtro PADRÃO, não contra zero
    // regras — senão um rascunho é gravado (e o aviso de "alterações não
    // salvas" arma) só por o operador ter aberto a tela. Desligar o toggle
    // também some com esse grupo, então continua contando como "intocado" —
    // é o mesmo estado, indistinguível de quem nunca mexeu em nada.
    const isEmpty =
      step === 1 &&
      !name &&
      !templateId &&
      Object.keys(variableMap).length === 0 &&
      withoutExcludeInvalid(filters).rules.length === 0;
    if (isEmpty) return;
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          step,
          name,
          templateId,
          defaultInstanceId,
          purposeKey,
          variableMap,
          filters,
          schedule,
          presenceDelayMs,
        }),
      );
    } catch {
      // ignore quota errors
    }
  }, [step, name, templateId, defaultInstanceId, purposeKey, variableMap, filters, schedule, presenceDelayMs]);

  const clearDraft = () => {
    if (typeof window === 'undefined') return;
    sessionStorage.removeItem(DRAFT_KEY);
  };

  return {
    step,
    setStep,
    name,
    setName,
    templateId,
    setTemplateId,
    defaultInstanceId,
    setDefaultInstanceId,
    purposeKey,
    setPurposeKey,
    variableMap,
    setVariableMap,
    filters,
    setFilters,
    schedule,
    setSchedule,
    presenceDelayMs,
    setPresenceDelayMs,
    clearDraft,
  };
}

type Template = NonNullable<ReturnType<typeof useTemplates>['data']>[number];

/**
 * Gate de campanha: só templates APPROVED podem ser escolhidos no wizard.
 * PENDING/REJECTED e PAUSED (Meta pausou/desabilitou — twilio-platform T2)
 * ficam de fora. Exported for the spec.
 */
export function selectableTemplates(
  templates: Template[] | undefined,
): Template[] {
  return templates?.filter((t) => t.status === 'APPROVED') ?? [];
}

/**
 * O texto que diz ao operador o que houve E onde consertar. Vive num só lugar
 * porque aparece em dois: no aviso abaixo do select e como motivo devolvido por
 * `templateBlockedReason`.
 */
const TEMPLATE_BUTTONS_BLOCKED =
  'Os botões deste template não podem ser usados numa campanha: o sistema não ' +
  'sabe o que o clique significa, e se um deles for o "sim" de um opt-in os ' +
  'aceites iriam para o lixo. Classifique os botões na página Templates.';

/**
 * ★ O GATE DOS BOTÕES, ANTECIPADO — de "400 no último clique" para "cinza na
 * lista".
 *
 * INCIDENTE 2026-08-11: o cliente tentou criar campanha 8× em 28 minutos e
 * levou `400 campaign.template_consent_buttons_unrecognized` todas as vezes.
 * O gate autoritativo (`assertTemplateConsentButtonsUsable`) roda SÓ no
 * `POST /campaigns`; `preview`, `preflight` e `preflight-checks` não olham o
 * template e devolvem 201, pintando o wizard inteiro de verde. Aqui o gate
 * NÃO é reimplementado: o veredito vem pronto do backend, dono do reconhecedor
 * (`consentButtons.problems`, de `GET /templates`), e este helper só o traduz
 * para a tela. Reimplementar a regra no frontend seria criar uma segunda
 * verdade que diverge silenciosamente da primeira.
 *
 * `null` = disparável. Só templates ZERNIO recebem `consentButtons` (lá o
 * clique chega como RÓTULO e o reconhecimento é lista fechada); nos demais o
 * campo é ausente/nulo e nada é bloqueado.
 */
export function templateBlockedReason(t: Template): string | null {
  const problems = t.consentButtons?.problems ?? [];
  return problems.length > 0 ? TEMPLATE_BUTTONS_BLOCKED : null;
}

/** A single selectable channel (multi-provider). */
type Channel = ChannelSummary;
/** One provider's channels, as returned grouped by `useProviders()`. */
type ProviderGroup = { provider: Channel['provider']; channels: Channel[] };

/**
 * All cross-cutting side-effects of the wizard, lifted out of the page body so
 * the render path stays linear. Behaviour is identical to the previous inline
 * effects — each effect, its guards and its dependency array are preserved
 * verbatim (including the deliberate exhaustive-deps suppression on step 4).
 */
function useCampaignWizardEffects(args: {
  channels: Channel[] | undefined;
  templates: Template[] | undefined;
  template: Template | undefined;
  step: number;
  setStep: Dispatch<SetStateAction<number>>;
  name: string;
  templateId: string;
  setTemplateId: Dispatch<SetStateAction<string>>;
  defaultInstanceId: string;
  setDefaultInstanceId: Dispatch<SetStateAction<string>>;
  variableMap: VariableMap;
  setVariableMap: Dispatch<SetStateAction<VariableMap>>;
  filters: FilterGroup;
  previewResult: PreviewResult | null;
  setPreviewResult: Dispatch<SetStateAction<PreviewResult | null>>;
  preview: ReturnType<typeof usePreviewCampaign>;
  /** Pedido do cliente (2026-08-25) — ver a prévia de recuperação abaixo. */
  excludeAnyPreviousCampaign: boolean;
}) {
  const {
    channels,
    templates,
    template,
    step,
    setStep,
    name,
    templateId,
    setTemplateId,
    defaultInstanceId,
    setDefaultInstanceId,
    variableMap,
    setVariableMap,
    filters,
    previewResult,
    setPreviewResult,
    preview,
    excludeAnyPreviousCampaign,
  } = args;

  // Auto-select a default channel when none is selected yet — or when the
  // current selection is no longer visible under the active provider scope
  // (e.g. the operator narrowed the topbar scope to another provider). Prefer a
  // connected default channel, then any connected channel, then whatever is
  // available so the wizard always lands on a usable channel.
  useEffect(() => {
    if (!channels || channels.length === 0) return;
    const stillVisible = channels.some((c) => c.id === defaultInstanceId);
    if (defaultInstanceId && stillVisible) return;
    const pick =
      channels.find((c) => c.isDefault && c.isActive && c.phoneE164) ??
      channels.find((c) => c.isActive && c.phoneE164) ??
      channels.find((c) => c.isDefault) ??
      channels[0];
    if (pick && pick.id !== defaultInstanceId) setDefaultInstanceId(pick.id);
  }, [channels, defaultInstanceId, setDefaultInstanceId]);

  // If the user lands on step 4 without a previewResult (e.g. reloaded the
  // tab while having a step=4 draft), recompute the preview from the saved
  // filters instead of rendering a blank screen.
  //
  // ★ COM O TEMPLATE. Sem ele esta prévia devolveria a audiência BRUTA (500) e
  // a tela de confirmação prometeria 500 onde o disparo materializa 88 — quem
  // recarregasse a aba no passo 4 nunca veria o número real.
  useEffect(() => {
    if (step !== 4) return;
    if (previewResult) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await preview.mutateAsync({
          filters,
          templateId: templateId || null,
          excludeAnyPreviousCampaign,
        });
        if (cancelled) return;
        if (r.count === 0) {
          // No recipients with current filters — bounce back to step 3 so the
          // user can adjust them.
          setStep(3);
          toast.info(
            'Os filtros atuais não selecionam nenhum contato. Ajuste e veja a prévia.',
          );
          return;
        }
        setPreviewResult(r);
      } catch {
        setStep(3);
      }
    })();
    return () => {
      cancelled = true;
    };
    // We deliberately want this effect to run only when entering step 4 or
    // when the cached previewResult disappears — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, previewResult]);

  // Warn before unload if there is unsaved work in the wizard
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const hasWork =
        step > 1 ||
        Boolean(name) ||
        Boolean(templateId) ||
        Object.keys(variableMap).length > 0 ||
        filters.rules.length > 0;
      if (hasWork) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [step, name, templateId, variableMap, filters]);

  // If a draft references a template that was deleted, drop the stale ref
  // and bounce the user back to step 1 so they can re-pick.
  useEffect(() => {
    if (!templates || !templateId) return;
    const exists = templates.some((t) => t.id === templateId);
    if (!exists) {
      setTemplateId('');
      setVariableMap({});
      if (step > 1) {
        setStep(1);
        toast.info('O template selecionado não existe mais. Escolha outro.');
      }
    }
  }, [templates, templateId, step, setTemplateId, setVariableMap, setStep]);

  // Auto-populate variableMap with sensible defaults for any template variables
  // the user hasn't touched yet. The Step 2 UI shows "Campo do contato → name"
  // pre-filled, but the state stayed empty if the user didn't actually interact
  // with the dropdowns — leading to {{nome}} leaking through to the SMS literally.
  // Functional setState keeps the dep array stable (no variableMap), avoiding
  // an extra render cycle each time the effect runs, and the explicit
  // `prev[v] !== undefined` guard is robust against future undefined writes.
  useEffect(() => {
    if (!template || template.variables.length === 0) return;
    setVariableMap((prev) => {
      const additions: VariableMap = {};
      for (const v of template.variables) {
        if (prev[v] !== undefined) continue;
        additions[v] = { source: 'field', field: guessFieldFor(v) };
      }
      return Object.keys(additions).length > 0 ? { ...prev, ...additions } : prev;
    });
  }, [template, setVariableMap]);
}

function Step1NameTemplate({
  name,
  setName,
  templateId,
  setTemplateId,
  defaultInstanceId,
  purposeKey,
  setPurposeKey,
  purposes,
  onSelectChannel,
  templates,
  groups,
  onNext,
}: {
  name: string;
  setName: (v: string) => void;
  templateId: string;
  setTemplateId: (v: string) => void;
  defaultInstanceId: string;
  purposeKey: string;
  setPurposeKey: (v: string) => void;
  purposes: ConsentPurpose[] | undefined;
  onSelectChannel: (channel: Channel) => void;
  templates: Template[] | undefined;
  /** Channels grouped by provider, already filtered by the global scope. */
  groups: ProviderGroup[];
  onNext: () => void;
}) {
  // With multi-provider channels there's no single global sender: every
  // configured channel (Evolution QR connections, Twilio senders, …) is listed
  // and grouped by its provider. The list is pre-filtered by the topbar's
  // provider scope, so `groups` already respects "Todos os canais" vs a single
  // provider. `defaultInstanceId` stays the id of the chosen channel.
  const hasChannels = groups.some((g) => g.channels.length > 0);
  const selectedPurpose = purposes?.find((p) => p.key === purposeKey);

  // ★ Botões ilegíveis: o wizard precisa dizer ANTES, não no 400 do último
  // clique. O item fica cinza na lista, e o aviso completo (com o caminho do
  // conserto) aparece quando ele é o template ESCOLHIDO — ou quando TODOS os
  // disparáveis estão bloqueados, senão o operador só veria uma lista morta.
  const selectable = selectableTemplates(templates);
  const selected = selectable.find((t) => t.id === templateId);
  const selectedBlocked = selected ? templateBlockedReason(selected) : null;
  const allBlocked =
    selectable.length > 0 &&
    selectable.every((t) => templateBlockedReason(t) !== null);
  const buttonsNote = selectedBlocked ?? (allBlocked ? TEMPLATE_BUTTONS_BLOCKED : null);

  return (
    <Card>
      <CardHeader><CardTitle>Nome e template</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label>Nome</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Boas-vindas alunos abril" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="template-id">Template</Label>
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger id="template-id"><SelectValue placeholder="Escolha um template" /></SelectTrigger>
            <SelectContent>
              {selectable.map((t) => {
                const blocked = templateBlockedReason(t) !== null;
                return (
                  <SelectItem key={t.id} value={t.id} disabled={blocked}>
                    {t.metaName} ({t.language})
                    {blocked ? ' — botões não classificados' : ''}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {buttonsNote && (
            <p role="alert" className="text-xs text-destructive">
              {buttonsNote}
            </p>
          )}
        </div>
        {/*
          C1b/C2 — a finalidade. O consentimento é registrado POR finalidade
          (art. 8º §4º: autorização genérica é nula), e o gate de dispatch só
          envia para quem consentiu para ESTA — em QUALQUER provedor. Sem ela a
          campanha nasce e não envia nada, em silêncio: por isso é obrigatória
          aqui (e o backend recusa com `campaign.purpose_required`).
        */}
        <div className="space-y-1">
          <Label htmlFor="purpose-key">Finalidade</Label>
          <Select value={purposeKey} onValueChange={setPurposeKey}>
            <SelectTrigger id="purpose-key">
              <SelectValue placeholder="Escolha a finalidade da campanha" />
            </SelectTrigger>
            <SelectContent>
              {(purposes ?? []).map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.label}
                  {p.isSensitive ? ' (sensível)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-[var(--foreground-muted)]">
            {selectedPurpose?.description ??
              'Só recebe quem consentiu para esta finalidade — quem consentiu para outra não recebe.'}
          </p>
          {!purposeKey && (
            <p className="text-xs text-destructive">
              Selecione a finalidade da campanha — o consentimento é registrado
              por finalidade.
            </p>
          )}
        </div>
        <section className="space-y-3">
          <h3 className="text-base font-semibold">Enviar a partir de</h3>
          {!hasChannels ? (
            <p className="text-sm text-destructive">
              Nenhum canal no contexto atual —{' '}
              <Link to="/connect" className="underline">
                ver Canais
              </Link>
            </p>
          ) : (
            <>
              <p className="text-xs text-[var(--foreground-muted)]">
                Contatos com histórico continuam saindo do canal que já falou com eles.
              </p>
              {groups.map((group) => (
                <div key={group.provider} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <ProviderBadge provider={group.provider} />
                    <span className="text-[11px] text-[var(--foreground-muted)]">
                      {group.channels.length}{' '}
                      {group.channels.length === 1 ? 'canal' : 'canais'}
                    </span>
                  </div>
                  {group.channels.map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 rounded border px-3 py-2 text-sm"
                      style={{ opacity: c.isActive ? 1 : 0.5 }}
                    >
                      <input
                        type="radio"
                        name="defaultInstanceId"
                        value={c.id}
                        checked={defaultInstanceId === c.id}
                        onChange={() => onSelectChannel(c)}
                        disabled={!c.isActive || !c.phoneE164}
                      />
                      <ProviderBadge provider={c.provider} />
                      <strong>{c.name}</strong>
                      {c.isDefault && (
                        <span className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                          padrão
                        </span>
                      )}
                      <span className="ml-auto font-mono text-xs text-[var(--foreground-muted)]">
                        {c.phoneE164 ?? 'desconectada'}
                      </span>
                    </label>
                  ))}
                </div>
              ))}
              {!defaultInstanceId && (
                <p className="text-xs text-destructive">Selecione o canal</p>
              )}
            </>
          )}
        </section>
        <Button
          // `selectedBlocked` cobre o caso em que o bloqueio nasce DEPOIS da
          // escolha: o rascunho em sessionStorage guarda o `templateId`, e o
          // papel declarado de um botão cai sozinho quando a Meta reescreve o
          // rótulo (`reconcileConsentButtonRoles` nunca inventa papel). Sem
          // isto o item cinza no select não bastaria e o 400 voltaria.
          disabled={
            !name ||
            !templateId ||
            !defaultInstanceId ||
            !purposeKey ||
            selectedBlocked !== null
          }
          onClick={onNext}
        >
          Próximo
        </Button>
      </CardContent>
    </Card>
  );
}

function Step2TemplateUnavailable({ onBack }: { onBack: () => void }) {
  return (
    <Card>
      <CardHeader><CardTitle>Template indisponível</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          O template selecionado não existe mais (pode ter sido excluído).
          Volte ao passo 1 para escolher outro.
        </p>
        <Button onClick={onBack}>
          Voltar ao passo 1
        </Button>
      </CardContent>
    </Card>
  );
}

function Step2Variables({
  template,
  variableMap,
  setVariableMap,
  onBack,
  onNext,
}: {
  template: Template;
  variableMap: VariableMap;
  setVariableMap: (v: VariableMap) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Variáveis do template</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">{template.body}</pre>
        {template.variables.length === 0 ? (
          <p className="text-sm text-muted-foreground">Esse template não tem variáveis.</p>
        ) : (
          template.variables.map((v) => {
            const current = variableMap[v] ?? { source: 'field' as const, field: 'name' };
            return (
              <div key={v} className="grid grid-cols-3 gap-2 items-center">
                <Label>{`{{${v}}}`}</Label>
                <Select
                  value={current.source}
                  onValueChange={(s) => setVariableMap({
                    ...variableMap,
                    [v]: s === 'literal'
                      ? { source: 'literal', value: '' }
                      : { source: 'field', field: 'name' },
                  })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="field">Campo do contato</SelectItem>
                    <SelectItem value="literal">Valor fixo</SelectItem>
                  </SelectContent>
                </Select>
                {current.source === 'literal' ? (
                  <Input
                    value={current.value}
                    onChange={(e) => setVariableMap({
                      ...variableMap,
                      [v]: { source: 'literal', value: e.target.value },
                    })}
                  />
                ) : (
                  <Select
                    value={current.field}
                    onValueChange={(f) => setVariableMap({
                      ...variableMap,
                      [v]: { source: 'field', field: f },
                    })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['name', 'city', 'group', 'phoneE164'].map((f) => (
                        <SelectItem key={f} value={f}>{f}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            );
          })
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack}>Voltar</Button>
          <Button onClick={onNext}>Próximo</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Step4Confirm({
  previewResult,
  filters,
  defaultInstanceId,
  defaultInstanceName,
  purposeKey,
  purposeLabel,
  schedule,
  setSchedule,
  presenceDelayMs,
  setPresenceDelayMs,
  override,
  setOverride,
  respeitarJanelaDeEnvio,
  setRespeitarJanelaDeEnvio,
  excludeAnyPreviousCampaign,
  create,
  sendFirstBatch,
  onBack,
  onConfirm,
}: {
  previewResult: PreviewResult;
  filters: FilterGroup;
  defaultInstanceId: string;
  /** A.3 — o nome do canal, para a frase do teto de hoje. */
  defaultInstanceName: string;
  /** C1b — finalidade declarada; o preflight conta o consentimento por ela. */
  purposeKey: string;
  purposeLabel: string | undefined;
  schedule: ScheduleConfig;
  setSchedule: (s: ScheduleConfig) => void;
  presenceDelayMs: number;
  setPresenceDelayMs: (n: number) => void;
  override: boolean;
  setOverride: (v: boolean) => void;
  /** Pedido do cliente (2026-08-25) — concorda com a janela de horário comercial. */
  respeitarJanelaDeEnvio: boolean;
  setRespeitarJanelaDeEnvio: (v: boolean) => void;
  /**
   * Pedido do cliente (2026-08-25) — "excluir quem já recebeu qualquer
   * campanha anterior" (decidido no passo 3). Só leitura aqui: alimenta o
   * texto do `SendAnalysisPanel`, que teria que mentir ("este mesmo
   * template") se a régua larga estiver ligada.
   */
  excludeAnyPreviousCampaign: boolean;
  create: ReturnType<typeof useCreateCampaign>;
  /** Fix round 1 (#2) — o gate do botão precisa saber que o LOTE está em voo,
      não só a criação; sem isto os dois botões reabilitavam entre o create
      resolver e o sendFirstBatch terminar. */
  sendFirstBatch: ReturnType<typeof useSendFirstBatch>;
  onBack: () => void;
  onConfirm: (opts: {
    enviarPrimeiroLote: boolean;
    tamanho: number;
  }) => void | Promise<void>;
}) {
  const preflight = usePreflightCampaignChecks();
  const [checks, setChecks] = useState<SendCheck[]>([]);
  const [consent, setConsent] = useState<ConsentSummary | null>(null);
  /*
    ★ Sobre QUANTOS contatos a análise foi feita.

    `preflight-checks` resolve o `where` direto do FilterGroup: sem a exclusão
    "já está em campanha com este template" (só o `preview` aplica essa
    exclusão). O `recipients` que ele devolve é, portanto, o tamanho do FILTRO
    — e é o único número que permite dizer, sem inventar, sobre quem os
    alertas e o consentimento falam. Ele chegava aqui e era jogado fora; sem
    ele a tela só sabia que os números não batiam, não sabia por quanto.
  */
  const [analyzedCount, setAnalyzedCount] = useState<number | null>(null);
  // A análise já respondeu com SUCESSO? Enquanto não, o disparo fica travado —
  // ver `analysisPending` abaixo.
  const [analysisReady, setAnalysisReady] = useState(false);
  // ...e se ela FALHOU, o operador precisa SABER e poder tentar de novo. Um
  // botão travado em "Analisando envio…" para sempre, sem explicação, seria o
  // mesmo bug deste PR de cabeça para baixo: um bloqueio silencioso.
  const [analysisError, setAnalysisError] = useState(false);
  const [analysisAttempt, setAnalysisAttempt] = useState(0);

  // Fetch the send-analysis checks when entering the step and whenever the
  // connection or schedule change — these inputs drive WINDOW/OVERLAP/FREQUENCY
  // checks. `filters` is captured at step entry (committed by step 3) so it does
  // not change while on step 4; including it would re-fetch needlessly.
  const runPreflight = preflight.mutateAsync;
  useEffect(() => {
    if (!defaultInstanceId) return;
    // The config changed (connection/schedule), so the send-checks are about to
    // be recomputed — clear any stale operator override. Otherwise an override
    // accepted for the *previous* config would silently carry over and (since
    // the backend honours `override`) bypass a block that applies to the new
    // config. Forces re-acknowledgement whenever the analysis changes.
    setOverride(false);
    setAnalysisReady(false);
    setAnalysisError(false);
    let cancelled = false;
    (async () => {
      try {
        const res = await runPreflight({
          filters,
          defaultInstanceId,
          schedule,
          timezone: TIMEZONE_DEFAULT,
          // C1b — com a finalidade, a análise conta também quantos consentiram
          // para ela. Sem ela, o backend devolve `consent: null`.
          purposeKey: purposeKey || undefined,
        });
        if (!cancelled) {
          setChecks(res.checks);
          setConsent(res.consent ?? null);
          setAnalyzedCount(res.recipients ?? null);
          setAnalysisReady(true);
        }
      } catch {
        if (!cancelled) {
          setChecks([]);
          setConsent(null);
          setAnalyzedCount(null);
          // FAIL-CLOSED, mas NUNCA em silêncio: o botão continua travado (antes o
          // painel sumia E o botão ficava livre — disparo às cegas garantido),
          // porém a tela DIZ que a análise falhou e oferece "Tentar de novo".
          setAnalysisReady(false);
          setAnalysisError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultInstanceId, schedule, purposeKey, runPreflight, analysisAttempt]);

  /*
    A.3 — "DISPARAR" DEIXA DE SIGNIFICAR "ENFILEIRAR A BASE INTEIRA".

    O número que nasce aqui é o teto de HOJE do canal escolhido. É a decisão 2
    da spec — e é a resposta à causa (c) do "sempre repete": a campanha parava
    em 500 porque 500 é o teto do canal, não porque alguém a limitou. Dizendo o
    número ANTES, o operador para de criar uma campanha nova para "continuar".

    Fix round 1 (#1) — ANTES, canal indisponível (ainda carregando, ou id sem
    correspondência) caía no MESMO `canal ? … : 0` de quota esgotada de
    verdade: `tamanhoInicialDoLote` nunca devolve 0 com `restam > 0` (★ NUNCA
    UM CAMPO COM 0, ver channel-quota.ts), então um teto de "0 por ignorância"
    virava sugestão "1" — o assistente oferecia e mandava 1 mensagem sem saber
    se o canal tinha QUALQUER quota. Agora o campo só se preenche quando o
    canal é conhecido; enquanto não é, o botão de enviar fica travado com um
    estado explícito (ver o rodapé).

    T15 — o canal vem de `useProviders()` (TODO provedor) via
    `resolveCampaignChannel` (resolve-channel.ts), a MESMA regra que o
    cabeçalho de progresso da campanha usa. `useInstances()`
    (GET /whatsapp/instances) é EVOLUTION-only: para GOZAP (o canal de
    PRODUÇÃO), ZERNIO, TWILIO e META o canal buscado por ali ficava
    `undefined` para sempre, e o envio ficava bloqueado com "Canal não
    encontrado" mesmo com o canal são.

    Fix round 1 (#2, review Opus) — `refetchOnMount: 'always'`: sem isto, o
    `staleTime: Infinity` do `useProviders()` deixaria este passo propor um
    lote a partir de um `sentToday` que o passo 1 (ou o topbar) buscou há
    minutos/horas — o operador veria um número que já não bate com o teto de
    hoje de verdade.
  */
  const providersQuery = useProviders({ refetchOnMount: 'always' });
  const resolution = resolveCampaignChannel(providersQuery, defaultInstanceId);
  const canalCarregando = resolution.state === 'loading';
  const canalComErro = resolution.state === 'error';
  const canalDesconhecido = resolution.state === 'missing';
  const canal = resolution.state === 'found' ? resolution.canal : undefined;
  // Achado 4 (review final) — um relógio só, para "quanto já saiu hoje" e
  // "quando reinicia" nunca discordarem entre si dentro do mesmo render.
  const now = new Date();
  const restaQuota = canal ? quotaRestante(canal, now) : 0;
  const tetoDoDia = canal ? capDeHoje(canal) : 0;
  const reset = canal
    ? horaDoReset(canal.sentTodayResetAt, TIMEZONE_DEFAULT, now)
    : null;
  const sugerido = canal
    ? tamanhoInicialDoLote({
        restam: previewResult.count,
        quotaRestante: restaQuota,
        capDeHoje: tetoDoDia,
      })
    : 0;
  const [primeiroLote, setPrimeiroLote] = useState<string>('');
  // Fix round 1 (#3) — a query de canais pode recalcular (refoco, poll de um
  // consumidor irmão) ENQUANTO o operador já digitou um valor no campo. Sem a
  // flag `tocado`, esse recálculo sobrescrevia silenciosamente o que ele
  // tinha acabado de escrever. A sugestão só vale como PONTO DE PARTIDA —
  // depois do primeiro toque, o campo é do operador.
  const [tocado, setTocado] = useState(false);
  useEffect(() => {
    if (tocado || !canal) return;
    setPrimeiroLote(sugerido > 0 ? String(sugerido) : '');
  }, [sugerido, canal, tocado]);
  const tamanhoPedido = Number.parseInt(primeiroLote, 10);
  // Minor 9 (review final) — `sendCampaignBatchSchema` (backend) rejeita
  // `size > 5000` com a mensagem crua do zod; o campo já tem `max={5000}` no
  // HTML, mas nada impedia digitar 6000 e clicar mesmo assim.
  const tamanhoValido =
    Number.isFinite(tamanhoPedido) && tamanhoPedido > 0
      ? Math.min(tamanhoPedido, previewResult.count, MAX_BATCH_SIZE)
      : 0;
  // Minor 7 (review final) — o aviso usava o número DIGITADO (`tamanhoPedido`),
  // não o CLAMPADO (`tamanhoValido`): pedir 4800 com 300 no público avisava
  // "4.500 ficam em fila" quando só 300 sequer existem para enviar.
  const avisoLote = canal
    ? avisoDeQuota({ tamanho: tamanhoValido, quotaRestante: restaQuota, reset })
    : null;

  /*
    Fix round 1 (CRÍTICO) — um agendamento ÚNICO e FUTURO (ONCE_AT) não é
    "enviar agora": é o operador dizendo explicitamente "não agora, só nessa
    data". `sendBatch` desarma esse agendamento (`campaigns.service.ts`,
    `disarmSchedule: !isRecurring`) e dispara NA HORA — chamá-lo aqui mandaria
    mensagens reais no clique e jogaria fora a data escolhida. DAILY_AT/WEEKLY/
    INTERVAL são RECORRENTES: o 1º lote sai agora e o agendamento continua
    armado para os próximos, então esses seguem o caminho normal do A.3.
  */
  const isRecurring =
    schedule.type === 'DAILY_AT' ||
    schedule.type === 'WEEKLY' ||
    schedule.type === 'INTERVAL';
  const isScheduledOnce = schedule.type !== 'IMMEDIATE' && !isRecurring;

  const blocked = hasBlockingCheck(checks) && !override;

  /*
    GATE SILENCIOSO — o painel de consentimento existia e era DECORATIVO.

    O número dele nunca entrava no `disabled` do botão: com 2 contatos e 0
    elegíveis, o botão "Disparar agora" ficava habilitado, o disparo acontecia, o
    sistema dava um toast VERDE de sucesso — e o operador ia procurar, por horas,
    um bug de horário que não existia.

    Isto NÃO afrouxa nem endurece o gate: uma campanha com ZERO destinatários
    efetivos não tem o que disparar. Bloquear o clique não muda um único envio;
    só evita criar uma campanha zumbi que nunca enviaria nada.

    O número que trava o botão é `eligible` (o que o GATE autoriza: consentimento
    explícito ∪ janela de atendimento aberta), NÃO `withConsent` (só o
    consentimento explícito). Usar `withConsent` faria a tela BLOQUEAR uma
    campanha `servico_projeto` para quem respondeu nas últimas 24h — envio que o
    gate manda sair. E o override do operador ("Entendo o risco") também não é
    antecipado aqui: quando ele está marcado, o disparo NÃO é travado pela
    contagem — quem decide continua sendo o backend, que é o único autoritativo.
  */
  // Quantos NÃO entraram por já estarem em campanha com este mesmo template.
  // Vem da prévia (que aplica a MESMA exclusão do disparo) e é o que permite à
  // confirmação explicar por que a audiência encolheu.
  const excludedSameTemplate = previewResult.excludedSameTemplate ?? 0;

  /*
    ★ QUANTOS VÃO RECEBER — e quando esse número é CONHECIDO.

    `consent.eligible` vem do `preflight-checks`, que resolve o `where` direto do
    FilterGroup: SEM a exclusão por template. O `preview` (previewResult.count)
    já aplica essa exclusão. Quando os dois medem audiências diferentes,
    ninguém — nem a tela nem o backend, antes do disparo —
    sabe QUANTOS dos elegíveis caíram dentro da lista recortada: a análise conta
    pessoas, o recorte escolhe pessoas, e os dois não conversam.

    O que dá para afirmar é uma FAIXA:
      - no máximo min(eligible, count)   — não pode passar do teto do gate nem do
        tamanho da audiência;
      - no mínimo count - withoutConsent — no pior caso TODOS os sem-consentimento
        estavam dentro da audiência recortada.
    Quando os dois extremos coincidem (o caso normal: a análise mediu a MESMA
    audiência do disparo), o número é exato e a tela o afirma sem ressalva.

    Um `Math.min` sozinho seria pior que o bug anterior: trocava "6500 de 500"
    (absurdo, faz o operador parar) por "500 de 500" (plausível, lê-se como "todo
    mundo daqui recebe") quando a verdade eram ~250. Número não sabido é dito
    como "até".
  */
  const maxWillReceive = consent
    ? Math.min(consent.eligible, previewResult.count)
    : previewResult.count;
  const minWillReceive = consent
    ? Math.max(0, previewResult.count - consent.withoutConsent)
    : previewResult.count;
  /** O número é conhecido, ou é só um teto? */
  const willReceiveIsExact = minWillReceive === maxWillReceive;
  /** A análise falou de mais gente do que o disparo vai atingir. */
  const analysisOverAudience =
    analyzedCount !== null && analyzedCount > previewResult.count;
  const nobodyEligible =
    consent !== null && consent.eligible === 0 && !override;
  // Enquanto a análise não voltou — ou FALHOU — o botão não pode estar livre: um
  // erro de rede sumia com o aviso E liberava o disparo. Ver `analysisError`
  // para o que a tela mostra nesse caso.
  const analysisPending = !analysisReady;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Confirmar — {previewResult.count} destinatário{previewResult.count === 1 ? '' : 's'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ★ A confirmação DIZ por que a audiência encolheu — mesmo texto do
            painel do passo 3. O número do título já é o pós-exclusão (a prévia
            leva o template); sem esta linha ele seria um número menor sem
            explicação, na única tela onde o operador aperta o botão. */}
        <SameTemplateExclusionNotice count={excludedSameTemplate} />

        {previewResult.sample.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Amostra
            </p>
            <ul className="space-y-1 text-sm">
              {previewResult.sample.slice(0, 5).map((c) => (
                <li key={c.id} className="flex items-center justify-between">
                  <span>{c.name ?? '—'}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {c.phoneE164}
                  </span>
                </li>
              ))}
              {previewResult.count > 5 && (
                <li className="text-xs text-muted-foreground">
                  + {previewResult.count - 5} outro(s)
                </li>
              )}
            </ul>
          </div>
        )}

        {/*
          C1b — o custo do gate, ANTES do disparo. Sem isto o operador só
          descobre que a campanha não enviou nada depois de ver a audiência
          inteira virar SKIPPED_NO_CONSENT na tela de mensagens.

          GATE SILENCIOSO — o painel subiu para logo abaixo da Amostra (antes ele
          nascia depois do agendamento e do select de presença, abaixo da dobra
          num laptop) e ganhou peso de ALERTA quando ninguém consentiu. Ele
          precisa estar colado à contagem de destinatários do título, não atrás
          de dois campos de formulário.
        */}
        {consent && (
          <div
            data-testid="consent-summary"
            className={`space-y-1 rounded border p-3 ${
              consent.eligible === 0 ? 'bg-destructive/10' : ''
            }`}
            style={
              consent.eligible === 0
                ? { borderColor: 'var(--destructive)' }
                : undefined
            }
          >
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {consent.eligible === 0 && (
                <ShieldOff className="h-3.5 w-3.5 text-destructive" />
              )}
              Consentimento — {purposeLabel ?? consent.purposeKey}
            </p>
            {consent.eligible === 0 ? (
              <p className="text-sm text-destructive">
                Nenhum contato desta audiência pode receber esta finalidade — a
                campanha não enviaria nada. Todos os{' '}
                <strong>{consent.withoutConsent}</strong> seriam pulados.
                Escolha outra finalidade ou colete o consentimento antes.
              </p>
            ) : analysisOverAudience ? (
              /*
                ★ A AUDIÊNCIA FOI RECORTADA — a frase "X de Y vão receber" seria
                MENTIRA aqui. `consent.eligible` foi contado sobre o filtro
                inteiro; a campanha vai para um pedaço dele. Dizer o número maior
                com o verbo mais forte, no card onde o operador aperta o botão, é
                o defeito que este passo existe para não ter.
              */
              <>
                <p className="text-sm">
                  Entre os <strong>{analyzedCount}</strong> contatos que o filtro
                  encontrou, <strong>{consent.eligible}</strong> podem receber
                  esta finalidade e <strong>{consent.withoutConsent}</strong>{' '}
                  seriam pulados (sem consentimento, ou opt-out).
                </p>
                <p className="text-sm">
                  Mas esta campanha vai para{' '}
                  <strong>{previewResult.count}</strong> contatos
                  {excludedSameTemplate > 0 ? (
                    <>
                      {' '}
                      — os outros {excludedSameTemplate} já estão em campanha com
                      este mesmo template
                    </>
                  ) : null}
                  . Desses {previewResult.count},{' '}
                  {willReceiveIsExact ? (
                    <>
                      <strong>{maxWillReceive}</strong> vão receber
                    </>
                  ) : (
                    <>
                      vão receber entre <strong>{minWillReceive}</strong> e{' '}
                      <strong>{maxWillReceive}</strong> — o número exato só
                      aparece no disparo, porque a contagem de consentimento foi
                      feita antes do recorte
                    </>
                  )}
                  .
                </p>
                {consent.viaOpenWindow > 0 && (
                  <p className="text-sm">
                    <strong>{consent.viaOpenWindow}</strong> dos elegíveis entram
                    pela janela de atendimento de 24h (responderam há pouco), sem
                    opt-in explícito — o gate autoriza, mas só para esta
                    finalidade de serviço.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm">
                <strong>{consent.eligible}</strong> de{' '}
                {consent.eligible + consent.withoutConsent} contatos vão receber.{' '}
                <strong>{consent.withoutConsent}</strong> serão pulados (sem
                consentimento para esta finalidade, ou opt-out).
                {consent.viaOpenWindow > 0 && (
                  <>
                    {' '}
                    Dos que vão receber, <strong>
                      {consent.viaOpenWindow}
                    </strong>{' '}
                    entram pela janela de atendimento de 24h (responderam há
                    pouco), sem opt-in explícito — o gate autoriza, mas só para
                    esta finalidade de serviço.
                  </>
                )}
              </p>
            )}
          </div>
        )}

        {/* A.3 — "Continuar automaticamente" é a recorrência que já existe.
            Escolher DAILY_AT aqui faz o tick diário enviar a quem ainda não
            recebeu, respeitando o teto do canal — que é exatamente o que o
            operador estava tentando fazer à mão criando campanhas novas. */}
        <p className="text-xs text-muted-foreground">
          Para continuar sozinho: escolha <strong>Todo dia às</strong> abaixo.
          Todo dia, no horário, envia para quem ainda não recebeu, respeitando o
          teto do canal.
        </p>

        <SchedulePicker value={schedule} onChange={setSchedule} />

        {/* Pedido do cliente (2026-08-25) — o operador concorda, na criação,
            com a janela de horário comercial do canal. Ligado por padrão: o
            operador PODE desligar, mas a decisão é explícita, não silenciosa. */}
        <div className="flex items-start gap-2 rounded-md border p-2.5">
          <Checkbox
            id="respect-send-window"
            checked={respeitarJanelaDeEnvio}
            onCheckedChange={(v) => setRespeitarJanelaDeEnvio(v === true)}
          />
          <Label
            htmlFor="respect-send-window"
            className="cursor-pointer text-sm font-normal leading-snug"
          >
            Enviar apenas em horário comercial (8h–20h)
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Desligado, esta campanha pode enviar fora desse horário.
            </span>
          </Label>
        </div>

        <div className="space-y-1">
          <Label htmlFor="presence-delay">
            Presença (digitando…) antes de enviar
          </Label>
          <Select
            value={String(presenceDelayMs)}
            onValueChange={(v) => setPresenceDelayMs(Number(v))}
          >
            <SelectTrigger id="presence-delay">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Desativado (envio imediato)</SelectItem>
              <SelectItem value="1000">1 segundo</SelectItem>
              <SelectItem value="2000">2 segundos</SelectItem>
              <SelectItem value="3000">3 segundos</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Faz a conta aparecer como online + digitando antes da
            mensagem chegar. Útil em campanhas pequenas para parecer
            mais humano. Atrasa cada envio nesse tempo.
          </p>
        </div>


        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Análise de envio
          </p>
          {analysisError ? (
            /* A análise FALHOU. Sem isto o botão ficava travado em "Analisando
               envio…" para sempre, sem uma linha na tela dizendo por quê — o
               bloqueio silencioso deste PR, invertido. */
            <div
              data-testid="analysis-error"
              className="space-y-2 rounded border p-3"
              style={{ borderColor: 'var(--destructive)' }}
            >
              <p className="text-sm text-destructive">
                Não foi possível analisar o envio (o servidor não respondeu). Sem
                a análise, o disparo fica bloqueado — ela é o que diz quantos
                contatos podem receber.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAnalysisAttempt((n) => n + 1)}
              >
                Tentar de novo
              </Button>
            </div>
          ) : preflight.isPending && checks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Analisando…</p>
          ) : (
            <SendAnalysisPanel
              checks={checks}
              recipients={previewResult.count}
              excludedSameTemplate={excludedSameTemplate}
              analyzedCount={analyzedCount}
              excludeAnyPreviousCampaign={excludeAnyPreviousCampaign}
              override={override}
              onOverrideChange={setOverride}
            />
          )}
        </div>

        <div className="space-y-3 border-t pt-4">
          {/* Fix round 1 (CRÍTICO) — ONCE_AT não mostra o campo/lote: aqui não
              existe "quanto enviar agora", existe só "quando", e essa decisão já
              foi tomada no SchedulePicker acima. Mostrar o campo sugeriria um
              envio imediato que a decisão 2 da spec proíbe. */}
          {!isScheduledOnce && (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label htmlFor="first-batch-size" className="text-xs">
                    Enviar agora
                  </Label>
                  <Input
                    id="first-batch-size"
                    data-testid="first-batch-size"
                    type="number"
                    min={1}
                    max={5000}
                    className="w-28"
                    disabled={canalCarregando || canalComErro || canalDesconhecido}
                    value={primeiroLote}
                    onChange={(e) => {
                      setTocado(true);
                      setPrimeiroLote(e.target.value);
                    }}
                  />
                </div>
                <p className="pb-1 text-xs text-muted-foreground">
                  {canalCarregando
                    ? 'Carregando o teto do canal…'
                    : canalComErro
                      ? 'Não deu para consultar os canais — tente de novo'
                      : canalDesconhecido
                        ? 'O canal desta campanha não foi encontrado — verifique em Canais.'
                        : canal
                          ? `Teto de hoje do canal "${defaultInstanceName}" (já enviou ${(canal.sentToday ?? 0).toLocaleString('pt-BR')} de ${tetoDoDia.toLocaleString('pt-BR')}).`
                          : 'Teto de hoje do canal escolhido.'}
                  {!canalCarregando && !canalComErro && !canalDesconhecido && (
                    <>
                      {' '}
                      Restam{' '}
                      {Math.max(
                        0,
                        previewResult.count - tamanhoValido,
                      ).toLocaleString('pt-BR')}{' '}
                      para os próximos lotes.
                    </>
                  )}
                </p>
              </div>

              {avisoLote && (
                <p data-testid="first-batch-notice" className="text-xs text-amber-600">
                  {avisoLote}
                </p>
              )}
            </>
          )}

          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="outline" onClick={onBack}>
              Voltar
            </Button>
            <div className="flex flex-wrap gap-2">
              {/* "Criar sem enviar" só faz sentido quando existe uma decisão
                  de "enviar agora" para recusar. Com ONCE_AT já não enviar
                  agora é a própria escolha — duas ações fariam a mesma coisa
                  com nomes diferentes, então o único botão vira "Agendar
                  campanha". */}
              {!isScheduledOnce && (
                <Button
                  variant="outline"
                  data-testid="create-without-sending"
                  disabled={
                    create.isPending ||
                    sendFirstBatch.isPending ||
                    previewResult.count === 0
                  }
                  onClick={() =>
                    void onConfirm({ enviarPrimeiroLote: false, tamanho: 0 })
                  }
                >
                  Criar sem enviar
                </Button>
              )}
              <Button
                data-testid={isScheduledOnce ? 'schedule-campaign' : 'create-and-send'}
                disabled={
                  create.isPending ||
                  sendFirstBatch.isPending ||
                  previewResult.count === 0 ||
                  blocked ||
                  nobodyEligible ||
                  analysisPending ||
                  (!isScheduledOnce &&
                    (tamanhoValido === 0 ||
                      canalCarregando ||
                      canalComErro ||
                      canalDesconhecido))
                }
                onClick={() =>
                  void onConfirm(
                    isScheduledOnce
                      ? { enviarPrimeiroLote: false, tamanho: 0 }
                      : { enviarPrimeiroLote: true, tamanho: tamanhoValido },
                  )
                }
              >
                {create.isPending
                  ? 'Salvando…'
                  : sendFirstBatch.isPending
                    ? 'Enviando 1º lote…'
                    : analysisError
                      ? 'Análise indisponível'
                      : analysisPending
                        ? 'Analisando envio…'
                        : isScheduledOnce
                          ? 'Agendar campanha'
                          : `Criar e enviar 1º lote — ${tamanhoValido.toLocaleString('pt-BR')}`}
              </Button>
            </div>
          </div>
        </div>
        {nobodyEligible && (
          <p className="text-right text-xs text-destructive">
            Ninguém pode receber "{purposeLabel ?? consent?.purposeKey}" — o
            disparo enviaria 0 mensagens. Escolha outra finalidade ou colete o
            consentimento antes.
          </p>
        )}
        {blocked && (
          <p className="text-right text-xs text-destructive">
            Há bloqueios na análise de envio. Marque "Entendo o risco" acima
            para prosseguir.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function NewCampaignPage() {
  const navigate = useNavigate();
  const { data: providersData } = useProviders();
  const { scope } = useProviderScope();
  const create = useCreateCampaign();
  // ★ `useSendFirstBatch` e não `useSendBatch(id)`: aqui o id só existe DEPOIS
  // do create, e um `setState` com o id novo não vale dentro da mesma função —
  // o hook continuaria apontando para uma campanha vazia, em silêncio.
  // Fix round 1 (#2) — `run` (useRunCampaign) foi removido: a Fase 2 nunca mais
  // o chama (ver handleConfirm), então mantê-lo só para ler `.isPending` era
  // código morto lido por dois lugares (aqui e no botão) sem nenhum efeito.
  const sendFirstBatch = useSendFirstBatch();
  const preview = usePreviewCampaign();

  // Channels grouped by provider, then narrowed to the active topbar scope:
  // a specific provider shows only its group; 'all' shows every group.
  //
  // CANAL DESATIVADO NÃO É OPÇÃO. O filtro por `isActive` acontece AQUI, na
  // origem, e não na renderização — porque `groups` também alimenta o
  // auto-select do passo 1, cujos últimos fallbacks
  // (`?? channels.find(c => c.isDefault) ?? channels[0]`) não olhavam isActive.
  // Filtrar só no JSX deixaria o canal desativado PRÉ-SELECIONADO e disparável.
  //
  // O canal desativado continua existindo (histórico, conversas) — ele só deixa
  // de ser oferecido como saída de envio. Religa-se na tela Canais.
  const groups = useMemo<ProviderGroup[]>(() => {
    const all = providersData?.providers ?? [];
    const scoped = scope === 'all' ? all : all.filter((g) => g.provider === scope);
    return scoped.map((g) => ({ ...g, channels: g.channels.filter((c) => c.isActive) }));
  }, [providersData, scope]);

  // Flattened selectable channels (respecting scope) — used for auto-select,
  // lookups and validation.
  const channels = useMemo(() => groups.flatMap((g) => g.channels), [groups]);

  const {
    step,
    setStep,
    name,
    setName,
    templateId,
    setTemplateId,
    defaultInstanceId,
    setDefaultInstanceId,
    purposeKey,
    setPurposeKey,
    variableMap,
    setVariableMap,
    filters,
    setFilters,
    schedule,
    setSchedule,
    presenceDelayMs,
    setPresenceDelayMs,
    clearDraft,
  } = useWizardDraft();

  // The provider that owns the currently-selected channel — scopes the template
  // list (templates are provider-owned) so the wizard only offers templates the
  // chosen channel can actually send.
  const selectedProvider = channels.find(
    (c) => c.id === defaultInstanceId,
  )?.provider;
  const { data: templates } = useTemplates(selectedProvider);
  // A.3 — o nome do canal escolhido, para a frase do teto de hoje no passo 4.
  const defaultInstanceName =
    channels.find((c) => c.id === defaultInstanceId)?.name ?? '';

  // C1b/C2 — as finalidades que o operador pode declarar. A finalidade é
  // OBRIGATÓRIA em qualquer provedor: o gate de dispatch consulta consentimento
  // POR FINALIDADE em todos eles, então uma campanha sem finalidade não envia
  // para ninguém — antes, o wizard liberava EVOLUTION e a campanha nascia morta,
  // em silêncio. O backend recusa com `campaign.purpose_required`.
  const { data: purposes } = useConsentPurposes();

  // Picking a channel from a *different* provider invalidates the selected
  // template (templates are provider-owned — one never belongs to another
  // provider), so drop it and its variable mapping. Switching between channels
  // of the *same* provider keeps the template.
  const handleSelectChannel = useCallback(
    (channel: Channel) => {
      const prev = channels.find((c) => c.id === defaultInstanceId);
      if (prev && prev.provider !== channel.provider) {
        setTemplateId('');
        setVariableMap({});
      }
      setDefaultInstanceId(channel.id);
    },
    [channels, defaultInstanceId, setDefaultInstanceId, setTemplateId, setVariableMap],
  );

  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);

  // Operator-accepted override for blocking send-checks. Lifted here so
  // handleConfirm can read it when assembling the create payload. The
  // send-analysis panel (step 4) drives it via setOverride.
  const [override, setOverride] = useState(false);

  // Pedido do cliente (2026-08-25) — o operador confirma, ao criar a
  // campanha, que concorda com a regra de horário comercial (8h–20h) do
  // canal. Ligado por padrão (a regra vale, a menos que o operador desligue
  // de propósito). Mesmo padrão de `override` acima: lido por handleConfirm
  // ao montar o payload de criação. Nome do campo espelha
  // `createCampaignSchema.respeitarJanelaDeEnvio`
  // (backend/src/schemas/contracts/campaign.schema.ts) — a janela só tem
  // efeito visível em canal DE SESSÃO (EVOLUTION); canais oficiais (ZERNIO em
  // produção) nunca a respeitaram.
  const [respeitarJanelaDeEnvio, setRespeitarJanelaDeEnvio] = useState(true);

  // Pedido do cliente (2026-08-25) — "excluir quem já recebeu parece não
  // funcionar": a exclusão automática (`sameTemplateExclusion`) só olhava
  // campanhas do MESMO template. Ligado, a exclusão passa a valer para
  // QUALQUER campanha anterior (Campaign.excludeAnyPreviousCampaign no
  // backend). Desligado por padrão: a régua larga mudaria a audiência de
  // quem já tinha o fluxo montado com a régua estreita. Mesmo padrão de
  // `respeitarJanelaDeEnvio` acima — lido por handleConfirm ao montar o
  // payload de criação, e descido ao passo 3 (FilterStep) para o controle na
  // tela e para a prévia levar o MESMO valor do disparo.
  const [excludeAnyPreviousCampaign, setExcludeAnyPreviousCampaign] =
    useState(false);

  // Once a campaign has been created (DRAFT) we hold onto its id so a retry of
  // the confirm action only calls the 1º lote (or the schedule branch) again —
  // never a second `create` (which would leave a duplicate orphan DRAFT). See
  // finding A12.
  const createdIdRef = useRef<string | null>(null);

  const template = templates?.find((t) => t.id === templateId);

  useCampaignWizardEffects({
    channels,
    templates,
    template,
    step,
    setStep,
    name,
    templateId,
    setTemplateId,
    defaultInstanceId,
    setDefaultInstanceId,
    variableMap,
    setVariableMap,
    filters,
    previewResult,
    setPreviewResult,
    preview,
    excludeAnyPreviousCampaign,
  });

  // The confirm handler — create-once via createdIdRef, clearDraft after a
  // successful create. See finding A12 (create-once). A.3 replaced the
  // dispatch phase: it no longer enqueues the whole audience via `run` — it
  // creates and sends the 1º LOTE via `sendFirstBatch`, and on failure sends
  // the operator to the DRAFT detail (see the catch block below — unlike the
  // old `run` path, the detail page now has a real retry action there).
  const handleConfirm = async (opts: {
    enviarPrimeiroLote: boolean;
    tamanho: number;
  }) => {
    // --- Fase 1: criar a campanha (pulada no retry) ----
    // Se uma tentativa anterior já criou a campanha, reusa o id em vez de
    // criar um segundo DRAFT (A12).
    let campaignId = createdIdRef.current;
    if (!campaignId) {
      try {
        const c = await create.mutateAsync({
          name,
          templateId,
          defaultInstanceId,
          filters,
          variableMap,
          schedule,
          timezone: TIMEZONE_DEFAULT,
          presenceDelayMs,
          override,
          respeitarJanelaDeEnvio,
          excludeAnyPreviousCampaign,
          // C1b — string vazia não é finalidade: manda `undefined` para o
          // backend aplicar a regra dele (obrigatória em canal oficial), em vez
          // de receber um '' que falharia por "min(1)" com mensagem críptica.
          purposeKey: purposeKey || undefined,
        });
        campaignId = c.id;
        createdIdRef.current = c.id;
        // A campanha já existe no servidor — descarta o rascunho local para
        // um retry nunca recriá-la.
        clearDraft();
      } catch {
        toast.error('Falha ao salvar campanha');
        return;
      }
    }

    // --- Fase 2: o 1º LOTE (A.3), ou só agendar --------------------
    //
    // `run` (POST /campaigns/:id/run) NÃO é mais chamado aqui: ele enfileira a
    // audiência INTEIRA, que é justamente o que a decisão 2 da spec proíbe por
    // padrão. Ele continua existindo para o agendador e para compatibilidade.
    //
    // Fix round 1 (CRÍTICO) — esta checagem tinha sido apagada na 1ª rodada:
    // sem ela, um ONCE_AT ("Enviar uma vez em 20/09 09:00") mandava o 1º lote
    // NA HORA e o backend (`sendBatch` → `transitionToQueued`,
    // `disarmSchedule: !isRecurring`) desarmava o agendamento — a campanha
    // simplesmente nunca esperava a data escolhida. Roda ANTES de olhar
    // `opts.enviarPrimeiroLote`: nenhum caminho de UI pode contornar isto.
    // DAILY_AT/WEEKLY/INTERVAL são recorrentes — o 1º lote sai agora e o
    // agendamento continua armado para os próximos, então seguem para a Fase 2
    // normal abaixo.
    const isRecurring =
      schedule.type === 'DAILY_AT' ||
      schedule.type === 'WEEKLY' ||
      schedule.type === 'INTERVAL';
    if (schedule.type !== 'IMMEDIATE' && !isRecurring) {
      toast.success('Campanha agendada!');
      navigate({ to: '/campaigns/$campaignId', params: { campaignId } });
      return;
    }

    if (!opts.enviarPrimeiroLote) {
      toast.success('Campanha criada — nada foi enviado ainda.');
      navigate({ to: '/campaigns/$campaignId', params: { campaignId } });
      return;
    }

    try {
      const r = await sendFirstBatch.mutateAsync({
        campaignId,
        size: opts.tamanho,
      });
      toast.success(
        `Lote ${r.seq}: ${r.queued.toLocaleString('pt-BR')} mensagens enfileiradas`,
        {
          description:
            r.remaining > 0
              ? `Restam ${r.remaining.toLocaleString('pt-BR')} para os próximos lotes.`
              : 'Não há mais ninguém nesta campanha.',
        },
      );
      navigate({ to: '/campaigns/$campaignId', params: { campaignId } });
    } catch (err) {
      // Criou mas não enviou: a campanha existe como RASCUNHO. Ao contrário
      // do antigo `run` (A12: a página de detalhe não tinha NENHUMA ação de
      // disparo para um DRAFT — navegar para lá era um beco sem saída), o
      // cabeçalho de progresso da página de detalhe (`CampaignProgressHeader`,
      // "Enviar próximo lote") já atende QUALQUER campanha não-terminal
      // (inclusive DRAFT, `pending > 0`). O operador vai para lá — com o erro
      // no toast — e retenta de lá.
      const { message } = await extractApiError(err);
      toast.error('Campanha criada, mas o 1º lote não saiu', {
        description: message,
      });
      navigate({ to: '/campaigns/$campaignId', params: { campaignId } });
    }
  };

  // Render the active step via a dispatch map. Each entry is a thunk so only
  // the active step's element is constructed.
  const steps: Record<number, () => React.ReactNode> = {
    1: () => (
      <Step1NameTemplate
        name={name}
        setName={setName}
        templateId={templateId}
        setTemplateId={setTemplateId}
        defaultInstanceId={defaultInstanceId}
        purposeKey={purposeKey}
        setPurposeKey={setPurposeKey}
        purposes={purposes}
        onSelectChannel={handleSelectChannel}
        templates={templates}
        groups={groups}
        onNext={() => setStep(2)}
      />
    ),
    2: () =>
      template ? (
        <Step2Variables
          template={template}
          variableMap={variableMap}
          setVariableMap={setVariableMap}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      ) : (
        <Step2TemplateUnavailable
          onBack={() => {
            setTemplateId('');
            setStep(1);
          }}
        />
      ),
    3: () => (
      <FilterStep
        filters={filters}
        setFilters={setFilters}
        templateId={templateId}
        excludeAnyPreviousCampaign={excludeAnyPreviousCampaign}
        setExcludeAnyPreviousCampaign={setExcludeAnyPreviousCampaign}
        onBack={() => setStep(2)}
        onNext={(r) => {
          setPreviewResult(r);
          setStep(4);
        }}
      />
    ),
    4: () =>
      previewResult && previewResult.count !== undefined ? (
        <Step4Confirm
          previewResult={previewResult}
          filters={filters}
          defaultInstanceId={defaultInstanceId}
          defaultInstanceName={defaultInstanceName}
          purposeKey={purposeKey}
          purposeLabel={purposes?.find((p) => p.key === purposeKey)?.label}
          schedule={schedule}
          setSchedule={setSchedule}
          presenceDelayMs={presenceDelayMs}
          setPresenceDelayMs={setPresenceDelayMs}
          override={override}
          setOverride={setOverride}
          respeitarJanelaDeEnvio={respeitarJanelaDeEnvio}
          setRespeitarJanelaDeEnvio={setRespeitarJanelaDeEnvio}
          excludeAnyPreviousCampaign={excludeAnyPreviousCampaign}
          create={create}
          sendFirstBatch={sendFirstBatch}
          onBack={() => setStep(3)}
          onConfirm={handleConfirm}
        />
      ) : null,
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {renderCampaignWizardHeader(step)}
      <div className="max-w-3xl">{steps[step]?.()}</div>
    </div>
  );
}

const EMPTY_SELECTION: FacetSelection = { cities: [], groups: [], tags: [] };

const EMPTY_FILTERS: FilterGroup = { combinator: 'and', rules: [] };

/**
 * B.4 — "Excluir inválidos confirmados" nasce LIGADO em campanha nova.
 *
 * Só quando não há filtro salvo: uma campanha (ou segmento) que já existe
 * carrega o recorte que o operador escolheu, e mudar o público dela sozinho
 * seria pior do que o problema. `withExcludeInvalid` é idempotente, então
 * recarregar a mesma campanha não duplica nada.
 */
export function initialCampaignFilters(
  saved: FilterGroup | null | undefined,
): FilterGroup {
  if (saved) return saved;
  return withExcludeInvalid({ combinator: 'and', rules: [] });
}

/**
 * Pure mapper: take a loaded segment (its `.filters`) and produce a FilterGroup
 * suitable for seeding the advanced FilterBuilder. The FilterBuilder attaches
 * its own internal UIDs when it receives a fresh `value`, so we just hand it a
 * deep copy of the segment's filters (or an empty AND group if the segment has
 * none). A deep copy avoids the wizard state aliasing the cached query object.
 */
export function segmentFiltersToBuilder(detail: {
  filters?: FilterGroup | null;
}): FilterGroup {
  const filters = detail.filters;
  if (!filters) return { ...EMPTY_FILTERS, rules: [] };
  return structuredClone(filters);
}

function FilterStep({
  filters,
  setFilters,
  templateId,
  excludeAnyPreviousCampaign,
  setExcludeAnyPreviousCampaign,
  onBack,
  onNext,
}: {
  filters: FilterGroup;
  setFilters: (f: FilterGroup) => void;
  /**
   * ★ O template do passo 1. Vai até a prévia porque ela precisa aplicar a
   * MESMA exclusão do disparo (spec 2026-08-12) — quem já está em outra
   * campanha deste template não entra. Sem isto a tela contaria gente que o
   * disparo não vai alcançar.
   */
  templateId: string;
  /**
   * Pedido do cliente (2026-08-25) — "excluir quem já recebeu qualquer
   * campanha anterior". Estado do `NewCampaignPage` (sobrevive ao passo 4 e
   * ao payload de `create`), descido aqui para o controle na tela e para a
   * prévia levar o MESMO valor que o disparo vai aplicar.
   */
  excludeAnyPreviousCampaign: boolean;
  setExcludeAnyPreviousCampaign: (v: boolean) => void;
  onBack: () => void;
  onNext: (r: PreviewResult) => void;
}) {
  const preview = usePreviewCampaign();
  const [mode, setMode] = useState<'facets' | 'advanced'>('facets');
  const [selection, setSelection] = useState<FacetSelection>(EMPTY_SELECTION);
  const [latestPreview, setLatestPreview] = useState<PreviewResult | null>(
    null,
  );

  // "Carregar de um segmento": the picked segment id and its loaded detail.
  const [pickedSegmentId, setPickedSegmentId] = useState<string | undefined>(
    undefined,
  );
  const segment = useSegment(pickedSegmentId);
  const [saveOpen, setSaveOpen] = useState(false);

  // F1 T7 — "Excluir quem já recebeu": the two multi-selects below materialize
  // into a single history-exclusion node (see finalFilters/materializeHistoryExclusion).
  const [excludeCampaignIds, setExcludeCampaignIds] = useState<string[]>([]);
  const [excludeTemplateIds, setExcludeTemplateIds] = useState<string[]>([]);

  // Pedido do cliente (2026-08-25) — "adicionar contato específico": contatos
  // avulsos escolhidos a dedo, somados ao público via `materializeExtraContacts`
  // (extra-contacts.ts) abaixo. Independe do modo (facets/advanced).
  const [extraContacts, setExtraContacts] = useState<ExtraContact[]>([]);

  const handleLoadSegment = () => {
    const detail = segment.data;
    if (!detail) {
      toast.error('Segmento ainda não carregou — tente novamente.');
      return;
    }
    // Copy the segment's filters into the advanced builder. The FilterBuilder
    // re-attaches its own UIDs when it gets a fresh `value`.
    setFilters(segmentFiltersToBuilder(detail));
    setMode('advanced');
    toast.success(`Filtros de "${detail.name}" carregados.`);
  };

  // Build effective filters from facets when in facets mode. Derive in render
  // rather than syncing via effect — the previous effect fired on mode toggle
  // (advanced→facets) and clobbered the operator's hand-built advanced filter
  // with the empty/default facet selection. Parent state is now updated only
  // when the operator commits via "Próximo" below.
  // O modo PADRÃO é `facets`, e nele o FilterBuilder nem é renderizado — o
  // público sai de `facetsToFilterGroup(selection)`. Sem reaplicar a exclusão
  // aqui, o toggle "ligado por padrão" valeria só no modo avançado, que quase
  // ninguém usa: a promessa de B.4 morreria no caminho mais comum.
  const effectiveFilters = useMemo(() => {
    if (mode !== 'facets') return filters;
    const base = facetsToFilterGroup(selection);
    return hasExcludeInvalid(filters) ? withExcludeInvalid(base) : base;
  }, [mode, selection, filters]);

  // F1 T7 — ANDs the history-exclusion node on top of `effectiveFilters`
  // regardless of mode/combinator. Returns `effectiveFilters` unchanged (same
  // reference) when nothing is selected — a no-op for every pre-existing flow.
  const filtersWithHistoryExclusion = useMemo(
    () =>
      materializeHistoryExclusion(
        effectiveFilters,
        excludeCampaignIds,
        excludeTemplateIds,
      ),
    [effectiveFilters, excludeCampaignIds, excludeTemplateIds],
  );

  // "Adicionar contato específico" — soma os contatos escolhidos a dedo por
  // cima de tudo (filtro + exclusão de histórico), via um OU no topo. Entram
  // mesmo que não batam com o filtro, e mesmo que já tenham recebido das
  // campanhas/templates marcados acima em "Excluir quem já recebeu".
  const finalFilters = useMemo(
    () =>
      materializeExtraContacts(
        filtersWithHistoryExclusion,
        extraContacts.map((c) => c.phoneE164),
      ),
    [filtersWithHistoryExclusion, extraContacts],
  );

  const handleRemoveChip = (key: keyof FacetSelection, value: string) => {
    setSelection({ ...selection, [key]: selection[key].filter((v) => v !== value) });
  };

  const handleClearAll = () => setSelection(EMPTY_SELECTION);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Quem vai receber?</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Selecione filtros à esquerda — a prévia atualiza ao vivo.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setMode(mode === 'facets' ? 'advanced' : 'facets')}
        >
          <Sliders className="mr-1.5 h-3.5 w-3.5" />
          {mode === 'facets' ? 'Modo avançado (AND/OR)' : 'Modo simples'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/30 p-3">
          <div className="flex-1 space-y-1">
            <Label htmlFor="load-segment" className="text-xs">
              Carregar de um segmento
            </Label>
            <SegmentPicker
              id="load-segment"
              value={pickedSegmentId}
              onChange={setPickedSegmentId}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!pickedSegmentId || segment.isFetching}
            onClick={handleLoadSegment}
          >
            {segment.isFetching ? 'Carregando…' : 'Carregar'}
          </Button>
        </div>

        <HistoryExclusionBlock
          campaignIds={excludeCampaignIds}
          templateIds={excludeTemplateIds}
          onChange={({ campaignIds, templateIds }) => {
            setExcludeCampaignIds(campaignIds);
            setExcludeTemplateIds(templateIds);
          }}
        />

        {/* Pedido do cliente (2026-08-25) — "excluir quem já recebeu parece
            não funcionar": a exclusão automática só olhava campanhas do
            MESMO modelo de mensagem. Ligado, exclui quem recebeu QUALQUER
            campanha anterior. Desligado por padrão: a régua larga mudaria a
            audiência de quem já tinha o fluxo montado com a régua estreita. */}
        <div className="flex items-start gap-2 rounded-md border p-2.5">
          <Checkbox
            id="exclude-any-previous"
            checked={excludeAnyPreviousCampaign}
            onCheckedChange={(v) => setExcludeAnyPreviousCampaign(v === true)}
          />
          <Label
            htmlFor="exclude-any-previous"
            className="cursor-pointer text-sm font-normal leading-snug"
          >
            Excluir quem já recebeu qualquer campanha anterior
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Desligado, só ficam de fora as pessoas que já receberam uma
              campanha com este mesmo modelo de mensagem.
            </span>
          </Label>
        </div>

        <ExtraContactsPicker selected={extraContacts} onChange={setExtraContacts} />

        {mode === 'facets' ? (
          <>
            <ActiveFilterChips
              selection={selection}
              onRemove={handleRemoveChip}
              onClearAll={handleClearAll}
            />

            <div className="grid gap-6 md:grid-cols-[260px_1fr]">
              <aside className="rounded-lg border p-3 md:max-h-[460px] md:overflow-y-auto">
                <FacetFilters selection={selection} onChange={setSelection} />
              </aside>
              <div>
                <LivePreview
                  filters={finalFilters}
                  templateId={templateId}
                  excludeAnyPreviousCampaign={excludeAnyPreviousCampaign}
                  onPreviewResult={setLatestPreview}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5 rounded border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <p>
                Uma <strong>regra</strong> é um critério isolado (ex.:{' '}
                <span className="font-mono">cidade = Manaus</span>). Um{' '}
                <strong>grupo</strong> reúne regras — ou outros grupos — sob um
                operador: <strong>E</strong> exige que todas as regras do grupo
                sejam verdadeiras; <strong>OU</strong> basta uma. Grupos podem
                ser aninhados dentro de outros grupos. Para a maioria dos
                casos, o modo simples atende.
              </p>
              <p>
                Exemplo: um grupo <strong>E</strong> com{' '}
                <span className="font-mono">cidade = Manaus</span> e, dentro
                dele, um grupo <strong>OU</strong> com{' '}
                <span className="font-mono">grupo = Voluntários</span> e{' '}
                <span className="font-mono">grupo = Doadores</span> seleciona
                quem é de Manaus <strong>e</strong> (Voluntários{' '}
                <strong>ou</strong> Doadores).
              </p>
            </div>
            <FilterBuilder value={filters} onChange={setFilters} />
            <LivePreview
              filters={finalFilters}
              templateId={templateId}
              excludeAnyPreviousCampaign={excludeAnyPreviousCampaign}
              onPreviewResult={setLatestPreview}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
          <div className="flex gap-2">
            <Button variant="outline" onClick={onBack}>
              Voltar
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={finalFilters.rules.length === 0}
              onClick={() => setSaveOpen(true)}
            >
              Salvar como segmento
            </Button>
          </div>
          <Button
            disabled={
              preview.isPending ||
              !latestPreview ||
              latestPreview.count === 0
            }
            onClick={async () => {
              try {
                // Commit the just-confirmed filters (facets/advanced AND'd with
                // the history-exclusion node, if any) into parent state so the
                // remaining wizard steps (and the back-navigation) see them.
                setFilters(finalFilters);
                // ★ COM O TEMPLATE. Esta prévia — não a do painel ao lado — é
                // a que vira o `previewResult` do passo 4: o título, o número do
                // painel de análise e o denominador do botão "Disparar agora".
                // Sem `templateId` ela devolvia a audiência bruta, e a tela de
                // confirmação prometia 500 onde o disparo materializa 88.
                const r = await preview.mutateAsync({
                  filters: finalFilters,
                  templateId: templateId || null,
                  excludeAnyPreviousCampaign,
                });
                onNext(r);
              } catch {
                toast.error('Falha ao gerar prévia');
              }
            }}
          >
            {preview.isPending
              ? 'Carregando…'
              : latestPreview && latestPreview.count > 0
                ? `Próximo: confirmar ${latestPreview.count}`
                : 'Próximo'}
          </Button>
        </div>
      </CardContent>

      <SaveAsSegmentDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        filters={finalFilters}
        // Reflect the just-saved segment in the "Carregar de um segmento"
        // picker so the operator sees it selected (and can reload it).
        onSaved={(segment) => setPickedSegmentId(segment.id)}
      />
    </Card>
  );
}
