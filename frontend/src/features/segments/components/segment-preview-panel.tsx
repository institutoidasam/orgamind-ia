import { CheckCircle2, Loader2, Users2 } from "lucide-react";
import { useSegmentPreview } from "../api";

type Props = {
  segmentId: string | undefined;
};

/**
 * Live audience panel for a saved segment: shows the cached/recomputed count
 * and a small sample. Calls GET /segments/:id/preview via {@link useSegmentPreview}.
 */
export function SegmentPreviewPanel({ segmentId }: Props) {
  const { data, isPending, isError } = useSegmentPreview(segmentId);

  if (!segmentId) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-lg border bg-gradient-to-br from-primary/5 to-transparent p-4">
        {isPending ? (
          <>
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Calculando…</p>
              <p className="text-xs text-muted-foreground">
                Aplicando filtros aos contatos
              </p>
            </div>
          </>
        ) : isError ? (
          <p className="text-sm text-destructive">
            Não foi possível calcular o segmento.
          </p>
        ) : data?.count === 0 ? (
          <>
            <Users2
              className="h-6 w-6"
              style={{ color: "var(--st-cancelled-fg)" }}
            />
            <div>
              <p className="text-sm font-medium">Nenhum contato corresponde</p>
              <p className="text-xs text-muted-foreground">
                Ajuste os filtros para incluir destinatários
              </p>
            </div>
          </>
        ) : (
          <>
            <CheckCircle2
              className="h-6 w-6"
              style={{ color: "var(--st-read-fg)" }}
            />
            <div>
              <p className="text-2xl font-bold leading-none">
                {data?.count ?? "—"}{" "}
                <span className="text-base font-normal text-muted-foreground">
                  contato{data?.count === 1 ? "" : "s"}
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Correspondem aos filtros deste segmento
              </p>
            </div>
          </>
        )}
      </div>

      {data && data.sample.length > 0 && (
        <div className="rounded-lg border">
          <div className="border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            Amostra ({Math.min(data.sample.length, 10)} de {data.count})
          </div>
          <ul className="divide-y text-sm">
            {data.sample.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-2 px-3 py-1.5"
              >
                <span className="truncate font-medium">{c.name ?? "—"}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {c.phoneE164}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
