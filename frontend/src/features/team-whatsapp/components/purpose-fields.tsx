import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BASE_LABEL, INCLUDE_OFF_LABEL, PURPOSE_LABEL } from '../labels';
import { PURPOSE_RULES } from '../purpose';
import type { TeamAudienceBase, TeamPurpose } from '../schemas';
import { offAvailable, type SendFilters } from '../use-send-filters';

const PLACE_MAX = 120;
const URGENCY_REASON_MAX = 200;
const ALIGNMENT_ACTIVITY_HINT = 'Opcional: se informar a atividade, a data e a hora são obrigatórias.';

type Props = {
  filters: Pick<
    SendFilters,
    | 'purpose' | 'base' | 'includeOff' | 'activity' | 'urgencyReason'
    | 'pickPurpose' | 'pickBase' | 'toggleOff' | 'pickActivity' | 'pickUrgencyReason'
  >;
};

type ChoiceProps<T extends string> = {
  id: string;
  label: string;
  value: T;
  options: readonly T[];
  names: Record<T, string>;
  onChange: (value: T) => void;
};

function Choice<T extends string>({ id, label, value, options, names, onChange }: ChoiceProps<T>) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((option) => <SelectItem key={option} value={option}>{names[option]}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

const PURPOSES = Object.keys(PURPOSE_LABEL) as TeamPurpose[];

/** A base só tem controle onde há escolha (Alinhamento); nas outras finalidades aparece como texto (F1). */
function BaseField({ purpose, base, onChange }: { purpose: TeamPurpose; base: TeamAudienceBase; onChange: (base: TeamAudienceBase) => void }) {
  const { bases } = PURPOSE_RULES[purpose];
  if (bases.length > 1) {
    return <Choice id="team-whatsapp-base" label="Base do público" value={base} options={bases} names={BASE_LABEL} onChange={onChange} />;
  }
  return <p className="text-sm">{`Base do público: ${BASE_LABEL[base]}`}</p>;
}

type TextFieldProps = { id: string; label: string; type?: string; value: string; max?: number; onChange: (value: string) => void };

function TextField({ id, label, type, value, max, onChange }: TextFieldProps) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function ActivityFields({ filters }: Props) {
  const { activity, purpose, pickActivity } = filters;
  return (
    <div role="group" aria-label="Atividade" className="space-y-2">
      {PURPOSE_RULES[purpose].activity === 'optional' && (
        <p className="text-sm text-muted-foreground">{ALIGNMENT_ACTIVITY_HINT}</p>
      )}
      <div className="flex flex-wrap gap-3">
        <TextField
          id="team-whatsapp-activity-date" label="Data da atividade" type="date" value={activity.date}
          onChange={(date) => pickActivity({ date })}
        />
        <TextField
          id="team-whatsapp-activity-time" label="Hora de início" type="time" value={activity.time}
          onChange={(time) => pickActivity({ time })}
        />
        <TextField
          id="team-whatsapp-activity-place" label="Local" value={activity.place} max={PLACE_MAX}
          onChange={(place) => pickActivity({ place })}
        />
      </div>
    </div>
  );
}

/** Primeiro bloco da tela de envio: a finalidade e o que ela pede (base, folga, atividade, motivo). F1 da spec. */
export function PurposeFields({ filters }: Props) {
  const { purpose, base, includeOff } = filters;
  const rule = PURPOSE_RULES[purpose];
  return (
    <div className="space-y-3">
      <Choice
        id="team-whatsapp-purpose" label="Finalidade" value={purpose} options={PURPOSES} names={PURPOSE_LABEL}
        onChange={filters.pickPurpose}
      />
      <BaseField purpose={purpose} base={base} onChange={filters.pickBase} />
      {offAvailable(purpose, base) && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="team-whatsapp-purpose-off" checked={includeOff}
            onCheckedChange={(on) => filters.toggleOff(on === true)}
          />
          <Label htmlFor="team-whatsapp-purpose-off">{INCLUDE_OFF_LABEL}</Label>
        </div>
      )}
      {rule.activity !== 'none' && <ActivityFields filters={filters} />}
      {rule.urgencyReason && (
        <TextField
          id="team-whatsapp-urgency-reason" label="Motivo da urgência" value={filters.urgencyReason}
          max={URGENCY_REASON_MAX} onChange={filters.pickUrgencyReason}
        />
      )}
    </div>
  );
}
