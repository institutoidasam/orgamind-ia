import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AUTHORIZATION_SOURCE_LABEL,
  todayInManaus,
  type AuthorizationChoice,
  type AuthorizationSource,
} from '../authorization';

type Props = {
  /** `null` = nada escolhido: o campo é obrigatório e não vem pré-marcado. */
  value: AuthorizationChoice | null;
  onChange: (value: AuthorizationChoice) => void;
  error?: string;
};

const SOURCES = Object.keys(AUTHORIZATION_SOURCE_LABEL) as AuthorizationSource[];
const NO_AUTHORIZATION_LABEL = 'Sem autorização registrada';

type DetailsProps = { id: string; value: AuthorizationChoice; onChange: Props['onChange'] };

function AuthorizationDetails({ id, value, onChange }: DetailsProps) {
  if (value.status === 'NAO_AUTORIZADO') {
    return <p className="text-xs text-muted-foreground">Esta pessoa não receberá mensagens até a autorização ser registrada</p>;
  }
  return (
    <div className="space-y-2">
      {value.source === 'OUTRO' && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-note`}>Descreva a origem</Label>
          <Input
            id={`${id}-note`}
            required
            maxLength={120}
            value={value.note ?? ''}
            onChange={(e) => onChange({ ...value, note: e.target.value })}
          />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor={`${id}-date`}>Data da autorização</Label>
        <Input
          id={`${id}-date`}
          type="date"
          max={todayInManaus()}
          value={value.date}
          onChange={(e) => onChange({ ...value, date: e.target.value })}
        />
      </div>
    </div>
  );
}

/** Autorização de contato da pessoa: criação e edição; sem valor pré-marcado (spec A2). */
export function AuthorizationField({ value, onChange, error }: Props) {
  const id = useId();
  const errorId = `${id}-error`;
  const chooseSource = (source: AuthorizationSource) => {
    const previous = value?.status === 'AUTORIZADO' ? value : null;
    onChange({
      status: 'AUTORIZADO',
      source,
      ...(source === 'OUTRO' && previous?.note ? { note: previous.note } : {}),
      date: previous?.date || todayInManaus(),
    });
  };
  const checkedSource = value?.status === 'AUTORIZADO' ? value.source : null;
  return (
    <fieldset className="space-y-2" aria-required aria-describedby={error ? errorId : undefined}>
      <legend className="text-sm font-medium">Autorização de contato</legend>
      <div role="radiogroup" aria-label="Autorização de contato" className="space-y-1">
        {SOURCES.map((source) => (
          <label key={source} className="flex items-center gap-2 text-sm">
            <input type="radio" name={id} checked={checkedSource === source} onChange={() => chooseSource(source)} />
            {AUTHORIZATION_SOURCE_LABEL[source]}
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={id}
            checked={value?.status === 'NAO_AUTORIZADO'}
            onChange={() => onChange({ status: 'NAO_AUTORIZADO' })}
          />
          {NO_AUTHORIZATION_LABEL}
        </label>
      </div>
      {value && <AuthorizationDetails id={id} value={value} onChange={onChange} />}
      {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
    </fieldset>
  );
}
