import { inactivePeopleLine } from '@/features/internal-admin/sector-usage';
import {
  LEVEL_HOW_TO_TITLE,
  LEVEL_IN_USE_TITLE,
  levelHowTo,
  levelInUse,
  levelUsageLines,
} from '../in-use';
import type { LevelAdmin } from '../schemas';

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-4">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** "Em uso" do nível, no molde do turno: o que o usa e o que fazer para liberar (E4). */
export function LevelInUse({ level }: { level: LevelAdmin }) {
  const inactive = inactivePeopleLine(level.inactivePeople ?? 0);
  const inUse = levelInUse(level);
  if (!inUse && !inactive) return null;
  return (
    <div className="mt-1 space-y-2 text-xs text-muted-foreground">
      {inUse && (
        <div className="space-y-1">
          <p className="font-medium text-foreground">{LEVEL_IN_USE_TITLE}</p>
          <List items={levelUsageLines(level)} />
          <p>{LEVEL_HOW_TO_TITLE}</p>
          <List items={levelHowTo(level)} />
        </div>
      )}
      {inactive && <p>{inactive}</p>}
    </div>
  );
}
