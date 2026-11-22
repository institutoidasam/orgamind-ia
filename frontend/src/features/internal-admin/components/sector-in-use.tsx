import type { SectorUsage } from "../schemas";
import {
  SECTOR_HOW_TO_TITLE,
  SECTOR_IN_USE_TITLE,
  inactivePeopleLine,
  sectorHowTo,
  sectorInUse,
  sectorUsageLines,
} from "../sector-usage";

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-4">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** "Em uso" do setor, no molde do turno: o que o usa e o que fazer para liberar (E4). */
export function SectorInUse({ usage }: { usage?: SectorUsage | null }) {
  if (!usage) return null;
  const inactive = inactivePeopleLine(usage.inactivePeople);
  const inUse = sectorInUse(usage);
  if (!inUse && !inactive) return null;
  return (
    <div className="mt-2 space-y-2 text-xs text-muted-foreground">
      {inUse && (
        <div className="space-y-1">
          <p className="font-medium text-foreground">{SECTOR_IN_USE_TITLE}</p>
          <List items={sectorUsageLines(usage)} />
          <p>{SECTOR_HOW_TO_TITLE}</p>
          <List items={sectorHowTo(usage)} />
        </div>
      )}
      {inactive && <p>{inactive}</p>}
    </div>
  );
}
