import type { SectorChannel } from '../../schemas/contracts/sector.schema';
import {
  effectiveChannel,
  type SectorChannelRow,
} from '../team-whatsapp/sector-channel';

/**
 * C1: o número que o setor mostra é o efetivo (D2), sem o provedor. Canal
 * inativo ou de TWILIO/ZERNIO vira `null`. O telefone é da empresa (GC8).
 */
export function toSectorChannel(
  row: SectorChannelRow | null,
): SectorChannel | null {
  const channel = effectiveChannel(row);
  if (!channel) return null;
  return {
    id: channel.id,
    name: channel.name,
    phoneE164: channel.phoneE164,
  };
}
