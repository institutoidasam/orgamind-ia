import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { alertPollInterval, ackLabelMap } from "./alert-labels";
import { teamAlertPanelSchema, type TeamAlertPanel } from "./alert-schemas";
import { dispatchKey, POLL_INTERVAL_MS } from "./api";

/** Sob a chave do envio: invalidar `dispatchKey(id)` (Repetir, lembrete, ciência) também relê o painel. */
export const alertPanelKey = (id: string) =>
  [...dispatchKey(id), "alert"] as const;

/**
 * Painel de pendências do alerta (CI5, DI9): `GET dispatches/:id/alert`. `enabled` falso não busca (envio que não é
 * alerta). Relê a cada 10 s enquanto houver pendência e o alerta tiver menos de 2 horas.
 */
export function useAlertPanel(dispatchId: string, enabled: boolean) {
  return useQuery({
    queryKey: alertPanelKey(dispatchId),
    enabled,
    retry: false,
    queryFn: async () =>
      teamAlertPanelSchema.parse(
        await api
          .get(`internal/team-whatsapp/dispatches/${dispatchId}/alert`)
          .json(),
      ),
    refetchInterval: (q) => alertPollInterval(q.state.data, new Date()),
  });
}

/**
 * Relógio da tela: renova a cada 10 s enquanto o painel está sendo relido ou o prazo não venceu, porque "há N min" e o
 * "vence/vencido" dependem dele e a resposta do servidor, igual à anterior, não redesenha nada.
 */
export function useAlertNow(panel: TeamAlertPanel | undefined): Date {
  const [now, setNow] = useState(() => new Date());
  const live =
    panel !== undefined &&
    (alertPollInterval(panel, now) !== false ||
      now.getTime() < Date.parse(panel.ackDeadlineAt));
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(new Date()), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * Painel, relógio e o mapa `recipientId → rótulo da ciência` da coluna "Ciência", de uma vez só: a tela do alerta usa
 * os três com o mesmo relógio.
 */
export function useAlertView(dispatchId: string) {
  const query = useAlertPanel(dispatchId, true);
  const now = useAlertNow(query.data);
  const ackLabels = useMemo(
    () => ackLabelMap(query.data, now),
    [query.data, now],
  );
  return { panelQuery: query, now, ackLabels };
}
