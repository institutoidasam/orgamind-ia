import { Calendar, CheckCircle2, Pause, Repeat, Timer } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ScheduleConfig, ScheduleType } from "../schemas";

const TYPE_LABELS: Record<ScheduleType, string> = {
  IMMEDIATE: "Disparo imediato",
  ONCE_AT: "Agendamento único",
  DAILY_AT: "Diário",
  WEEKLY: "Semanal",
  INTERVAL: "Recorrente (intervalo)",
};

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

type Props = {
  scheduleType?: ScheduleType;
  scheduleConfig?: ScheduleConfig | null;
  scheduleEnabled?: boolean;
  nextRunAt?: string | Date | null;
  lastRunAt?: string | Date | null;
  runCount?: number;
  timezone?: string;
};

export function ScheduleInfoCard({
  scheduleType,
  scheduleConfig,
  scheduleEnabled,
  nextRunAt,
  lastRunAt,
  runCount,
  timezone,
}: Props) {
  if (!scheduleType || scheduleType === "IMMEDIATE") return null;

  const typeLabel = TYPE_LABELS[scheduleType] ?? scheduleType;
  const lastRunLabel = lastRunAt ? formatDate(lastRunAt) : "—";
  const nextRunLabel = nextRunAt ? formatDate(nextRunAt) : "Sem execuções futuras";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-primary" />
            Agendamento
          </CardTitle>
          <ScheduleStatusBadge enabled={scheduleEnabled} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Tipo" value={typeLabel} />
          <Field label="Fuso" value={timezone ?? "—"} />
          <Field
            label="Execuções"
            value={
              <span className="inline-flex items-center gap-1">
                <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
                {runCount ?? 0}
              </span>
            }
          />
          <Field label="Última execução" value={lastRunLabel} />
        </div>

        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Próxima execução
          </div>
          <div className="mt-1 flex items-center gap-2 text-base font-medium">
            <Timer className="h-4 w-4 text-primary" />
            {nextRunLabel}
          </div>
          {scheduleConfig && (
            <div className="mt-2 text-xs text-muted-foreground">
              {describe(scheduleConfig)}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ScheduleStatusBadge({ enabled }: { enabled?: boolean }) {
  if (enabled) {
    return (
      <Badge
        variant="outline"
        className="border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
      >
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Ativo
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      <Pause className="mr-1 h-3 w-3" />
      Desativado
    </Badge>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}

function formatDate(d: string | Date) {
  return new Date(d).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function describe(c: ScheduleConfig): string {
  switch (c.type) {
    case "IMMEDIATE":
      return "Disparo manual";
    case "ONCE_AT":
      return `Uma vez em ${formatDate(c.runAt)}`;
    case "DAILY_AT":
      return `Todo dia às ${c.time}`;
    case "WEEKLY": {
      // Defensive: scheduleConfig is a Json? column with no runtime validation
      // on read, so guard against a malformed WEEKLY config missing `weekdays`
      // (spreading undefined would throw and blank the whole page).
      const days = [...(c.weekdays ?? [])]
        .sort()
        .map((d) => WEEKDAYS[d])
        .join("/");
      return `${days} às ${c.time}`;
    }
    case "INTERVAL": {
      const m = c.everyMinutes;
      if (m % 1440 === 0) return `A cada ${m / 1440} dia(s)`;
      if (m % 60 === 0) return `A cada ${m / 60} hora(s)`;
      return `A cada ${m} minuto(s)`;
    }
  }
}
