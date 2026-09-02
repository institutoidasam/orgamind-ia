import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  LayoutPanelLeft,
  ShieldOff,
  Table as TableIcon,
  Loader2,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCampaign, useCampaignMessages } from "@/features/campaigns/api";
import { useConsentPurposes } from "@/features/consent/api";
import { EventsExplorer } from "@/components/events-explorer";
import { CampaignProgressHeader } from "@/features/campaigns/components/campaign-progress-header";
import { MessagesTable } from "@/features/campaigns/components/messages-table";
import { ScheduleInfoCard } from "@/features/campaigns/components/schedule-info-card";
import { BatchPanel } from "@/features/campaigns/components/batch-panel";

export const Route = createFileRoute("/_authenticated/campaigns/$campaignId")({
  component: CampaignDetailPage,
});

const STATUS_VARIANT: Record<
  string,
  { label: string; styles: React.CSSProperties }
> = {
  // Campaign-level statuses are mapped to the closest --st-*-* token so dark
  // mode is handled automatically by the cascade rather than per-class
  // dark: overrides.
  DRAFT: {
    label: "Rascunho",
    styles: {
      background: "var(--st-queued-bg)",
      color: "var(--st-queued-fg)",
      borderColor: "var(--st-queued-border)",
    },
  },
  QUEUED: {
    label: "Na fila",
    styles: {
      background: "var(--st-sent-bg)",
      color: "var(--st-sent-fg)",
      borderColor: "var(--st-sent-border)",
    },
  },
  RUNNING: {
    label: "Em execução",
    styles: {
      background: "var(--st-delivered-bg)",
      color: "var(--st-delivered-fg)",
      borderColor: "var(--st-delivered-border)",
    },
  },
  COMPLETED: {
    label: "Concluída",
    styles: {
      background: "var(--st-read-bg)",
      color: "var(--st-read-fg)",
      borderColor: "var(--st-read-border)",
    },
  },
  FAILED: {
    label: "Falhou",
    styles: {
      background: "var(--st-failed-bg)",
      color: "var(--st-failed-fg)",
      borderColor: "var(--st-failed-border)",
    },
  },
  CANCELLED: {
    label: "Cancelada",
    styles: {
      background: "var(--st-cancelled-bg)",
      color: "var(--st-cancelled-fg)",
      borderColor: "var(--st-cancelled-border)",
    },
  },
};

