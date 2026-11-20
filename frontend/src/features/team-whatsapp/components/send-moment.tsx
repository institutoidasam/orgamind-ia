import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addDays } from "@/lib/civil-date";
import type { Moment } from "../use-send-filters";

/** Até quantos dias à frente se agenda "Data e hora" (G1); o servidor recusa além disso (`schedule_too_far`). */
export const MAX_SCHEDULE_DAYS = 30;

const MOMENT_LABEL: Record<Moment["when"], string> = {
  now: "Agora",
  shift_start: "No início do turno",
  at: "Data e hora",
};

const EMPTY_AT = { date: "", time: "" };

/** Momento que o diálogo oferece; `disabled` = aparece mas não dá para escolher (o motivo fica no diálogo). */
export type MomentOption = { when: Moment["when"]; disabled?: boolean };

type AtFieldsProps = {
  at: NonNullable<Moment["at"]>;
  today: string;
  onChange: (at: NonNullable<Moment["at"]>) => void;
};

/** Data entre hoje e hoje + 30 dias (a de hoje vem do servidor, fuso de Manaus) e hora em HH:mm. */
function AtFields({ at, today, onChange }: AtFieldsProps) {
  return (
    <div className="flex flex-wrap gap-3">
      <div className="space-y-1">
        <Label htmlFor="team-whatsapp-at-date">Data do envio</Label>
        <Input
          id="team-whatsapp-at-date"
          type="date"
          min={today}
          max={addDays(today, MAX_SCHEDULE_DAYS)}
          value={at.date}
          onChange={(e) => onChange({ ...at, date: e.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="team-whatsapp-at-time">Hora do envio</Label>
        <Input
          id="team-whatsapp-at-time"
          type="time"
          value={at.time}
          onChange={(e) => onChange({ ...at, time: e.target.value })}
        />
      </div>
    </div>
  );
}

type Props = {
  value: Moment;
  onChange: (next: Moment) => void;
  options: readonly MomentOption[];
  /** Hoje no fuso de Manaus, como o servidor o manda (`targets.today`). */
  today: string;
};

/**
 * "Momento do disparo" (G1): Agora, No início do turno e Data e hora, só os que a finalidade e o alvo permitem
 * (`options`). Com "Data e hora" aparecem a data e a hora do envio.
 */
export function SendMoment({ value, onChange, options, today }: Props) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Momento do disparo</legend>
      <div className="flex flex-wrap gap-4">
        {options.map(({ when, disabled }) => (
          <label key={when} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="team-whatsapp-moment"
              value={when}
              checked={value.when === when}
              disabled={disabled}
              onChange={() =>
                onChange({ when, at: when === "at" ? EMPTY_AT : null })
              }
            />
            {MOMENT_LABEL[when]}
          </label>
        ))}
      </div>
      {value.when === "at" && (
        <AtFields
          at={value.at ?? EMPTY_AT}
          today={today}
          onChange={(at) => onChange({ when: "at", at })}
        />
      )}
    </fieldset>
  );
}
