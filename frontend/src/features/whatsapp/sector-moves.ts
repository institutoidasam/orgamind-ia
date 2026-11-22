export type NumberRef = { name: string; phoneE164: string | null };
type SectorChannelRef = NumberRef & { id: string };
export type SectorWithChannel = {
  id: string;
  name: string;
  channel: SectorChannelRef | null;
};
export type SectorMove = { sectorName: string; from: NumberRef };

/**
 * Áreas escolhidas que hoje atendem por OUTRO número (D16: a confirmação de mover
 * é montada aqui, a partir do `channel` de cada setor). Na criação, `channelId` é
 * `null`: toda área escolhida que já tem número muda de número.
 */
export function sectorMoves(
  selected: readonly string[],
  sectors: readonly SectorWithChannel[],
  channelId: string | null,
): SectorMove[] {
  return sectors.flatMap(({ id, name, channel }) =>
    channel && selected.includes(id) && channel.id !== channelId
      ? [{ sectorName: name, from: { name: channel.name, phoneE164: channel.phoneE164 } }]
      : [],
  );
}

/** O mesmo que a lista GoZap mostra (`phoneE164`); sem telefone, o nome do número. */
export function numberLabel(number: NumberRef): string {
  return number.phoneE164 ?? number.name;
}

/** A linha do número na lista: `Áreas: Logística, Expedição` ou `Nenhuma área`. */
export function areasLabel(sectors: readonly { name: string }[] | undefined): string {
  return sectors && sectors.length > 0 ? `Áreas: ${sectors.map((s) => s.name).join(', ')}` : 'Nenhuma área';
}
