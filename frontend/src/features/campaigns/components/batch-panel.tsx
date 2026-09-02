import { useState } from "react";
import { BanIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { KPIHero } from "@/components/kpi-hero";
import {
  useBatchSummary,
  useCampaignBatches,
  useCampaignFailureReasons,
  useCampaignRecipients,
} from "@/features/campaigns/api";
import {
  FAILURE_REASON_LABELS,
  RECIPIENT_GROUPS,
} from "@/features/campaigns/schemas";
import type {
  CampaignRecipient,
  RecipientGroup,
} from "@/features/campaigns/schemas";

/**
 * ZE — O PAINEL DE LOTES.
 *
 * O pedido do cliente, literal: "Quero enviar 50 agora... Aí depois eu quero,
 * naquela mesma campanha, enviar para mais 100. Só que eu não vou ter a dor de
 * cabeça de saber pra quem eu não enviei — o sistema só vai me listar."
 *
 * Achado 5 (Importante, review final) — o FORMULÁRIO de envio ("Enviar agora
 * para [N]" + "Enviar lote") saiu daqui. A.5 pede UMA ação de envio na tela
 * da campanha; este painel virou o SEGUNDO caminho para a mesma coisa (sem
 * quota/canal na confirmação, ao lado do cabeçalho de progresso, que já
 * mostra a quota e sabe o canal). O que fica: os números (Enviados ·
 * Pendentes · Pulados · Inalcançáveis), as abas "enviados × não enviados" e o
 * Histórico de lotes — o retrato do que já saiu, não uma 2ª porta para
 * disparar.
 */

const GROUP_LABEL: Record<RecipientGroup, string> = {
  sent: "Enviados",
  pending: "Não enviados",
  unreachable: "Inalcançáveis",
  // GATE SILENCIOSO — a 4ª aba. Quem o gate de consentimento pulou não caía em
  // NENHUM dos três grupos acima e sumia da tela inteira.
  skipped: "Pulados",
  // F2 — a 5ª aba. Quem o provedor RECUSOU. Ficava só como o número "falhas 3"
  // do histórico do lote: nem quem, nem por quê.
  failed: "Falhas",
};

/**
 * O motivo da falha deste destinatário, em português. Usa o MESMO mapa que a
 * coluna "Motivo da falha" da lista de contatos e que o backend usa no
 * `/failure-reasons` — três telas dizendo a mesma coisa com palavras
 * diferentes é o que faz o operador achar que são falhas diferentes.
 *
 * Sem motivo normalizado (falha anterior ao F2, ou canal que não deu código),
 * o `errorCode` cru ainda vale como diagnóstico — mas nunca o slug do enum.
 */
function failureReasonLabel(recipient: CampaignRecipient) {
  if (recipient.failureReason) {
    return FAILURE_REASON_LABELS[recipient.failureReason];
  }
  return recipient.errorCode
    ? `motivo não registrado (${recipient.errorCode})`
    : "motivo não registrado";
}

/** O motivo do pulo, em português — é o que diz ao operador o que fazer. */
function skipReasonLabel(reason: string | null | undefined) {
  switch (reason) {
    case "no_consent":
    case "SKIPPED_NO_CONSENT":
    case "SKIPPED_NO_OPTIN":
      return "sem consentimento para esta finalidade";
    case "suppressed":
    case "SKIPPED_SUPPRESSED":
      return "pediu para não receber (opt-out)";
    default:
      return "pulado pelo gate de consentimento";
  }
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BatchPanel({ campaignId }: { campaignId: string }) {
  const [group, setGroup] = useState<RecipientGroup>("pending");

  const summary = useBatchSummary(campaignId, { live: true });
  const batches = useCampaignBatches(campaignId, { live: true });
  const recipients = useCampaignRecipients(campaignId, {
    group,
    page: 1,
    pageSize: 50,
  });
  // Só busca o agregado quando a aba de falhas está aberta — é a única tela
  // que o mostra, e ele não entra em nenhum KPI do topo.
  const failureReasons = useCampaignFailureReasons(campaignId, {
    enabled: group === "failed",
  });

  const s = summary.data;
  if (!s) return null;

  // O contador de cada aba, vindo do /batch-summary. ATENÇÃO: para `failed` e
  // `skipped` este número tem um denominador DIFERENTE do da lista da aba, por
  // três motivos acumulados:
  //   1. o resumo conta MENSAGENS, a lista conta CONTATOS (quem falhou duas
  //      vezes na campanha — retry que falhou de novo — conta 2 aqui e 1 lá);
  //   2. a lista passa pelo RECORTE DE AUDIÊNCIA (`resolveAudienceWhere` +
  //      `applyAudienceLimit`) e o `toPrismaWhere` sempre AND-a
  //      `{ optedOut: false }` — quem falhou e depois respondeu "SAIR" sai da
  //      lista e continua no resumo;
  //   3. a lista de falhas exclui quem JÁ FOI ALCANÇADO ou está EM VOO nesta
  //      campanha (uma falha transitória seguida de entrega no lote seguinte),
  //      recorte que o resumo não aplica.
  // Por isso o badge da aba ABERTA passa a sair do `total` da PRÓPRIA lista
  // (abaixo): é o único número que o operador pode conferir contando as linhas.
  const summaryCount: Record<RecipientGroup, number> = {
    sent: s.sent,
    pending: s.pending,
    unreachable: s.unreachable,
    skipped: s.skipped,
    failed: s.failed,
  };

  // Com `placeholderData: (prev) => prev`, ao trocar de aba o `recipients.data`
  // ainda é o da aba ANTERIOR por ~1 round-trip, com `status: 'success'` e
  // `isLoading: false`. Ler o total (ou os motivos de falha) nesse intervalo
  // rotularia as linhas da aba velha com a semântica da aba nova.
  const listIsStale = recipients.isPlaceholderData;

  // O badge da aba aberta = o `total` da lista que está logo abaixo dele. As
  // outras abas seguem no número do resumo (buscar as 5 listas só para desenhar
  // 5 badges não se paga) — e é por isso que o número de uma aba pode mudar no
  // instante em que ela é aberta.
  const badgeCount = (g: RecipientGroup): number =>
    g === group && !listIsStale && recipients.data
      ? recipients.data.total
      : summaryCount[g];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Envio em lotes</CardTitle>
        <p className="text-xs text-muted-foreground">
          O retrato de quem já recebeu e quem falta — o próximo lote sai pelo
          botão "Enviar próximo lote" no topo da página.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Os três números que o cliente pediu — mais os pulados pelo gate, que
            o backend já mandava e a UI descartava. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KPIHero
            label="Enviados"
            value={s.sent}
            meta={`de ${s.total} na audiência`}
          />
          <KPIHero
            tone="brand"
            label="Pendentes"
            value={s.pending}
            meta={
              s.pending === 0
                ? // GATE SILENCIOSO — dizer "a campanha acabou" quando o que
                  // sobrou foi tudo BLOQUEADO é a frase que contradizia o "Em
                  // execução" do topo e mandava o operador procurar o erro em
                  // outro lugar (ele foi procurar no agendamento).
                  s.skipped > 0
                  ? "Nada a enviar — os restantes foram pulados pelo gate de consentimento"
                  : "Nada a enviar — a campanha acabou"
                : "Ainda não receberam nesta campanha"
            }
          />
          <KPIHero
            label="Pulados"
            value={s.skipped}
            meta={
              s.skipped > 0
                ? "Bloqueados pelo gate: sem consentimento para a finalidade (ou opt-out)"
                : undefined
            }
          />
          <KPIHero
            label="Inalcançáveis"
            value={s.unreachable}
            meta={
              s.isMarketing
                ? "Desligaram mensagens de marketing no WhatsApp — nunca receberão um template de marketing"
                : "Campanha UTILITY: os inalcançáveis para marketing continuam sendo enviados"
            }
          />
        </div>

        {/* Inalcançáveis: a explicação de uma linha que o operador precisa. */}
        {s.isMarketing && s.unreachable > 0 && (
          <div
            className="flex items-start gap-2 rounded-lg border p-3 text-xs"
            style={{ color: "var(--foreground-muted)" }}
          >
            <BanIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              <strong>{s.unreachable}</strong> contato(s) desligaram as
              mensagens de marketing no WhatsApp (Meta 131026/130472). Eles
              nunca receberão um template de <strong>MARKETING</strong> —
              reenviar só queima cota do número. Templates{" "}
              <strong>UTILITY</strong> (serviço) continuam chegando normalmente.
            </p>
          </div>
        )}

        {/* Enviados × não enviados — o "grupo de enviadas" do cliente. */}
        <div>
          <div className="mb-2 flex flex-wrap gap-1">
            {RECIPIENT_GROUPS.map((g) => (
              <Button
                key={g}
                size="sm"
                variant={group === g ? "default" : "outline"}
                onClick={() => setGroup(g)}
              >
                {GROUP_LABEL[g]}
                <Badge variant="secondary" className="ml-1.5">
                  {badgeCount(g)}
                </Badge>
              </Button>
            ))}
          </div>

          {/* F2 — o padrão das falhas, antes da lista: 12 "canal fora do ar" é
              um problema do CANAL; 12 "sem WhatsApp" é um problema da BASE. Os
              rótulos vêm prontos do /failure-reasons (mesmo mapa daqui). */}
          {group === "failed" && (failureReasons.data?.length ?? 0) > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {failureReasons.data!.map((r) => (
                <Badge
                  key={r.failureReason ?? "sem-motivo"}
                  variant="outline"
                  className="font-normal"
                >
                  {`${r.label ?? "Motivo não registrado"} · ${r.count}`}
                </Badge>
              ))}
            </div>
          )}

          <div className="rounded-lg border">
            {recipients.isLoading ? (
              <p className="p-3 text-xs text-muted-foreground">Carregando…</p>
            ) : (recipients.data?.items.length ?? 0) === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                Nenhum contato neste grupo.
              </p>
            ) : (
              <ul className="divide-y">
                {recipients.data!.items.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className="truncate">
                      {c.name ?? "(sem nome)"}{" "}
                      <span className="ds-mono text-xs text-muted-foreground">
                        {c.phoneE164}
                      </span>
                    </span>
                    {/* `listIsStale` silencia a coluna de motivo enquanto as
                        linhas ainda são as da aba ANTERIOR: sem isso, ao clicar
                        em "Falhas" cada contato PENDENTE herdava por um
                        round-trip o rótulo "Motivo não registrado", que se lê
                        como "falhou sem motivo" — uma acusação falsa. */}
                    {listIsStale ? null : group === "skipped" ? (
                      <span
                        className="shrink-0 text-xs"
                        style={{ color: "var(--foreground-muted)" }}
                      >
                        {skipReasonLabel(c.skipReason)}
                      </span>
                    ) : group === "failed" ? (
                      <span
                        className="shrink-0 text-xs"
                        style={{ color: "var(--foreground-muted)" }}
                        // O código cru do provedor fica no title: é o que se
                        // manda pro suporte, mas não é o que o operador lê.
                        title={c.errorCode ?? undefined}
                      >
                        {failureReasonLabel(c)}
                      </span>
                    ) : (
                      c.marketingUndeliverableReason && (
                        <span
                          className="shrink-0 text-xs"
                          style={{ color: "var(--foreground-muted)" }}
                          title={c.marketingUndeliverableReason}
                        >
                          marketing desligado
                        </span>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
            {(recipients.data?.total ?? 0) >
              (recipients.data?.items.length ?? 0) && (
              <p className="border-t p-2 text-center text-xs text-muted-foreground">
                Mostrando {recipients.data!.items.length} de{" "}
                {recipients.data!.total}
              </p>
            )}
          </div>
        </div>

        {/* Histórico: quando, quantos, resultado. */}
        {(batches.data?.length ?? 0) > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Histórico de lotes
            </h4>
            <ul className="divide-y rounded-lg border">
              {batches.data!.map((b) => {
                const delivered = b.statusCounts
                  .filter((x) =>
                    ["SENT", "DELIVERED", "READ"].includes(x.status),
                  )
                  .reduce((acc, x) => acc + x.count, 0);
                const failed =
                  b.statusCounts.find((x) => x.status === "FAILED")?.count ?? 0;
                return (
                  <li
                    key={b.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <span>
                      <strong>Lote {b.seq}</strong>{" "}
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(b.startedAt)}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      pediu {b.requested} · enfileirou {b.queued}
                      {b.skipped > 0 && ` · pulou ${b.skipped}`} · entregues{" "}
                      {delivered}
                      {failed > 0 && ` · falhas ${failed}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