function CampaignDetailPage() {
  const { campaignId } = Route.useParams();
  const { data, isLoading } = useCampaign(campaignId);
  const { data: failedSample } = useCampaignMessages(campaignId, {
    page: 1,
    pageSize: 1,
    status: "FAILED",
  });
  // O rótulo humano da finalidade ("Campanha de apoio"), não o slug: é o que o
  // aviso de pulados precisa dizer para o operador saber QUAL consentimento
  // falta coletar.
  const { data: purposes } = useConsentPurposes();
  const [view, setView] = useState<"explorer" | "table">("explorer");

  // Surface critical session-level errors at the top so the operator sees the
  // fix instructions immediately, instead of having to open each row tooltip.
  const blockingError = (() => {
    const m = failedSample?.items[0];
    if (!m?.errorCode) return null;
    if (m.errorCode === "evolution.session_closed") {
      return {
        title: "WhatsApp desconectado durante o envio",
        body: 'Outro WhatsApp Web/Desktop pode estar logado com o mesmo número. No celular, abra Configurações → Aparelhos conectados → saia de todos. Depois abra /connect, escaneie o QR Code novamente, espere 30 segundos para a sessão estabilizar e clique em "Reenviar falhas" aqui.',
      } as const;
    }
    if (m.errorCode === "evolution.unauthorized") {
      return {
        title: "WhatsApp bloqueou a ação",
        body: "O número pode ter sido marcado como spam ou banido. PARE os disparos imediatamente. Verifique no app se há aviso de banimento antes de continuar.",
      } as const;
    }
    if (m.errorCode === "evolution.not_connected") {
      return {
        title: "WhatsApp não está conectado",
        body: "Acesse a tela /connect e escaneie o QR Code antes de disparar.",
      } as const;
    }
    if (m.errorCode === "evolution.session_unstable") {
      return {
        title: "Sessão WhatsApp ainda estabilizando",
        body: 'A conexão acabou de ser feita ou está se reconectando. Aguarde 30 segundos e clique em "Reenviar falhas". Se persistir, abra /connect e refaça a conexão.',
      } as const;
    }
    return null;
  })();

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Carregando…
      </div>
    );
  }

  const counts = (data.statusCounts ?? []).reduce(
    (acc, c) => ({ ...acc, [c.status]: c._count }),
    {} as Record<string, number>,
  );
  const total = data.totalRecipients;
  const sent =
    (counts.SENT ?? 0) + (counts.DELIVERED ?? 0) + (counts.READ ?? 0);
  // F2 T8 — "Reenviar falhas (N)" precisa contar CONTATOS distintos ainda
  // não alcançados, não linhas de Message FAILED: uma pessoa com 3
  // tentativas FAILED nesta campanha inflava a contagem em 3x. O botão
  // "Reenviar falhas" (agora dentro do cabeçalho) usa este número.
  const retryableFailedCount = data.retryableFailedCount ?? 0;

  // GATE SILENCIOSO — o número que sumia. Ele SEMPRE esteve em `statusCounts`
  // (o groupBy do backend não filtra status), mas nenhum contador o somava: a
  // campanha aparecia com zero em tudo, sem uma linha dizendo por quê.
  const skippedNoConsent = counts.SKIPPED_NO_CONSENT ?? 0;
  const skippedSuppressed = counts.SKIPPED_SUPPRESSED ?? 0;
  const skipped =
    skippedNoConsent + skippedSuppressed + (counts.SKIPPED_NO_OPTIN ?? 0);
  const purposeLabel =
    purposes?.find((p) => p.key === data.purposeKey)?.label ??
    data.purposeKey ??
    null;
  // 100% bloqueado: nada saiu. Este é o caso que fez o operador procurar o bug
  // no horário durante horas.
  const nothingSent = skipped > 0 && sent === 0;

  const status = STATUS_VARIANT[data.status] ?? {
    label: data.status,
    styles: {
      background: "var(--st-queued-bg)",
      color: "var(--st-queued-fg)",
      borderColor: "var(--st-queued-border)",
    },
  };

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/campaigns"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Voltar para campanhas
        </Link>
        {/* Achado 5 (Importante, review final) — o botão "Disparar tudo
            agora" saiu daqui. Era um 3º caminho de envio (junto do formulário
            do BatchPanel e do "Enviar próximo lote" do cabeçalho): enfileirava
            a AUDIÊNCIA INTEIRA de uma vez, sem quota/canal, sem confirmação —
            o oposto do que a Fase A existe para resolver. O cabeçalho de
            progresso abaixo JÁ atende uma campanha em DRAFT (`sendBatch`
            também tira a campanha de DRAFT); "Enviar próximo lote" é a ÚNICA
            porta de envio na tela, para qualquer status não-terminal. */}
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{data.name}</h1>
            <Badge variant="outline" style={status.styles}>
              {status.label}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Template:{" "}
            <span className="font-medium text-foreground">
              {data.template.metaName}
            </span>{" "}
            ({data.template.language})
          </p>
          <div className="mt-1 text-xs text-muted-foreground">
            Criada em {formatDate(data.createdAt)}
            {data.startedAt && ` · Iniciada em ${formatDate(data.startedAt)}`}
            {data.finishedAt &&
              ` · Finalizada em ${formatDate(data.finishedAt)}`}
          </div>
        </div>
      </div>

      {blockingError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{blockingError.title}</AlertTitle>
          <AlertDescription>{blockingError.body}</AlertDescription>
        </Alert>
      )}

      {/*
        GATE SILENCIOSO — o aviso que não existia.

        O gate por finalidade (LGPD) está correto e não é afrouxado em lugar
        nenhum. O que faltava era ele FALAR: sem esta faixa, o operador dispara,
        vê zero em todos os contadores e conclui que o sistema quebrou — foi o
        que aconteceu, e ele passou horas caçando um problema de horário que não
        existia. Quando 100% foi bloqueado, este é o elemento mais forte da tela.
      */}
      {skipped > 0 && (
        <Alert
          data-testid="skipped-alert"
          variant={nothingSent ? "destructive" : "default"}
        >
          <ShieldOff />
          <AlertTitle>
            {nothingSent
              ? `Nenhuma mensagem saiu — ${skipped} de ${total} destinatários foram pulados pelo gate de consentimento`
              : `${skipped} de ${total} destinatários foram pulados pelo gate de consentimento`}
          </AlertTitle>
          <AlertDescription>
            <div className="space-y-2">
              <p>
                {skippedNoConsent > 0 && (
                  <>
                    <strong>{skippedNoConsent}</strong> contato(s) não
                    consentiram para a finalidade
                    {purposeLabel ? (
                      <>
                        {" "}
                        <strong>"{purposeLabel}"</strong>
                      </>
                    ) : (
                      " declarada nesta campanha"
                    )}
                    .{" "}
                  </>
                )}
                {skippedSuppressed > 0 && (
                  <>
                    <strong>{skippedSuppressed}</strong> pediram para não
                    receber (opt-out) — essa vontade é respeitada sempre.{" "}
                  </>
                )}
                Não é falha de envio nem de agendamento: o consentimento é
                registrado <strong>por finalidade</strong>, e sem ele a mensagem
                não sai.
              </p>
              <p>
                Saída: colha o opt-in dessas pessoas para esta finalidade, ou
                crie a campanha com uma finalidade para a qual elas já
                consentiram. A lista de quem foi pulado está na aba{" "}
                <strong>Pulados</strong>, no painel de lotes acima.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button asChild size="sm" variant="outline">
                  <Link to="/opt-in-links">Coletar opt-in</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link to="/campaigns/new">
                    Nova campanha (outra finalidade)
                  </Link>
                </Button>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <ScheduleInfoCard
        scheduleType={data.scheduleType}
        scheduleConfig={data.scheduleConfig}
        scheduleEnabled={data.scheduleEnabled}
        nextRunAt={data.nextRunAt}
        lastRunAt={data.lastRunAt}
        runCount={data.runCount}
        timezone={data.timezone}
      />

      {/* A.5 — os sete KPIs soltos viraram cinco números numa linha só, com a
          linha do canal e a ação ao lado. Ver campaign-progress-header.tsx. */}
      <CampaignProgressHeader
        key={campaignId}
        campaignId={campaignId}
        timezone={data.timezone ?? "America/Manaus"}
        defaultInstanceId={data.defaultInstanceId ?? ""}
        retryableFailedCount={retryableFailedCount}
        nextRunAt={data.nextRunAt}
        scheduleType={data.scheduleType}
      />

      {/* ZE — o painel de lotes. Achado 5 (review final) — o formulário de
          envio saiu daqui (ver o comentário acima de `CampaignProgressHeader`
          — "Enviar próximo lote" é a ÚNICA porta de envio da tela). Este
          painel virou o RETRATO do que já saiu: os números, as abas
          "enviados × não enviados" e o histórico de lotes. */}
      <BatchPanel campaignId={campaignId} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Distribuição</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {(
            [
              { key: "READ", label: "Lidas", count: counts.READ ?? 0 },
              {
                key: "DELIVERED",
                label: "Entregues",
                count: counts.DELIVERED ?? 0,
              },
              { key: "SENT", label: "Enviadas", count: counts.SENT ?? 0 },
              { key: "QUEUED", label: "Na fila", count: counts.QUEUED ?? 0 },
              { key: "FAILED", label: "Falharam", count: counts.FAILED ?? 0 },
              // Os pulados pelo gate: sem esta linha a barra somava menos que o
              // total e ninguém sabia onde as pessoas tinham ido parar.
              // Reusa o token de "cancelled" (é o mesmo tom que o selinho por
              // mensagem e o swim-lane já usam para os SKIPPED_*).
              {
                key: "SKIPPED",
                token: "cancelled",
                label: "Pulados",
                count: skipped,
              },
              {
                key: "CANCELLED",
                label: "Canceladas",
                count: counts.CANCELLED ?? 0,
              },
            ] as const
          ).map((row) => {
            const totalForBars = total > 0 ? total : 1;
            const pct = (row.count / totalForBars) * 100;
            const tokenKey =
              ("token" in row ? row.token : row.key.toLowerCase()) ?? "";
            return (
              <div key={row.key} className="flex items-center gap-3">
                <div className="ds-eyebrow w-24 shrink-0">{row.label}</div>
                <div
                  className="relative h-6 flex-1 overflow-hidden rounded-md"
                  style={{ background: `var(--st-${tokenKey}-bg)` }}
                >
                  <div
                    className="h-full transition-[width]"
                    style={{
                      width: `${Math.max(pct, row.count > 0 ? 4 : 0)}%`,
                      background: `var(--st-${tokenKey}-fg)`,
                      opacity: 0.85,
                    }}
                  />
                  <span
                    className="ds-mono absolute inset-0 flex items-center px-2 text-xs font-medium"
                    style={{ color: "var(--foreground)" }}
                  >
                    {row.count}
                  </span>
                </div>
                <div
                  className="ds-mono w-12 shrink-0 text-right text-xs"
                  style={{ color: "var(--foreground-muted)" }}
                >
                  {pct.toFixed(0)}%
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Mensagens</h3>
          <div
            className="inline-flex items-center gap-0.5 rounded-full p-0.5"
            style={{
              background: "var(--surface-sunken)",
              border: "1px solid var(--border)",
            }}
          >
            <button
              type="button"
              onClick={() => setView("explorer")}
              aria-pressed={view === "explorer"}
              className="grid size-7 place-items-center rounded-full"
              style={{
                background:
                  view === "explorer" ? "var(--surface)" : "transparent",
                color:
                  view === "explorer"
                    ? "var(--foreground)"
                    : "var(--foreground-muted)",
                boxShadow: view === "explorer" ? "var(--shadow-xs)" : undefined,
              }}
              title="Explorador"
            >
              <LayoutPanelLeft className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setView("table")}
              aria-pressed={view === "table"}
              className="grid size-7 place-items-center rounded-full"
              style={{
                background: view === "table" ? "var(--surface)" : "transparent",
                color:
                  view === "table"
                    ? "var(--foreground)"
                    : "var(--foreground-muted)",
                boxShadow: view === "table" ? "var(--shadow-xs)" : undefined,
              }}
              title="Tabela completa"
            >
              <TableIcon className="size-3.5" />
            </button>
          </div>
        </div>
        {view === "explorer" ? (
          <EventsExplorer
            campaignId={campaignId}
            live={data.status === "RUNNING"}
            statusCounts={data.statusCounts}
          />
        ) : (
          <MessagesTable campaignId={campaignId} />
        )}
      </section>
    </div>
  );
}

function formatDate(d: string | Date) {
  return new Date(d).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
