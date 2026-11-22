import { liveBlock } from './channel-availability';
import type { TeamSectorChannel } from './schemas';

/** O que a prévia precisa de cada área: o número efetivo (null = área sem número). */
export type RosterSectorView = { sectorId: string; name: string; channel: TeamSectorChannel | null };

export type ChannelGroupView = {
  channel: TeamSectorChannel;
  sectors: { name: string; count: number }[];
};

/** `missing` vence `disconnected`, que vence `unverified` (mesma ordem de recusa do servidor). */
export type SendBlock = 'missing' | 'disconnected' | 'unverified';

export type ChannelGroupsResult = {
  groups: ChannelGroupView[];
  missing: { id: string; name: string }[];
  block: SendBlock | null;
};

function blockOf(groups: ChannelGroupView[], hasMissing: boolean): SendBlock | null {
  if (hasMissing) return 'missing';
  const blocks = groups.map((g) => liveBlock(g.channel.live.state));
  if (blocks.includes('disconnected')) return 'disconnected';
  return blocks.includes('unverified') ? 'unverified' : null;
}

/**
 * Divide as áreas do envio por número (um grupo por número, na ordem das áreas). Área sem número
 * vai para `missing`; `receivingBySector` dá quantas pessoas de cada área recebem.
 */
export function buildChannelGroups(
  sectors: readonly RosterSectorView[],
  receivingBySector: ReadonlyMap<string, number>,
): ChannelGroupsResult {
  const byChannel = new Map<string, ChannelGroupView>();
  const missing: ChannelGroupsResult['missing'] = [];
  for (const { sectorId, name, channel } of sectors) {
    if (!channel) {
      missing.push({ id: sectorId, name });
      continue;
    }
    const group = byChannel.get(channel.id) ?? { channel, sectors: [] };
    group.sectors.push({ name, count: receivingBySector.get(sectorId) ?? 0 });
    byChannel.set(channel.id, group);
  }
  const groups = [...byChannel.values()];
  return { groups, missing, block: blockOf(groups, missing.length > 0) };
}

/**
 * Quantas pessoas de cada área recebem: a escala traz cada pessoa em um só setor, então basta
 * cruzar os membros de cada setor com a lista de quem recebe.
 */
export function receivingBySector(
  sectors: readonly { sectorId: string; members: readonly { id: string }[] }[],
  recipients: readonly { id: string }[],
): Map<string, number> {
  const ids = new Set(recipients.map((r) => r.id));
  return new Map(sectors.map((s) => [s.sectorId, s.members.filter((m) => ids.has(m.id)).length]));
}

/** Número como a lista de conexões mostra (`phoneE164` cru); sem telefone, o nome do canal. */
export function channelNumber(channel: Pick<TeamSectorChannel, 'name' | 'phoneE164'>): string {
  return channel.phoneE164 ?? channel.name;
}
