import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { usePermission } from "@/features/permissions/use-permission";
import { scheduleSearch, sendSearch } from "../links";

/**
 * Ações do cartão de um setor (P5): "Ver escala" para todo remetente; "Enviar mensagem" só com
 * `equipe.enviar`. Ambas só navegam: o envio continua passando pela prévia e pela confirmação da tela de envio.
 */
export function PanoramaActions({
  sectorId,
  date,
}: {
  sectorId: string;
  date: string;
}) {
  const canSend = usePermission("equipe.enviar");
  return (
    <>
      <Button asChild size="sm" variant="outline">
        <Link to="/escala" search={scheduleSearch(sectorId, date)}>
          Ver escala
        </Link>
      </Button>
      {canSend && (
        <Button asChild size="sm" variant="outline">
          <Link to="/whatsapp-equipe" search={sendSearch(sectorId, date)}>
            Enviar mensagem
          </Link>
        </Button>
      )}
    </>
  );
}

/**
 * "Mensagem para vários setores" (P5): só com `equipe.enviar` e dois ou mais setores no alcance. Abre a
 * tela de envio só com a data, sem nenhum setor pré-marcado.
 */
export function PanoramaMultiSend({
  sectorCount,
  date,
}: {
  sectorCount: number;
  date: string;
}) {
  const canSend = usePermission("equipe.enviar");
  if (!canSend || sectorCount < 2) return null;
  return (
    <Button asChild size="sm" variant="outline">
      <Link to="/whatsapp-equipe" search={sendSearch(null, date)}>
        Mensagem para vários setores
      </Link>
    </Button>
  );
}
