import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ShiftRef } from "@/features/shifts/schemas";
import {
  cardLines,
  EMPTY_SECTOR_TEXT,
  inServiceTitle,
  OVER_LIMIT_TEXT,
  type CardLines,
} from "../labels";
import type { PanoramaSector } from "../schemas";
import { PanoramaActions } from "./panorama-actions";
import { PanoramaPeople } from "./panorama-people";

type Props = {
  sector: PanoramaSector;
  /** Turnos ativos, na ordem da resposta. */
  shifts: readonly ShiftRef[];
  /** Data do panorama (a da resposta). */
  date: string;
};

function LineList({
  items,
  className,
}: {
  items: readonly string[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className={className}>
      {items.map((text) => (
        <li key={text}>{text}</li>
      ))}
    </ul>
  );
}

function CountLines({ lines, date }: { lines: CardLines; date: string }) {
  const inService =
    lines.other === null ? lines.shifts : [...lines.shifts, lines.other];
  return (
    <>
      <p className="font-medium">{inServiceTitle(date)}</p>
      <LineList items={inService} />
      <LineList items={lines.gaps} className="text-muted-foreground" />
      <LineList items={lines.rest} className="border-t pt-2" />
    </>
  );
}

function CardBody({ sector, shifts, date }: Props) {
  if (sector.overLimit)
    return <p className="text-muted-foreground">{OVER_LIMIT_TEXT}</p>;
  if (!sector.counts) return null;
  const lines = cardLines(sector.counts, shifts);
  if (lines.empty)
    return <p className="text-muted-foreground">{EMPTY_SECTOR_TEXT}</p>;
  return <CountLines lines={lines} date={date} />;
}

/** "never" = nunca aberto (a lista nem existe, então nada foi buscado); depois, aberto ou só escondido. */
type PeopleView = "never" | "open" | "closed";

/**
 * Cartão de um setor: contagens, "Ver pessoas" e as ações. A lista de pessoas é montada no primeiro clique
 * (é isso que busca nomes e telefones) e depois só escondida, para fechar e abrir de novo não buscar outra vez.
 * Setor acima do limite não tem "Ver pessoas": a Escala é o caminho.
 */
export function PanoramaCard(props: Props) {
  const { sector, shifts, date } = props;
  const [view, setView] = useState<PeopleView>("never");
  const isOpen = view === "open";
  return (
    <Card role="group" aria-label={sector.name} className="h-full">
      <CardHeader>
        <CardTitle className="font-heading text-base">{sector.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <CardBody {...props} />
        {view !== "never" && (
          <div hidden={!isOpen}>
            <PanoramaPeople
              sectorId={sector.sectorId}
              date={date}
              shifts={shifts}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {!sector.overLimit && (
            <Button
              size="sm"
              variant="outline"
              aria-expanded={isOpen}
              onClick={() => setView(isOpen ? "closed" : "open")}
            >
              {isOpen ? "Fechar" : "Ver pessoas"}
            </Button>
          )}
          <PanoramaActions sectorId={sector.sectorId} date={date} />
        </div>
      </CardContent>
    </Card>
  );
}
