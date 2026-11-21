import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { todayInManaus } from "@/features/people-record/authorization";
import { formatDayMonth } from "@/lib/civil-date";
import { useAuthStore } from "@/stores/auth.store";
import { useTeamPanorama } from "../api";
import {
  inProgressText,
  PANORAMA_LOAD_ERROR,
  PANORAMA_LOADING,
  PANORAMA_NOTICE,
  PANORAMA_RETRY,
  PANORAMA_TITLE,
  panoramaSubtitle,
} from "../labels";
import type { TeamPanorama } from "../schemas";
import { PanoramaMultiSend } from "./panorama-actions";
import { PanoramaCard } from "./panorama-card";

/** Atalho do turno da véspera ainda em andamento: só quando a data escolhida é hoje (P7). */
function InProgressShortcut({
  panorama,
  date,
  onPick,
}: {
  panorama: TeamPanorama;
  date: string;
  onPick: (date: string) => void;
}) {
  const { inProgress, today } = panorama;
  if (!inProgress || date !== today) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
    >
      <p>{inProgressText(inProgress.shift.name)}</p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onPick(inProgress.date)}
      >
        {`Ver ${formatDayMonth(inProgress.date)}`}
      </Button>
    </div>
  );
}

function PanoramaCards({
  panorama,
  date,
}: {
  panorama: TeamPanorama;
  date: string;
}) {
  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {panorama.sectors.map((sector) => (
        <li key={`${date}:${sector.sectorId}`}>
          <PanoramaCard
            sector={sector}
            shifts={panorama.shifts}
            date={panorama.date}
          />
        </li>
      ))}
    </ul>
  );
}

type BodyProps = {
  query: ReturnType<typeof useTeamPanorama>;
  date: string;
  onPick: (date: string) => void;
};

function PanoramaBody({ query, date, onPick }: BodyProps) {
  if (date === "") return null;
  if (query.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
        <p>{PANORAMA_LOAD_ERROR}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          {PANORAMA_RETRY}
        </Button>
      </div>
    );
  }
  if (!query.data || query.isPlaceholderData) {
    return <p className="text-sm text-muted-foreground">{PANORAMA_LOADING}</p>;
  }
  return (
    <>
      <InProgressShortcut panorama={query.data} date={date} onPick={onPick} />
      <PanoramaMultiSend
        sectorCount={query.data.sectors.length}
        date={query.data.date}
      />
      <PanoramaCards panorama={query.data} date={date} />
    </>
  );
}

function PanoramaBlock({ role }: { role: string }) {
  const [date, setDate] = useState(todayInManaus);
  // `answered`: já houve uma resposta (dado ou erro). O espaço neutro vale só até ela; depois, tentar de
  // novo ou trocar a data mantém a seção e o seletor de data, com "Carregando panorama…".
  const [answered, setAnswered] = useState(false);
  const query = useTeamPanorama(date, true);
  // Remetente recusado (403): o servidor responde `null` e o bloco some, sem mensagem.
  if (query.data === null) return null;
  const hasAnswer = query.data !== undefined || query.isError;
  if (hasAnswer && !answered) setAnswered(true);
  // Primeira consulta em andamento: espaço neutro, sem texto, para não piscar o título de quem será recusado.
  if (!answered && !hasAnswer)
    return <div aria-hidden="true" className="h-12" />;
  return (
    <section aria-labelledby="panorama-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="panorama-title"
            className="font-heading text-lg text-foreground"
          >
            {PANORAMA_TITLE}
          </h2>
          <p className="text-sm text-muted-foreground">
            {panoramaSubtitle(role)}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="panorama-date">Data</Label>
          <Input
            id="panorama-date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{PANORAMA_NOTICE}</p>
      <PanoramaBody query={query} date={date} onPick={setDate} />
    </section>
  );
}

/** Bloco "Operação da fábrica" da Visão geral: só para quem pode ser remetente (VIEWER e sem usuário não consultam). */
export function FactoryPanorama() {
  const role = useAuthStore((state) => state.user?.role);
  if (!role || role === "VIEWER") return null;
  return <PanoramaBlock role={role} />;
}
