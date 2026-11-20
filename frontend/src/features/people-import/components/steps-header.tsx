import { Badge } from '@/components/ui/badge';

export type ImportStep = 1 | 2 | 3 | 4;

const STEPS = ['Arquivo', 'Colunas', 'Prévia', 'Resultado'] as const;

/** Os quatro passos da importação (spec E1), com o atual em destaque; o texto é "1. Arquivo" etc. */
export function StepsHeader({ current }: { current: ImportStep }) {
  return (
    <ol aria-label="Passos da importação" className="flex flex-wrap gap-2">
      {STEPS.map((label, index) => {
        const active = index + 1 === current;
        return (
          <li key={label} aria-current={active ? 'step' : undefined}>
            <Badge variant={active ? 'default' : 'outline'}>{`${index + 1}. ${label}`}</Badge>
          </li>
        );
      })}
    </ol>
  );
}
