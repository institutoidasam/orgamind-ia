import { z } from 'zod';

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // Sunday = 0

export const scheduleConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('IMMEDIATE'),
  }),
  z.object({
    type: z.literal('ONCE_AT'),
    runAt: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s)),
  }),
  z.object({
    type: z.literal('DAILY_AT'),
    time: z.string().regex(TIME_REGEX, 'Use formato HH:mm'),
  }),
  z.object({
    type: z.literal('WEEKLY'),
    time: z.string().regex(TIME_REGEX, 'Use formato HH:mm'),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Selecione ao menos um dia'),
  }),
  z.object({
    type: z.literal('INTERVAL'),
    everyMinutes: z.number().int().min(5, 'Intervalo mínimo 5 minutos').max(60 * 24 * 30),
  }),
]);

export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;
export type ScheduleType = ScheduleConfig['type'];

/**
 * C2 — a organização e quem opera o orgamind estão em MANAUS (UTC-4, sem horário de
 * verão), não em São Paulo. Com o default anterior (`America/Sao_Paulo`), toda
 * campanha agendada para "09:00" disparava às 08:00 locais — uma hora mais
 * cedo, todo dia, para sempre.
 *
 * O fuso é gravado POR CAMPANHA (`Campaign.timezone`), então esta troca vale
 * apenas para campanhas NOVAS: as já persistidas continuam com o fuso que
 * escolheram (o `.default()` só age quando o campo vem ausente).
 */
export const TIMEZONE_DEFAULT = 'America/Manaus';

/**
 * A user-supplied IANA timezone. Validated by attempting to build an
 * Intl.DateTimeFormat with it — this rejects garbage / non-existent zones — and
 * length-capped so a caller can't push an unbounded/exotic string into the
 * downstream Intl + computeNextRun paths. Defaults to Manaus (AMT, UTC-4).
 */
export const timezoneSchema = z
  .string()
  .max(64)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Fuso horário inválido (use uma timezone IANA, ex.: America/Sao_Paulo)' },
  )
  .default(TIMEZONE_DEFAULT);

/** Human-readable label for the schedule (used in UI/listings). */
export function describeSchedule(config: ScheduleConfig): string {
  switch (config.type) {
    case 'IMMEDIATE':
      return 'Disparo manual';
    case 'ONCE_AT':
      return `Uma vez em ${new Date(config.runAt).toLocaleString('pt-BR')}`;
    case 'DAILY_AT':
      return `Todo dia às ${config.time}`;
    case 'WEEKLY': {
      const names = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
      const days = config.weekdays.sort().map((d) => names[d]).join('/');
      return `${days} às ${config.time}`;
    }
    case 'INTERVAL': {
      const m = config.everyMinutes;
      if (m % 1440 === 0) return `A cada ${m / 1440} dia(s)`;
      if (m % 60 === 0) return `A cada ${m / 60} hora(s)`;
      return `A cada ${m} minuto(s)`;
    }
  }
}
