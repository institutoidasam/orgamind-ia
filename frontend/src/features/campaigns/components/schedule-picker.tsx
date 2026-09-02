import { useMemo } from 'react';
import { Calendar, Clock, Repeat, Rocket, Timer } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import type { ScheduleConfig, ScheduleType } from '../schemas';

// Brazil dropped DST in 2019, so America/Sao_Paulo is a fixed -03:00. Keeping
// the offset as a string lets us bind datetime-local input directly to that
// zone without dragging in date-fns-tz on the frontend.
const SAO_PAULO_TZ = 'America/Sao_Paulo';
const SAO_PAULO_OFFSET = '-03:00';

type Props = {
  value: ScheduleConfig;
  onChange: (v: ScheduleConfig) => void;
};

const WEEKDAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const OPTIONS: Array<{
  type: ScheduleType;
  icon: React.ReactNode;
  title: string;
  hint: string;
}> = [
  {
    type: 'IMMEDIATE',
    icon: <Rocket className="h-4 w-4" />,
    title: 'Disparar agora',
    hint: 'Mensagens enviadas imediatamente após você clicar em "Disparar".',
  },
  {
    type: 'ONCE_AT',
    icon: <Calendar className="h-4 w-4" />,
    title: 'Agendar uma vez',
    hint: 'Em uma data e hora específicas.',
  },
  {
    type: 'DAILY_AT',
    icon: <Clock className="h-4 w-4" />,
    title: 'Todo dia',
    hint: 'Repete diariamente no mesmo horário.',
  },
  {
    type: 'WEEKLY',
    icon: <Repeat className="h-4 w-4" />,
    title: 'Em dias da semana',
    hint: 'Ex.: toda segunda e quarta às 09:00.',
  },
  {
    type: 'INTERVAL',
    icon: <Timer className="h-4 w-4" />,
    title: 'A cada X minutos/horas',
    hint: 'Repete em intervalos regulares (mín. 5 min).',
  },
];

