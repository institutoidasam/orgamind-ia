import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { HTTPError } from "ky";
import { api } from "@/lib/api-client";
import { readApiErrorBody } from "@/lib/api-error";
import { teamRosterSchema } from "@/features/team-whatsapp/schemas";
import { teamPanoramaSchema, type TeamPanorama } from "./schemas";

/** Prefixo da chave das consultas do panorama; quem precisa invalidar tudo usa este. */
export const PANORAMA_KEY = ["team-panorama"] as const;

/** Código do 403 de quem não é remetente (o mesmo do roster). */
const NOT_SENDER_CODE = "team_whatsapp.forbidden";

/**
 * Busca o panorama do dia. `null` = quem consulta não é remetente (403 `team_whatsapp.forbidden`):
 * a query resolve com sucesso e o bloco simplesmente não aparece. `readApiErrorBody` é assíncrona,
 * então a decisão fica aqui, no `queryFn`, e não na renderização. Qualquer outro erro é relançado.
 */
async function fetchPanorama(date: string): Promise<TeamPanorama | null> {
  try {
    return teamPanoramaSchema.parse(
      await api
        .get("internal/team-whatsapp/panorama", { searchParams: { date } })
        .json(),
    );
  } catch (error) {
    const isForbidden =
      error instanceof HTTPError && error.response.status === 403;
    if (
      isForbidden &&
      (await readApiErrorBody(error))?.code === NOT_SENDER_CODE
    )
      return null;
    throw error;
  }
}

/**
 * Recarrega só ao trocar a data ou ao voltar à tela (sem polling, sem refetch por foco nem por
 * reconexão). Sem data ou desabilitada: não busca.
 */
export function useTeamPanorama(date: string, enabled: boolean) {
  return useQuery({
    queryKey: [...PANORAMA_KEY, "summary", date],
    enabled: enabled && date !== "",
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
    queryFn: () => fetchPanorama(date),
  });
}

/**
 * Escala de um setor na data, para "Ver pessoas" (P4): a mesma rota do envio, buscada só quando o cartão
 * é aberto (`enabled`). Resultado fixo (`staleTime` infinito, sem refetch por foco): fechar e abrir de novo
 * o cartão não refaz a chamada. O servidor decide nome e telefone (completo ou mascarado) e o alcance.
 */
export function usePanoramaRoster(
  sectorId: string,
  date: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...PANORAMA_KEY, "roster", sectorId, date],
    enabled: enabled && sectorId !== "" && date !== "",
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: async () =>
      teamRosterSchema.parse(
        await api
          .get("internal/team-whatsapp/roster", {
            searchParams: { sectorIds: sectorId, date },
          })
          .json(),
      ),
  });
}
