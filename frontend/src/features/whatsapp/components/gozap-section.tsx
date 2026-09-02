import { useState } from 'react';
import { Plus } from 'lucide-react';
import { type ChannelSummary } from '../api';
import { Button } from '@/components/ui/button';
import { CreateGozapChannelDialog } from './create-gozap-channel-dialog';
import { GozapQrDialog } from './gozap-qr-dialog';
import { RemoveGozapChannelDialog } from './remove-gozap-channel-dialog';
import { ConnectionStateBadge } from '../provider-scope';

/**
 * The GOZAP provider section of the Canais page. GOZAP is session-based
 * (pairs by QR — same family as EVOLUTION/Baileys) but PROVISIONS
 * EXTERNALLY: creating a channel makes the backend spin up an instance on
 * the GoZap SaaS, encrypt its token and arm the webhook (unlike
 * EVOLUTION's local Baileys session). That difference is why this is its
 * own section instead of folding into EvolutionSection — see connect.tsx's
 * routing comment. Reavaliar unificação na F-B.
 *
 * `channels` comes straight from `useProviders()` (via connect.tsx) — this
 * section renders only what the GOZAP provider actually reports, never a
 * hardcoded list.
 *
 * FILTRO isActive — diferente do CloudProviderSection (TWILIO/ZERNIO/META),
 * onde "inativo" é um estado REVERSÍVEL (PATCH active:true religa o canal),
 * GOZAP não tem esse botão: a ÚNICA forma de um canal GOZAP virar isActive
 * false é a remoção definitiva (DELETE /whatsapp/channels/:id — derruba a
 * instância no GoZap, sem caminho de volta). `GET /whatsapp/providers`
 * devolve TODO canal, ativo e inativo (contrato do backend), então sem este
 * filtro um canal removido continuava aparecendo na lista para sempre — era
 * exatamente o "Remover conexão não remove" relatado pelo cliente: o clique
 * funcionava (a instância caía no GoZap), só a TELA nunca refletia.
 */
export function GozapSection({
  role,
  channels,
}: {
  role: 'ADMIN' | 'OPERATOR';
  channels: ChannelSummary[];
}) {
  const visibleChannels = channels.filter((ch) => ch.isActive);
  const [createOpen, setCreateOpen] = useState(false);
  const [connect, setConnect] = useState<{ id: string; name: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="ds-display !text-3xl">Conexões</h2>
        {role === 'ADMIN' && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 size-4" /> Nova conexão
          </Button>
        )}
      </div>

      {visibleChannels.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--border)] px-3 py-6 text-center text-sm text-[var(--foreground-muted)]">
          Nenhum canal GoZap cadastrado ainda.
        </p>
      ) : (
        <div className="space-y-2">
          {visibleChannels.map((ch) => (
            <div
              key={ch.id}
              className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <strong className="truncate text-sm">{ch.name}</strong>
                  {ch.isDefault && (
                    <span className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                      default
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-[var(--foreground-muted)]">
                  {ch.phoneE164 ?? '—'}
                </div>
                <ConnectionStateBadge state={ch.connectionState} />
              </div>

              <button
                type="button"
                className="rounded border border-[var(--border)] px-2 py-1 text-xs"
                onClick={() => setConnect({ id: ch.id, name: ch.name })}
              >
                Conectar
              </button>

              {role === 'ADMIN' && (
                <button
                  type="button"
                  className="rounded border border-[var(--border)] px-2 py-1 text-xs text-destructive"
                  onClick={() => setRemoveTarget({ id: ch.id, name: ch.name })}
                  title="Remove a conexão de forma definitiva — pede confirmação"
                >
                  Remover
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <CreateGozapChannelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(channel) => {
          setCreateOpen(false);
          // Cria e já abre o QR: sem isto o operador criaria o canal e não
          // teria caminho nenhum na tela para de fato parear o número.
          setConnect({ id: channel.id, name: channel.name });
        }}
      />

      <GozapQrDialog
        channelId={connect?.id ?? null}
        channelName={connect?.name ?? 'conexão'}
        open={!!connect}
        onOpenChange={(open) => { if (!open) setConnect(null); }}
      />

      <RemoveGozapChannelDialog
        channel={removeTarget}
        open={!!removeTarget}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
      />
    </div>
  );
}
