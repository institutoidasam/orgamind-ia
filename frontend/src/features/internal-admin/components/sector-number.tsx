import { Badge } from "@/components/ui/badge";
import { numberLabel } from "@/features/whatsapp/sector-moves";
import type { SectorChannel } from "../schemas";

/** O número que atende a área (C1) ou o selo "Sem número" quando ela não tem. */
export function SectorNumber({ channel }: { channel: SectorChannel | null }) {
  if (!channel) return <Badge variant="destructive">Sem número</Badge>;
  return <span>{numberLabel(channel)}</span>;
}
