import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RotateCw,
  Search,
  SendHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useCampaignMessages,
  useRedispatchMessage,
  useRetryMessage,
} from "../api";
import type { MessageStatus, CampaignMessage } from "../schemas";
import { MessageStatusBadge } from "./message-status-badge";
import { extractApiError } from "@/lib/api-error";

/**
 * ★ A RECUSA DO BACKEND CHEGA INTEIRA À TELA.
 *
 * Estes dois botões são os únicos do produto que descartavam o corpo da
 * resposta (`catch { toast.error("Falha ao reenfileirar") }`). Enquanto isso o
 * backend ganhou três recusas NOVAS e específicas — a mais comum delas,
 * `message.contact_already_reached`, é o caso NORMAL da retomada por lotes — e
 * escreveu a frase pronta no ProblemDetails. Jogar esse texto fora devolve o
 * operador ao estado de 2026-08-11: uma recusa sem motivo, oito tentativas
 * cegas numa tarde.
 *
 * A regra: o TÍTULO diz o que não deu certo (é o que o operador acabou de
 * tentar), a DESCRIÇÃO é a explicação do backend, sem tradução nem resumo. Só
 * quando não veio ProblemDetails nenhum (`code` ausente: queda de rede, 502 do
 * proxy, corpo ilegível) a tela cai no seu próprio palpite — porque aí o texto
 * cru do erro ("Failed to fetch") não ajuda ninguém.
 */
const SUGESTAO_POR_CODE: Record<string, string> = {
  "message.contact_already_reached":
    "Abra a outra linha deste contato nesta campanha para ver o que já saiu.",
};

/**
 * ★ "CANCELADA" DEIXOU DE SER UMA COISA SÓ.
 *
 * O balde CANCELLED hoje guarda pelo menos quatro histórias diferentes, e a
 * diferença entre elas é a única que o operador realmente precisa: a pessoa
 * RECEBEU ou não? Só o `errorCode` sabe — e ele já vem no fio; a tabela é que o
 * mostrava apenas nas linhas FAILED.
 *
 * Um código desconhecido cai no próprio código cru: a tela nunca deve ficar
 * MUDA sobre um motivo que o backend registrou, mesmo um que ela não conheça.
 */
const CANCELLED_REASON_LABELS: Record<string, string> = {
  opted_out: "O contato pediu para sair (opt-out) antes de a mensagem sair.",
  campaign_cancelled:
    "A campanha foi cancelada enquanto esta mensagem ainda estava na fila — ela não saiu.",
  duplicate_already_sent:
    "Não saiu para não repetir: este contato já recebeu esta campanha por outra linha.",
  duplicate_row_neutralized:
    "Linha duplicada da mesma campanha para o mesmo contato — o envio válido está em outra linha.",
};

async function motivoDaRecusa(
  err: unknown,
  palpite: { title: string; description: string },
): Promise<{ title: string; description: string }> {
  const api = await extractApiError(err);
  if (!api.code) return palpite;
  const sugestao = SUGESTAO_POR_CODE[api.code];
  return {
    title: palpite.title,
    description: sugestao ? `${api.message} ${sugestao}` : api.message,
  };
}

const STATUS_FILTERS: Array<{ value: "all" | MessageStatus; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "QUEUED", label: "Na fila" },
  { value: "WAITING_INSTANCE", label: "Aguardando conexão" },
  { value: "SENT", label: "Enviadas" },
  { value: "DELIVERED", label: "Entregues" },
  { value: "READ", label: "Lidas" },
  { value: "FAILED", label: "Falhas" },
  { value: "CANCELLED", label: "Canceladas" },
  // C2 — os status do gate de consentimento precisam ser FILTRÁVEIS: é assim
  // que o operador descobre, em uma campanha que "não enviou nada", quantos
  // ficaram de fora por falta de consentimento e quantos por supressão.
  { value: "SKIPPED_NO_CONSENT", label: "Sem consentimento" },
  { value: "SKIPPED_SUPPRESSED", label: "Suprimidos" },
];

