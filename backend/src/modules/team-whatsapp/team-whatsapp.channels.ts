import type { TeamSectorChannel } from '../../schemas/contracts/team-whatsapp.schema';
import type {
  LiveCheck,
  LiveCheckChannel,
} from '../whatsapp-providers/channel-live-state.service';
import type { SectorChannelRef } from './sector-channel';
import type { TeamSectorChannelRow } from './team-whatsapp.repository';
import {
  channelDisconnected,
  channelUnverified,
  sectorWithoutNumber,
} from './team-whatsapp.errors';

/** Bloqueio por estado ao vivo (D7): o código do erro 409 do envio. */
export type LiveBlock =
  | 'team_whatsapp.channel_disconnected'
  | 'team_whatsapp.channel_unverified'
  | null;

/** Áreas sem número efetivo (D2), na ordem recebida: o que trava o envio (GC7). */
export function missingSectors(
  sectors: readonly {
    id: string;
    name: string;
    channel: SectorChannelRef | null;
  }[],
): { id: string; name: string }[] {
  return sectors
    .filter((s) => s.channel === null)
    .map(({ id, name }) => ({ id, name }));
}

/**
 * Só `open` libera (GC7). `close`/`connecting` → desconectado, que vence
 * `unknown` (não deu para observar → não verificado); tudo aberto → null.
 */
export function liveBlock(checks: Iterable<LiveCheck>): LiveBlock {
  let unverified = false;
  for (const { state } of checks) {
    if (state === 'close' || state === 'connecting')
      return 'team_whatsapp.channel_disconnected';
    if (state === 'unknown') unverified = true;
  }
  return unverified ? 'team_whatsapp.channel_unverified' : null;
}

/** O número e o estado observado, no formato da prévia (C2); `checkedAt` em ISO. */
export function toTeamSectorChannel(
  ref: SectorChannelRef,
  check: LiveCheck,
): TeamSectorChannel {
  return {
    id: ref.id,
    name: ref.name,
    phoneE164: ref.phoneE164,
    provider: ref.provider,
    live: { state: check.state, checkedAt: check.checkedAt.toISOString() },
  };
}

/** Um canal por id, só os que existem: o que a porta do estado ao vivo consulta (D7). */
export function distinctLiveChannels(
  rows: Iterable<TeamSectorChannelRow | null>,
): LiveCheckChannel[] {
  const unique = new Map<string, LiveCheckChannel>();
  for (const row of rows) {
    if (row && !unique.has(row.id)) {
      unique.set(row.id, {
        id: row.id,
        provider: row.provider,
        evolutionInstanceName: row.evolutionInstanceName,
      });
    }
  }
  return [...unique.values()];
}

/**
 * Prévia (C2) de cada setor: número + estado ao vivo; `null` = sem número.
 * Canal sem resposta da porta vale `unknown`: nunca `open` por omissão.
 */
export function previewChannels(
  rows: ReadonlyMap<string, TeamSectorChannelRow | null>,
  checks: ReadonlyMap<string, LiveCheck>,
  now: Date,
): Map<string, TeamSectorChannel | null> {
  return new Map(
    [...rows].map(([sectorId, row]) => {
      if (!row) return [sectorId, null];
      const check = checks.get(row.id) ?? {
        channelId: row.id,
        state: 'unknown' as const,
        checkedAt: now,
      };
      return [sectorId, toTeamSectorChannel(row, check)];
    }),
  );
}

/**
 * Número de cada área do envio (GC7): qualquer área sem número efetivo trava o
 * envio inteiro (422), antes de consultar o provedor.
 */
export function requireSectorNumbers(
  sectors: readonly { id: string; name: string }[],
  found: ReadonlyMap<string, TeamSectorChannelRow | null>,
): Map<string, TeamSectorChannelRow> {
  const withChannel = sectors.map((s) => ({
    ...s,
    channel: found.get(s.id) ?? null,
  }));
  if (missingSectors(withChannel).length > 0) throw sectorWithoutNumber();
  const numbers = new Map<string, TeamSectorChannelRow>();
  for (const { id, channel } of withChannel) {
    if (channel) numbers.set(id, channel);
  }
  return numbers;
}

/**
 * Recusa do envio imediato (D7, 409): só `open` libera. Canal sem resposta da
 * porta vale `unknown`, nunca `open` por omissão.
 */
export function requireOpenNumbers(
  involved: readonly LiveCheckChannel[],
  checks: ReadonlyMap<string, LiveCheck>,
  now: Date,
): void {
  const block = liveBlock(
    involved.map(
      (c) =>
        checks.get(c.id) ?? {
          channelId: c.id,
          state: 'unknown',
          checkedAt: now,
        },
    ),
  );
  if (block === 'team_whatsapp.channel_disconnected')
    throw channelDisconnected();
  if (block === 'team_whatsapp.channel_unverified') throw channelUnverified();
}

/** Por qual número a mensagem sai (D3): o canal e o snapshot de nome e telefone. */
export type RecipientChannel = {
  channelId: string;
  channelName: string;
  channelPhoneE164: string | null;
};

/**
 * O número do destinatário a partir do número efetivo da área em que ele
 * aparece. Sem número é erro, nunca "outro número": nunca sai pela área errada.
 */
export function recipientChannel(
  ref: SectorChannelRef | undefined,
): RecipientChannel {
  if (!ref) throw sectorWithoutNumber();
  return {
    channelId: ref.id,
    channelName: ref.name,
    channelPhoneE164: ref.phoneE164,
  };
}

/** Números distintos dos destinatários, na ordem em que aparecem. */
export function recipientChannelIds(
  recipients: readonly { channelId: string | null }[],
): string[] {
  return [...new Set(recipients.flatMap((r) => r.channelId ?? []))];
}

/** `TeamWhatsappDispatch.channelId` (D3): o canal do envio de um número só; `null` com mais de um. */
export function singleChannelId(channelIds: readonly string[]): string | null {
  return channelIds.length === 1 ? channelIds[0] : null;
}
