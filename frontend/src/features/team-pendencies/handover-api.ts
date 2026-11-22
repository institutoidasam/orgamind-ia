import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "@/lib/api-client";
import { readApiErrorBody } from "@/lib/api-error";
import { invalidatePendencies, PENDENCIES_KEY } from "./api";
import { pendencyHandlersSchema, teamPendencyListSchema } from "./schemas";

const BASE = "internal/team-whatsapp";

/** Teto da passagem (DT5): o maior `pageSize` da lista de pendências; acima disso a tela avisa e passa por partes. */
export const PENDENCY_HANDOVER_MAX = 50;

/** O que a passagem pode pular (CT2). Motivo novo do servidor lê como texto neutro (contrato tolerante, GT6). */
export type PendencyHandoverSkipReason =
  | "out_of_scope_target"
  | "already_with_target"
  | "other_handler"
  | "acked"
  | "closed"
  | "not_found";

const pendencyHandoverResultSchema = z.object({
  transferred: z.array(z.object({ id: z.string() })).default([]),
  skipped: z
    .array(z.object({ id: z.string(), reason: z.string() }))
    .default([]),
});

export type PendencyHandoverResult = z.infer<
  typeof pendencyHandoverResultSchema
>;

/** Destinos da passagem: remetentes ativos, com acesso e `equipe.enviar`, sem quem sai (K2-7, DT4). */
export function usePendencyHandoverTargets(fromId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...PENDENCIES_KEY, "handover-targets", fromId],
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () =>
      pendencyHandlersSchema.parse(
        await api
          .get(`${BASE}/pendency-handover/targets`, {
            searchParams: { fromUserId: fromId },
          })
          .json(),
      ),
  });
}

/**
 * Pendências de quem sai (DT4): as minhas são só as assumidas ("Em tratativa" e "atrasada"); as de outro (ADMIN)
 * incluem também as sem responsável vivo (responsável inativo ou fora do alcance). Uma página de até 50.
 */
export function usePendencyHandoverList(
  fromId: string,
  own: boolean,
  enabled: boolean,
) {
  const situations = own
    ? "IN_PROGRESS,OVERDUE"
    : "UNASSIGNED,IN_PROGRESS,OVERDUE";
  return useQuery({
    queryKey: [...PENDENCIES_KEY, "handover-list", fromId, own],
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () =>
      teamPendencyListSchema.parse(
        await api
          .get(`${BASE}/pendencies`, {
            searchParams: {
              situations,
              handlerId: fromId,
              pageSize: PENDENCY_HANDOVER_MAX,
            },
          })
          .json(),
      ),
  });
}

const SKIP_TEXT: Record<PendencyHandoverSkipReason, (name: string) => string> =
  {
    out_of_scope_target: () => "fora do alcance do destino",
    already_with_target: (name) => `já estava com ${name}`,
    other_handler: () => "já com outro responsável",
    acked: () => "já ciente",
    closed: () => "já encerrada",
    not_found: () => "não encontrada",
  };

/** Motivo da pendência que não passou (DT9); `already_with_target` leva o nome do destino. */
export function pendencyHandoverSkipText(
  reason: string,
  targetName: string,
): string {
  const text = SKIP_TEXT[reason as PendencyHandoverSkipReason];
  return text ? text(targetName) : "não foi passada";
}

const NO_PERMISSION_TEXT =
  "Você não tem permissão para passar pendências. Fale com um administrador.";
const ERROR_TEXT: Record<string, string> = {
  "user.not_found":
    "Esta pessoa não pode receber as pendências. Escolha outra.",
  "team_whatsapp.not_handler":
    "Só um administrador pode passar as pendências de outra pessoa.",
  "team_whatsapp.forbidden": NO_PERMISSION_TEXT,
  "auth.permission_denied": NO_PERMISSION_TEXT,
};
const GENERIC_ERROR_TEXT = "Não foi possível passar o turno. Tente de novo.";

/** Pedido da passagem; `toName` só serve ao toast (não vai no corpo) e `fromUserId` só com ADMIN passando as de outro. */
export type PendencyHandoverVars = {
  toUserId: string;
  toName: string;
  fromUserId?: string;
  note: string;
  pendencyIds: string[];
};

function successText(count: number, toName: string): string {
  const noun = count === 1 ? "pendência passada" : "pendências passadas";
  return `${count} ${noun} para ${toName}.`;
}

/**
 * Passa as pendências marcadas (K3-4). Sucesso: toast e recarga da tela; quem chamou lê as puladas no resultado.
 * Erro: toast pelo `code` (`readApiErrorBody`, ky 2); destino que sumiu (`user.not_found`) recarrega os destinos.
 */
export function usePendencyHandover() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...PENDENCIES_KEY, "handover"],
    mutationFn: async (vars: PendencyHandoverVars) => {
      const { toUserId, fromUserId, note, pendencyIds } = vars;
      const json = { toUserId, fromUserId, note, pendencyIds };
      return pendencyHandoverResultSchema.parse(
        await api.post(`${BASE}/pendency-handover`, { json }).json(),
      );
    },
    onSuccess: async (result, vars) => {
      const count = result.transferred.length;
      if (count > 0) toast.success(successText(count, vars.toName));
      await invalidatePendencies(qc);
    },
    onError: async (error) => {
      const body = await readApiErrorBody(error);
      toast.error(ERROR_TEXT[body?.code ?? ""] ?? GENERIC_ERROR_TEXT);
      if (body?.code === "user.not_found") await invalidatePendencies(qc);
    },
  });
}
