import type { AlertDb } from './team-alert.repository';

/**
 * Encerramento da tratativa de uma pessoa do alerta (K2-2, DK18). `byUserId`
 * não tem FK: sobrevive à exclusão do usuário, e o painel mostra `null`.
 */
export type AlertClosure = {
  at: Date;
  byUserId: string | null;
  reason: string;
};

/**
 * Encerramentos do alerta por id do destinatário: só quem está encerrado agora
 * (reabrir limpa as colunas, K2-7). Leitura à parte de `loadAlertPeople`, que
 * não muda; o painel só a lê, e o motivo vai na resposta, nunca em log (GK13).
 */
export async function loadAlertClosures(
  db: AlertDb,
  alertId: string,
): Promise<Map<string, AlertClosure>> {
  const rows = await db.teamWhatsappRecipient.findMany({
    where: { dispatchId: alertId, pendencyClosedAt: { not: null } },
    select: {
      id: true,
      pendencyClosedAt: true,
      pendencyClosedById: true,
      pendencyCloseReason: true,
    },
    orderBy: { id: 'asc' },
  });
  return new Map(
    rows.flatMap((row) =>
      row.pendencyClosedAt
        ? [
            [
              row.id,
              {
                at: row.pendencyClosedAt,
                byUserId: row.pendencyClosedById,
                reason: row.pendencyCloseReason ?? '',
              },
            ] as const,
          ]
        : [],
    ),
  );
}
