import type { ChannelProvider } from '@prisma/client';
import { isTeamProvider, type TeamProvider } from './team-whatsapp.policy';

/** Campos do canal lidos junto com a área (C1). */
export const SECTOR_CHANNEL_SELECT = {
  id: true,
  name: true,
  phoneE164: true,
  provider: true,
  isActive: true,
} as const;

export type SectorChannelRow = {
  id: string;
  name: string;
  phoneE164: string | null;
  provider: ChannelProvider;
  isActive: boolean;
};

export type SectorChannelRef = {
  id: string;
  name: string;
  phoneE164: string | null;
  provider: TeamProvider;
};

/**
 * Número efetivo da área (D2): o canal associado, só se estiver ativo e for de
 * um provedor que o envio da equipe aceita (GOZAP/EVOLUTION). Qualquer outro
 * caso é "sem número".
 */
export function effectiveChannel(
  row: SectorChannelRow | null,
): SectorChannelRef | null {
  if (!row || !row.isActive || !isTeamProvider(row.provider)) return null;
  return {
    id: row.id,
    name: row.name,
    phoneE164: row.phoneE164,
    provider: row.provider,
  };
}
