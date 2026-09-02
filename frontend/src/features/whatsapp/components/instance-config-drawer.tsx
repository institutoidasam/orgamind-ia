// frontend/src/features/whatsapp/components/instance-config-drawer.tsx
import { Fragment, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { extractApiError } from '@/lib/api-error';
import type { Instance } from '../schemas';
import { useUpdateInstance } from '../api';
import { InstanceBotSelect } from './instance-bot-select';

// ---------------------------------------------------------------------------
// Client-side Zod schema — mirrors backend instance config fields
// ---------------------------------------------------------------------------

export const instanceConfigFormSchema = z
  .object({
    rejectCall: z.boolean(),
    msgCall: z.string().max(200, 'Máximo 200 caracteres'),
    groupsIgnore: z.boolean(),
    alwaysOnline: z.boolean(),
    readMessages: z.boolean(),
    readStatus: z.boolean(),
    syncFullHistory: z.boolean(),
    globalPresenceDelayMs: z
      .number({ error: 'Deve ser um número' })
      .int('Deve ser inteiro')
      .min(0, 'Mínimo 0')
      .max(60_000, 'Máximo 60.000 ms'),
    globalJitterMaxMs: z
      .number({ error: 'Deve ser um número' })
      .int('Deve ser inteiro')
      .min(0, 'Mínimo 0')
      .max(60_000, 'Máximo 60.000 ms'),
    dailySendLimit: z
      .number({ error: 'Deve ser um número' })
      .int('Deve ser inteiro')
      .min(1, 'Mínimo 1')
      .max(5_000, 'Máximo 5.000'),
    sendWindowStartHour: z
      .number({ error: 'Deve ser um número' })
      .int('Deve ser inteiro')
      .min(0, 'Mínimo 0')
      .max(23, 'Máximo 23'),
    sendWindowEndHour: z
      .number({ error: 'Deve ser um número' })
      .int('Deve ser inteiro')
      .min(0, 'Mínimo 0')
      .max(23, 'Máximo 23'),
    sendWindowEnabled: z.boolean(),
  })
  // Only enforce start < end while the window is enabled; a disabled window
  // must never block saving (its hours are inert). Mirrors the backend, which
  // treats start === end as invalid too (strict <).
  .refine((d) => !d.sendWindowEnabled || d.sendWindowStartHour < d.sendWindowEndHour, {
    message: 'Hora de início deve ser menor que hora de fim',
    path: ['sendWindowStartHour'],
  });

type InstanceConfigForm = z.infer<typeof instanceConfigFormSchema>;

// ---------------------------------------------------------------------------
// Default values used when instance fields are not yet set
// ---------------------------------------------------------------------------

export const DEFAULTS: InstanceConfigForm = {
  rejectCall: true,
  msgCall: '',
  groupsIgnore: true,
  alwaysOnline: false,
  readMessages: false,
  readStatus: false,
  syncFullHistory: false,
  globalPresenceDelayMs: 3000,
  globalJitterMaxMs: 5000,
  dailySendLimit: 500,
  sendWindowStartHour: 8,
  sendWindowEndHour: 20,
  sendWindowEnabled: true,
};

// ---------------------------------------------------------------------------
// Recommended values
// ---------------------------------------------------------------------------
//
// RECOMMENDED is derived from DEFAULTS rather than copied byte-for-byte: the
// two were identical and silently drifting was a hazard. Put any value that the
// anti-ban "recommended" preset should diverge from the plain default into the
// overrides below; an empty overrides object means "recommended === default".

const RECOMMENDED_OVERRIDES: Partial<InstanceConfigForm> = {};

export const RECOMMENDED: InstanceConfigForm = {
  ...DEFAULTS,
  ...RECOMMENDED_OVERRIDES,
};

// ---------------------------------------------------------------------------
// Map an Instance to form values, falling back to DEFAULTS for any field the
// instance has not set yet. Iterating the DEFAULTS keys keeps this in lock-step
// with the schema (no per-field `?? DEFAULTS.x` chain to drift) and produces the
// exact same payload the open-triggered reset used to build inline.
// ---------------------------------------------------------------------------

function instanceToFormValues(i: Instance): InstanceConfigForm {
  const out = {} as InstanceConfigForm;
  for (const key of Object.keys(DEFAULTS) as (keyof InstanceConfigForm)[]) {
    const value = (i as Partial<InstanceConfigForm>)[key];
    // `?? DEFAULTS[key]` mirrors the previous per-field fallback exactly:
    // null/undefined → default; false/0/'' are preserved.
    (out[key] as InstanceConfigForm[typeof key]) =
      (value ?? DEFAULTS[key]) as InstanceConfigForm[typeof key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helper: show "Recomendado: X" badge when current != recommended
// ---------------------------------------------------------------------------

function RecommendedBadge({
  currentValue,
  recommendedValue,
}: {
  currentValue: unknown;
  recommendedValue: unknown;
}) {
  if (currentValue === recommendedValue) return null;
  const label =
    typeof recommendedValue === 'boolean'
      ? recommendedValue
        ? 'Sim'
        : 'Não'
      : String(recommendedValue);
  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 border border-amber-200">
      ★ Recomendado: {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: toggle row with optional recommended badge
// ---------------------------------------------------------------------------

function ToggleRow({
  label,
  hint,
  checked,
  onCheckedChange,
  currentValue,
  recommendedValue,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  currentValue: boolean;
  recommendedValue: boolean;
}) {
  return (
    <label className="flex items-start gap-3 text-sm cursor-pointer">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
      />
      <span className="flex-1 space-y-0.5">
        <span className="flex items-center gap-2 flex-wrap">
          <span className="block font-medium">{label}</span>
          <RecommendedBadge
            currentValue={currentValue}
            recommendedValue={recommendedValue}
          />
        </span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: numeric input row with recommended badge
// ---------------------------------------------------------------------------

function NumericRow({
  id,
  label,
  hint,
  value,
  onChange,
  currentValue,
  recommendedValue,
  error,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  currentValue: number;
  recommendedValue: number;
  error?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <RecommendedBadge
          currentValue={currentValue}
          recommendedValue={recommendedValue}
        />
      </div>
      <Input
        id={id}
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-40"
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field configs — the toggle/numeric rows are data-driven so the main render
// stays flat. Each entry carries everything a row needs; the render just maps.
// ---------------------------------------------------------------------------

type BooleanFieldKey = {
  [K in keyof InstanceConfigForm]: InstanceConfigForm[K] extends boolean ? K : never;
}[keyof InstanceConfigForm];

type NumericFieldKey = {
  [K in keyof InstanceConfigForm]: InstanceConfigForm[K] extends number ? K : never;
}[keyof InstanceConfigForm];

type ToggleFieldConfig = {
  field: BooleanFieldKey;
  label: string;
  hint: string;
};

type NumericFieldConfig = {
  field: NumericFieldKey;
  label: string;
  // `hint` may depend on live form/instance state, so it is a function.
  hint: (ctx: { values: InstanceConfigForm; instance: Instance }) => string;
};

const TOGGLE_FIELDS: ToggleFieldConfig[] = [
  {
    field: 'rejectCall',
    label: 'Rejeitar chamadas',
    hint: 'Encerra automaticamente ligações de voz/vídeo recebidas.',
  },
  {
    field: 'groupsIgnore',
    label: 'Ignorar grupos',
    hint: 'O bot não processa mensagens recebidas em grupos.',
  },
  {
    field: 'alwaysOnline',
    label: 'Sempre online',
    hint: "Mantém o status visível como 'online' enquanto conectado.",
  },
  {
    field: 'readMessages',
    label: 'Marcar mensagens como lidas',
    hint: 'Auto-marca toda mensagem recebida como lida (2 ticks azuis).',
  },
  {
    field: 'readStatus',
    label: 'Marcar stories como vistos',
    hint: 'Auto-visualiza os status (Stories) dos contatos.',
  },
  {
    field: 'syncFullHistory',
    label: 'Sincronizar histórico completo',
    hint: 'Importa todo o histórico de conversas ao conectar. Lento e intensivo.',
  },
];

const NUMERIC_FIELDS: NumericFieldConfig[] = [
  {
    field: 'globalPresenceDelayMs',
    label: 'Delay mínimo entre mensagens (ms)',
    hint: () => "Tempo de 'digitando…' antes de cada mensagem.",
  },
  {
    field: 'globalJitterMaxMs',
    label: 'Jitter aleatório máximo (ms)',
    hint: () =>
      'Variação aleatória adicionada ao delay para quebrar padrões previsíveis.',
  },
  {
    field: 'dailySendLimit',
    label: 'Limite diário de envios',
    hint: ({ values, instance }) =>
      `Enviadas hoje: ${instance.sentToday} / ${values.dailySendLimit}. ` +
      'Em números oficiais (Twilio), ajuste ao tier atual do WhatsApp ' +
      '(número novo = 250/dia, sobe para 1k/10k/100k). O excedente da ' +
      'campanha é adiado automaticamente para as próximas 24h.',
  },
];

// ---------------------------------------------------------------------------
// Sub-component: send-window enable + hour range, with divergence badge
// ---------------------------------------------------------------------------

function SendWindowRow({
  enabled,
  startHour,
  endHour,
  onEnabledChange,
  onStartHourChange,
  onEndHourChange,
  error,
}: {
  enabled: boolean;
  startHour: number;
  endHour: number;
  onEnabledChange: (v: boolean) => void;
  onStartHourChange: (v: number) => void;
  onEndHourChange: (v: number) => void;
  error?: string;
}) {
  const diverges =
    enabled !== RECOMMENDED.sendWindowEnabled ||
    startHour !== RECOMMENDED.sendWindowStartHour ||
    endHour !== RECOMMENDED.sendWindowEndHour;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Janela de envio</span>
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <Checkbox
          checked={enabled}
          onCheckedChange={(v) => onEnabledChange(v === true)}
        />
        <span>
          Apenas entre{' '}
          <input
            type="number"
            className="mx-1 w-14 rounded border px-1 text-center text-sm"
            value={startHour}
            min={0}
            max={23}
            onChange={(e) => onStartHourChange(Number(e.target.value))}
            disabled={!enabled}
          />
          :00 e{' '}
          <input
            type="number"
            className="mx-1 w-14 rounded border px-1 text-center text-sm"
            value={endHour}
            min={0}
            max={23}
            onChange={(e) => onEndHourChange(Number(e.target.value))}
            disabled={!enabled}
          />
          :00 (BRT)
          {diverges && (
            <RecommendedBadge
              currentValue={`${startHour}–${endHour}`}
              recommendedValue={`${RECOMMENDED.sendWindowStartHour}–${RECOMMENDED.sendWindowEndHour}`}
            />
          )}
        </span>
      </label>
      {error && <p className="text-xs text-destructive pl-6">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  instance: Instance;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function InstanceConfigDrawer({ instance, open, onOpenChange }: Props) {
  const update = useUpdateInstance(instance.id);

  const form = useForm<InstanceConfigForm>({
    resolver: zodResolver(instanceConfigFormSchema),
    defaultValues: DEFAULTS,
  });

  const {
    register,
    watch,
    setValue,
    handleSubmit,
    reset,
    formState: { errors },
  } = form;
  const watched = watch();

  // Keep the latest instance accessible to the open-triggered reset without
  // making the reset re-run on every poll refresh.
  const instanceRef = useRef(instance);
  instanceRef.current = instance;

  // Sync the form from instance data only when the drawer (re)opens or the
  // selected instance changes — NOT on every poll refresh. The instances list
  // refetches sentToday/connection state every ~30s; resetting on those volatile
  // changes would silently wipe the operator's unsaved edits mid-session.
  useEffect(() => {
    if (!open) return;
    reset(instanceToFormValues(instanceRef.current));
  }, [open, instance.id, reset]);

  const onSubmit = async (values: InstanceConfigForm) => {
    try {
      await update.mutateAsync(values);
      toast.success('Configurações salvas.');
      onOpenChange(false);
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configurações — {instance.name}</DialogTitle>
          <DialogDescription>
            Configurações anti-ban para esta instância. Disponível somente com Evolution.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2">
          <InstanceBotSelect instanceId={instance.id} currentDifyAppId={instance.botDifyAppId ?? null} />
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="mt-2 space-y-6">
          {/* ── Grupo 1: Aparelho ──────────────────────────────────────────── */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Aparelho — comportamento na UI
            </legend>

            {TOGGLE_FIELDS.map((cfg) => (
              <Fragment key={cfg.field}>
                <ToggleRow
                  label={cfg.label}
                  hint={cfg.hint}
                  checked={watched[cfg.field]}
                  onCheckedChange={(v) => setValue(cfg.field, v)}
                  currentValue={watched[cfg.field]}
                  recommendedValue={RECOMMENDED[cfg.field]}
                />
                {/* msgCall is nested under rejectCall, so it renders right
                    after that toggle and is disabled while rejectCall is off. */}
                {cfg.field === 'rejectCall' && (
                  <div className="space-y-1 pl-7">
                    <Label htmlFor="msgCall">Mensagem na chamada rejeitada</Label>
                    <Input
                      id="msgCall"
                      {...register('msgCall')}
                      placeholder="Não atendemos chamadas — envie uma mensagem."
                      disabled={!watched.rejectCall}
                    />
                    {errors.msgCall && (
                      <p className="text-xs text-destructive">
                        {errors.msgCall.message}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Texto enviado após rejeição. Máximo 200 caracteres.
                    </p>
                  </div>
                )}
              </Fragment>
            ))}
          </fieldset>

          {/* ── Grupo 2: Pacing & Limites ──────────────────────────────────── */}
          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Pacing & limites — anti-ban
            </legend>

            {NUMERIC_FIELDS.map((cfg) => (
              <NumericRow
                key={cfg.field}
                id={cfg.field}
                label={cfg.label}
                hint={cfg.hint({ values: watched, instance })}
                value={watched[cfg.field]}
                onChange={(v) => setValue(cfg.field, v)}
                currentValue={watched[cfg.field]}
                recommendedValue={RECOMMENDED[cfg.field]}
                error={errors[cfg.field]?.message}
              />
            ))}

            <SendWindowRow
              enabled={watched.sendWindowEnabled}
              startHour={watched.sendWindowStartHour}
              endHour={watched.sendWindowEndHour}
              onEnabledChange={(v) => setValue('sendWindowEnabled', v)}
              onStartHourChange={(v) => setValue('sendWindowStartHour', v)}
              onEndHourChange={(v) => setValue('sendWindowEndHour', v)}
              error={errors.sendWindowStartHour?.message}
            />
          </fieldset>

          {/* ── Actions ────────────────────────────────────────────────────── */}
          <div className="flex items-center justify-end pt-2 border-t gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={update.isPending}>
              {update.isPending ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
        </form>
        {/* Save errors are surfaced once, via the toast raised in onSubmit. */}
      </DialogContent>
    </Dialog>
  );
}