export function SchedulePicker({ value, onChange }: Props) {
  const handlePickType = (type: ScheduleType) => {
    if (type === value.type) return;
    switch (type) {
      case 'IMMEDIATE':
        return onChange({ type: 'IMMEDIATE' });
      case 'ONCE_AT':
        return onChange({
          type: 'ONCE_AT',
          runAt: defaultFutureDate(),
        });
      case 'DAILY_AT':
        return onChange({ type: 'DAILY_AT', time: '09:00' });
      case 'WEEKLY':
        return onChange({ type: 'WEEKLY', time: '09:00', weekdays: [1] });
      case 'INTERVAL':
        return onChange({ type: 'INTERVAL', everyMinutes: 60 });
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Quando disparar?</h3>
        <p className="text-xs text-muted-foreground">
          Escolha entre disparo imediato, agendado ou recorrente.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {OPTIONS.map((opt) => {
          const active = opt.type === value.type;
          return (
            <button
              key={opt.type}
              type="button"
              onClick={() => handlePickType(opt.type)}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                active
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                  : 'border-border bg-card hover:border-primary/40'
              }`}
            >
              <div
                className={`mt-0.5 rounded-md p-1.5 ${
                  active ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground'
                }`}
              >
                {opt.icon}
              </div>
              <div className="flex-1 space-y-0.5">
                <div className="text-sm font-medium">{opt.title}</div>
                <div className="text-xs text-muted-foreground">{opt.hint}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Inputs per type */}
      <div className="rounded-lg border bg-muted/20 p-3">
        {value.type === 'IMMEDIATE' && (
          <p className="text-sm text-muted-foreground">
            <Rocket className="-mt-0.5 mr-1 inline h-3.5 w-3.5" />
            Sem agendamento. O envio começa quando você clicar em
            <strong> Disparar agora</strong>.
          </p>
        )}

        {value.type === 'ONCE_AT' && (
          <div className="space-y-1.5">
            <Label htmlFor="once-runAt">Data e hora</Label>
            <Input
              id="once-runAt"
              type="datetime-local"
              value={toLocalDatetime(value.runAt)}
              onChange={(e) =>
                onChange({
                  type: 'ONCE_AT',
                  runAt: parseSaoPauloDatetimeLocal(e.target.value),
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Fuso: America/Sao_Paulo
            </p>
          </div>
        )}

        {value.type === 'DAILY_AT' && (
          <div className="space-y-1.5">
            <Label htmlFor="daily-time">Horário</Label>
            <Input
              id="daily-time"
              type="time"
              className="w-32"
              value={value.time}
              onChange={(e) => onChange({ type: 'DAILY_AT', time: e.target.value })}
            />
          </div>
        )}

        {value.type === 'WEEKLY' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="weekly-time">Horário</Label>
              <Input
                id="weekly-time"
                type="time"
                className="w-32"
                value={value.time}
                onChange={(e) =>
                  onChange({
                    type: 'WEEKLY',
                    time: e.target.value,
                    weekdays: value.weekdays,
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Dias da semana</Label>
              <div className="flex gap-1">
                {WEEKDAY_NAMES.map((label, idx) => {
                  const checked = value.weekdays.includes(idx);
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        const set = new Set(value.weekdays);
                        if (checked) set.delete(idx);
                        else set.add(idx);
                        onChange({
                          type: 'WEEKLY',
                          time: value.time,
                          weekdays: [...set].sort(),
                        });
                      }}
                      className={`h-9 w-12 rounded-md border text-xs font-medium transition-colors ${
                        checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background hover:border-primary/40'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {value.type === 'INTERVAL' && (
          <IntervalEditor value={value} onChange={onChange} />
        )}
      </div>

      <SchedulePreview config={value} />
    </div>
  );
}

function IntervalEditor({
  value,
  onChange,
}: {
  value: Extract<ScheduleConfig, { type: 'INTERVAL' }>;
  onChange: (v: ScheduleConfig) => void;
}) {
  // Express the interval in the user's preferred unit, but always store minutes
  const { unit, amount } = useMemo(() => {
    const m = value.everyMinutes;
    if (m % 1440 === 0) return { unit: 'days', amount: m / 1440 };
    if (m % 60 === 0) return { unit: 'hours', amount: m / 60 };
    return { unit: 'minutes', amount: m };
  }, [value.everyMinutes]);

  const setBoth = (a: number, u: string) => {
    const minutes = u === 'days' ? a * 1440 : u === 'hours' ? a * 60 : a;
    onChange({ type: 'INTERVAL', everyMinutes: Math.max(5, minutes) });
  };

  return (
    <div className="space-y-1.5">
      <Label>A cada</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          className="w-24"
          value={amount}
          onChange={(e) => setBoth(Number(e.target.value || 1), unit)}
        />
        <select
          value={unit}
          onChange={(e) => setBoth(amount, e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="minutes">minutos</option>
          <option value="hours">horas</option>
          <option value="days">dias</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Equivale a {value.everyMinutes} minuto(s). Mínimo 5 min.
      </p>
    </div>
  );
}

function SchedulePreview({ config }: { config: ScheduleConfig }) {
  const runs = useMemo(() => previewNextRuns(config, 3), [config]);
  if (runs.length === 0) return null;
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Próximas execuções (preview)
      </div>
      <div className="flex flex-wrap gap-1.5">
        {runs.map((d, i) => (
          <Badge key={i} variant="secondary" className="font-mono text-xs">
            {d.toLocaleString('pt-BR', {
              dateStyle: 'short',
              timeStyle: 'short',
              // Render in the same zone the backend will execute in, so the
              // operator doesn't see "preview at 11:00" then a real run at
              // 14:00 just because their browser is in UTC.
              timeZone: SAO_PAULO_TZ,
            })}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function defaultFutureDate(): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 30);
  d.setSeconds(0);
  return d;
}

/**
 * Format a UTC `Date` as a `YYYY-MM-DDTHH:mm` string in São Paulo time so the
 * datetime-local input shows the moment as-it-will-execute in BRT regardless
 * of the operator's browser timezone.
 */
function toLocalDatetime(date: Date): string {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: SAO_PAULO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * Parse a `<input type="datetime-local">` value as São Paulo time. The native
 * input emits an unzoned `YYYY-MM-DDTHH:mm`; passing it to `new Date()`
 * implicitly treats it as the *browser's* timezone, which silently shifted
 * the runAt by hours for any operator outside BRT.
 */
function parseSaoPauloDatetimeLocal(value: string): Date {
  if (!value) return new Date(NaN);
  // datetime-local always emits HH:mm; append :00 + offset so it parses as UTC-3.
  return new Date(`${value}:00${SAO_PAULO_OFFSET}`);
}

/**
 * The São Paulo calendar date (Y/M/D, weekday) for an instant. Brazil has no
 * DST since 2019, so the zone is a fixed -03:00; we still resolve the calendar
 * fields through Intl so the *date* rolls over at São Paulo midnight, not the
 * operator's local midnight.
 */
function saoPauloParts(d: Date): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  );
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday as string],
  };
}

/** Build the UTC instant for a São Paulo wall-clock date + time (fixed -03:00). */
function saoPauloInstant(
  year: number,
  month: number,
  day: number,
  hh: number,
  mm: number,
): Date {
  const yyyy = String(year).padStart(4, '0');
  const MM = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const HH = String(hh).padStart(2, '0');
  const min = String(mm).padStart(2, '0');
  return new Date(`${yyyy}-${MM}-${dd}T${HH}:${min}:00${SAO_PAULO_OFFSET}`);
}

/**
 * Compute next `count` runs for the preview. Recurring schedules (DAILY/WEEKLY)
 * are anchored to São Paulo wall-clock time — the zone the backend executes in
 * and the zone the badges render in — so an operator outside BRT (e.g. Manaus,
 * UTC-4) sees "09:00", not a value shifted by their browser's offset. Server is
 * the source of truth; this is user-facing feedback only.
 */
export function previewNextRuns(config: ScheduleConfig, count: number): Date[] {
  const runs: Date[] = [];
  const now = new Date();
  switch (config.type) {
    case 'IMMEDIATE':
      return [];
    case 'ONCE_AT': {
      const d = new Date(config.runAt);
      return d.getTime() > now.getTime() ? [d] : [];
    }
    case 'DAILY_AT': {
      const [hh, mm] = config.time.split(':').map(Number);
      // Walk São Paulo calendar days forward, building the instant for each.
      let dayOffset = 0;
      let safety = 0;
      while (runs.length < count && safety++ < 366) {
        const c = addSaoPauloDays(now, hh, mm, dayOffset);
        if (c.getTime() > now.getTime()) runs.push(c);
        dayOffset++;
      }
      return runs;
    }
    case 'WEEKLY': {
      const [hh, mm] = config.time.split(':').map(Number);
      const days = new Set(config.weekdays);
      let safety = 0;
      let dayOffset = 0;
      while (runs.length < count && safety++ < 366) {
        const c = addSaoPauloDays(now, hh, mm, dayOffset);
        const weekday = saoPauloParts(c).weekday;
        if (days.has(weekday) && c.getTime() > now.getTime()) {
          runs.push(c);
        }
        dayOffset++;
      }
      return runs;
    }
    case 'INTERVAL': {
      let cursor = new Date(now.getTime() + config.everyMinutes * 60_000);
      for (let i = 0; i < count; i++) {
        runs.push(new Date(cursor));
        cursor = new Date(cursor.getTime() + config.everyMinutes * 60_000);
      }
      return runs;
    }
  }
}

/**
 * The instant for "São Paulo date(today + dayOffset) at hh:mm". The date part is
 * derived in São Paulo so the offset is applied to the right calendar day.
 */
function addSaoPauloDays(from: Date, hh: number, mm: number, dayOffset: number): Date {
  // Take São Paulo's calendar date for `from`, advance it by dayOffset *days*
  // using a noon UTC anchor (safe from any offset rollover), then re-read the
  // São Paulo date and build the instant at the requested wall-clock time.
  const sp = saoPauloParts(from);
  const anchor = new Date(Date.UTC(sp.year, sp.month - 1, sp.day + dayOffset, 12, 0, 0));
  const target = saoPauloParts(anchor);
  return saoPauloInstant(target.year, target.month, target.day, hh, mm);
}