export function MessagesTable({ campaignId }: { campaignId: string }) {
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [status, setStatus] = useState<"all" | MessageStatus>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const { data, isLoading } = useCampaignMessages(campaignId, {
    page,
    pageSize,
    status: status === "all" ? undefined : status,
    search: search || undefined,
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold">Mensagens ({total})</h2>
        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setSearch(searchInput.trim());
            }}
            className="relative"
          >
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Nome ou telefone…"
              value={searchInput}
              onChange={(e) => {
                const v = e.target.value;
                setSearchInput(v);
                // Apply an empty search immediately so clearing the input
                // resets the filter — without this, the user sees an empty
                // box but the table keeps filtering by the last submitted
                // term until they hit Enter again.
                if (v === "" && search !== "") {
                  setPage(1);
                  setSearch("");
                }
              }}
              className="h-9 w-48 pl-7"
            />
          </form>
          <Select
            value={status}
            onValueChange={(v) => {
              setPage(1);
              setStatus(v as "all" | MessageStatus);
            }}
          >
            <SelectTrigger className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[26%]">Contato</TableHead>
              <TableHead className="w-[15%]">Status</TableHead>
              <TableHead className="w-[15%]">Enviada</TableHead>
              <TableHead className="w-[15%]">Entregue</TableHead>
              <TableHead className="w-[15%]">Lida</TableHead>
              <TableHead className="w-[14%] text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && !data ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-sm text-muted-foreground"
                >
                  Carregando…
                </TableCell>
              </TableRow>
            ) : !data || data.items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-sm text-muted-foreground"
                >
                  Nenhuma mensagem encontrada.
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((m) => (
                <MessageRow key={m.id} message={m} campaignId={campaignId} />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Página {page} de {totalPages}
        </span>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  campaignId,
}: {
  message: CampaignMessage;
  campaignId: string;
}) {
  const retry = useRetryMessage(campaignId);
  const redispatch = useRedispatchMessage(campaignId);
  const isFailed = message.status === "FAILED";
  const isCancelled = message.status === "CANCELLED";
  const [redispatchOpen, setRedispatchOpen] = useState(false);

  /*
    ★ LINHA EM VOO NÃO SE REDISPARA.

    O backend (campaigns.service.ts, redispatchMessage) RECUSA
    SENDING/QUEUED/WAITING_INSTANCE: com a linha em SENDING o worker está dentro
    do `wa.send` (minutos, no broadcast do Zernio), e devolvê-la à fila a torna
    reivindicável de novo — dois workers, duas entregas a partir de UMA linha.
    Numa campanha eleitoral isso é a mesma pessoa recebendo propaganda duas
    vezes.

    A tela oferecia o botão para QUALQUER status: o operador clicava, confirmava
    o diálogo e recebia um "Falha ao disparar" sem motivo. Esconder o botão é
    dizer a mesma coisa antes do clique — a recusa continua no backend, que é
    quem decide.
  */
  const inFlight =
    message.status === "SENDING" ||
    message.status === "QUEUED" ||
    message.status === "WAITING_INSTANCE";

  const contactLabel = message.contact.name ?? message.contact.phoneE164;

  return (
    <TableRow>
      <TableCell>
        <div className="space-y-0.5">
          <div className="text-sm font-medium">
            {message.contact.name ?? "(sem nome)"}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {formatPhone(message.contact.phoneE164)}
          </div>
          {message.contact.optedOut && (
            <div className="text-xs text-amber-600 dark:text-amber-400">
              opt-out
            </div>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="space-y-1">
          <MessageStatusBadge status={message.status} />
          {isFailed && message.errorMessage && (
            <div
              className="max-w-[260px] text-xs text-rose-600 dark:text-rose-400"
              title={`${message.errorCode ?? "erro"}: ${message.errorMessage}`}
            >
              <div className="line-clamp-2">{message.errorMessage}</div>
              {message.errorCode && (
                <div className="mt-0.5 font-mono text-[10px] text-rose-500/80">
                  {message.errorCode}
                </div>
              )}
            </div>
          )}
          {isCancelled && message.errorCode && (
            <div
              data-testid="cancelled-reason"
              className="max-w-[260px] text-xs text-muted-foreground"
              title={message.errorMessage ?? message.errorCode}
            >
              {CANCELLED_REASON_LABELS[message.errorCode] ?? message.errorCode}
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatTimestamp(message.sentAt)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatTimestamp(message.deliveredAt)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatTimestamp(message.readAt)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {isFailed && (
            <Button
              variant="outline"
              size="sm"
              disabled={retry.isPending}
              title="Reenviar (retentar a mesma mensagem que falhou)"
              onClick={async () => {
                try {
                  await retry.mutateAsync(message.id);
                  toast.success("Mensagem reenfileirada");
                } catch (err) {
                  const { title, description } = await motivoDaRecusa(err, {
                    title: "Não foi possível reenviar",
                    description:
                      "Tente de novo em instantes. Se persistir, atualize a lista.",
                  });
                  toast.error(title, { description });
                }
              }}
            >
              <RotateCw
                className={`h-3.5 w-3.5 ${retry.isPending ? "animate-spin" : ""}`}
              />
              <span className="ml-1">Reenviar</span>
            </Button>
          )}

          {inFlight ? (
            /* Em voo: nada a oferecer, mas o motivo fica na tela em vez de
               virar um botão que só devolve erro. */
            <span className="text-xs text-muted-foreground">
              {message.status === "SENDING" ? "enviando…" : "na fila"}
            </span>
          ) : (
            <AlertDialog open={redispatchOpen} onOpenChange={setRedispatchOpen}>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Disparar novamente para este contato"
                title="Disparar novamente para este contato (reenfileira esta mesma mensagem)"
                disabled={redispatch.isPending}
                onClick={() => setRedispatchOpen(true)}
              >
                <SendHorizontal
                  className={`h-3.5 w-3.5 ${redispatch.isPending ? "animate-pulse" : ""}`}
                />
              </Button>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Disparar novamente para {contactLabel}?
                  </AlertDialogTitle>
                  {/* O texto antigo prometia "será criada uma nova mensagem" — o
                      backend parou de clonar a linha (era o clone que produzia
                      "3 pulados de 2 destinatários"). Descrever o que de fato
                      acontece é o que permite ao operador prever o resultado. */}
                  <AlertDialogDescription>
                    Esta mesma mensagem volta para a fila, com os dados atuais do
                    contato e o canal atual da campanha — nenhuma linha nova
                    aparece na lista. Se o contato já recebeu antes, ele vai
                    receber de novo.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={async () => {
                      try {
                        await redispatch.mutateAsync(message.id);
                        toast.success("Mensagem disparada");
                        setRedispatchOpen(false);
                      } catch (err) {
                        // O backend recusa a linha em voo E o contato que já
                        // tem irmã viva nesta campanha. Quando ele explica, a
                        // explicação DELE é que sobe; o palpite abaixo só vale
                        // para a falha muda (rede, proxy), em que a corrida
                        // render→clique é mesmo a hipótese mais provável.
                        const { title, description } = await motivoDaRecusa(
                          err,
                          {
                            title: "Não foi possível disparar",
                            description:
                              "Se a mensagem entrou em envio agora, atualize a lista e tente de novo.",
                          },
                        );
                        toast.error(title, { description });
                      }
                    }}
                  >
                    Disparar
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function formatPhone(p: string) {
  // Light formatting for BR numbers; keep as-is otherwise.
  if (p.startsWith("+55") && p.length >= 13) {
    const ddd = p.slice(3, 5);
    const rest = p.slice(5);
    if (rest.length === 9)
      return `+55 (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
    if (rest.length === 8)
      return `+55 (${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  return p;
}

function formatTimestamp(d: string | Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
