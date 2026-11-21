import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { extractApiError, readApiErrorBody } from "@/lib/api-error";
import { sectorsKey } from "./api";
import type { SectorDetail, SectorInput } from "./schemas";
import { SECTOR_IN_USE_409 } from "./sector-usage";

const SECTOR_IN_USE = "sector.in_use";

/**
 * Grava o setor. Inativar um setor ativo só grava depois da confirmação (E6); renomear,
 * trocar o gestor e reativar gravam direto (E7). 409 `sector.in_use` (o uso surgiu depois
 * de a tela abrir, E5) avisa e recarrega o detalhe do setor, com as dependências novas.
 */
export function useSectorSave(
  sectorId: string,
  sector: SectorDetail | undefined,
  save: (input: SectorInput) => Promise<unknown>,
) {
  const client = useQueryClient();
  const [inactivating, setInactivating] = useState<SectorInput | null>(null);
  const run = async (input: SectorInput) => {
    try {
      await save(input);
      toast.success("Setor atualizado");
    } catch (error) {
      if ((await readApiErrorBody(error))?.code === SECTOR_IN_USE) {
        toast.error(SECTOR_IN_USE_409);
        await client.invalidateQueries({ queryKey: [...sectorsKey, sectorId] });
        return;
      }
      const apiError = await extractApiError(error);
      toast.error(apiError.title, { description: apiError.message });
    }
  };
  const submit = async (input: SectorInput) => {
    if (sector?.isActive && !input.isActive) return setInactivating(input);
    await run(input);
  };
  const confirm = async () => {
    if (!inactivating) return;
    await run(inactivating);
    setInactivating(null);
  };
  return { inactivating, submit, confirm, cancel: () => setInactivating(null) };
}
