import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ChannelProvider,
  type ChannelSummary,
  useSyncZernioInbox,
  useZernioSyncStatus,
  useChannelHealth,
  useUpdateChannel,
} from '../api';
import { CloudChannelList } from './cloud-channel-list';
import { CreateChannelForm } from './create-channel-form';
import { ChannelHealthCard } from './channel-health-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { extractApiError } from '@/lib/api-error';

/**
 * A cloud-provider (TWILIO/ZERNIO/META) section of the Canais page: the list of
 * registered channels, a provider-specific note where relevant (Zernio's WABA
 * is connected in Zernio's own dashboard), and — for admins — the
 * channel-registration form. Unlike EVOLUTION there's no QR/restart flow: the
 * number is already live on the provider's side.
 *
 * Em canais ZERNIO o ADMIN ganha "Sincronizar inbox": o disparo pode ter saído
 * pelo PAINEL do Zernio (fora do orgamind), e o histórico anterior ao webhook não
 * entra sozinho. O orgamind é a visão única — este botão é como o operador força
 * essa promessa a valer agora, sem esperar o tick de 10 min.
 *
 * O botão ENFILEIRA e ACOMPANHA (202 + polling do status). Antes ele segurava uma
 * request de até 3 minutos que terminava em HTTP 500 quando o Zernio recusava a
 * 61ª conversa (balde de 60 req/min). Agora a tela mostra "42 de 100 conversas…"
 * e, no fim, o que entrou — inclusive quando algumas conversas falharam.
 */
/**
 * BROADCAST DO ZERNIO — as duas chaves que decidem COMO a campanha sai.
 *
 * Até agora só existiam no banco: ligá-las exigia SQL direto em produção.
 *
 * O texto desta caixa é a parte mais importante dela. O broadcast do Zernio
 * **não personaliza**: o `/recipients` deles só aceita telefones, e as variáveis
 * do template são resolvidas contra o CRM DO ZERNIO — onde o contato que nós
 * criamos por telefone nasce SEM NOME. Um template com `{{1}} = nome` sairia como
 * "Olá , tudo bem?" para a base inteira. Por isso o backend BLOQUEIA o caminho de
 * broadcast quando a campanha usa variável de campo e a manda pelo 1-a-1.
 *
 * Se a tela não disser isso, o operador liga a flag, dispara, não vê nada no
 * painel do Zernio e conclui que o orgamind está quebrado.
 */
function ZernioBroadcastPanel({
  channel,
  onSave,
  saving,
}: {
  channel: ChannelSummary;
  onSave: (settings: {
    zernioBroadcastEnabled?: boolean;
    zernioBroadcastChunk?: number;
  }) => void;
  saving: boolean;
}) {
  const enabled = channel.zernioBroadcastEnabled ?? false;
  const [chunk, setChunk] = useState<string>(
    String(channel.zernioBroadcastChunk ?? 50),
  );

  return (
    <div className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <strong className="text-sm">Broadcast do Zernio</strong>
          <div className="truncate text-xs text-[var(--foreground-muted)]">
            {channel.name} · {enabled ? 'ligado' : 'desligado (envio 1-a-1)'}
          </div>
        </div>
        <button
          type="button"
          className="rounded border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-50"
          disabled={saving}
          onClick={() => onSave({ zernioBroadcastEnabled: !enabled })}
        >
          {enabled ? 'Desligar broadcast' : 'Ligar broadcast'}
        </button>
      </div>

      <p
        data-testid="broadcast-explainer"
        className="text-xs text-[var(--foreground-muted)]"
      >
        <strong>Ligado:</strong> a campanha vira um broadcast nativo e{' '}
        <strong>aparece no painel do Zernio</strong>.{' '}
        <strong>Desligado:</strong> envio 1-a-1 — é o <strong>padrão</strong> e o{' '}
        <strong>fallback</strong>.
        <br />
        ⚠️ <strong>O broadcast do Zernio não personaliza.</strong> Ele não aceita
        variável por pessoa. Uma campanha cujo template usa variável de campo (ex.:{' '}
        <code>{'{{1}}'}</code> = nome do contato) <strong>cai automaticamente no
        1-a-1</strong>, mesmo com esta chave ligada — e por isso não vai aparecer no
        painel do Zernio. Só campanhas sem variável (ou com variáveis de texto fixo)
        saem como broadcast.
      </p>

      {enabled && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label
              htmlFor={`chunk-${channel.id}`}
              className="block text-xs text-[var(--foreground-muted)]"
            >
              Destinatários por requisição
            </label>
            <input
              id={`chunk-${channel.id}`}
              data-testid="broadcast-chunk"
              type="number"
              min={1}
              max={100}
              value={chunk}
              onChange={(e) => setChunk(e.target.value)}
              className="w-24 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
            />
          </div>
          <button
            type="button"
            className="rounded border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-50"
            disabled={saving}
            onClick={() => {
              const n = Number(chunk);
              if (!Number.isFinite(n) || n < 1) return;
              onSave({ zernioBroadcastChunk: Math.min(Math.floor(n), 100) });
            }}
          >
            Salvar
          </button>
          <span className="pb-1 text-xs text-[var(--foreground-muted)]">
            Tamanho de cada chamada interna ao Zernio — NÃO divide o disparo
            (a campanha sai como um broadcast só, cortado no limite da janela
            de 24h). Máximo 100 por requisição; o padrão (50) é conservador de
            propósito.
          </span>
        </div>
      )}
    </div>
  );
}

export function CloudProviderSection({
  provider,
  channels,
  role,
}: {
  provider: ChannelProvider;
  channels: ChannelSummary[];
  role: 'ADMIN' | 'OPERATOR';
}) {
  const qc = useQueryClient();
  const sync = useSyncZernioInbox();
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const canSync = provider === 'ZERNIO' && role === 'ADMIN';
  const { data: status } = useZernioSyncStatus(syncingId);
  // O run já foi anunciado? Sem isto, cada refetch do polling repetiria o toast.
  const reported = useRef<string | null>(null);

  // ZB — a saúde vem do Zernio ao vivo e o endpoint é ADMIN-only; um OPERATOR
  // tomaria 403. Só ZERNIO por enquanto (é o único provedor cujo `number-info`
  // o orgamind lê).
  const canSeeHealth = provider === 'ZERNIO' && role === 'ADMIN';
  const { data: healthData } = useChannelHealth(canSeeHealth);
  const healthByChannel = new Map(
    (healthData?.channels ?? []).map((h) => [h.channelId, h]),
  );

  async function handleSync(id: string) {
    reported.current = null;
    try {
      await sync.mutateAsync(id);
      setSyncingId(id); // daqui em diante quem fala é o polling
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    }
  }

  // CANAL ÚNICO — só ADMIN liga/desliga canal. Um OPERATOR que pudesse religar o
  // canal proibido anularia a trava inteira.
  const canToggle = role === 'ADMIN';
  const updateChannel = useUpdateChannel();
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // BROADCAST — mesmo endpoint, mesmo hook. Só ZERNIO, só ADMIN.
  const canConfigureBroadcast = provider === 'ZERNIO' && role === 'ADMIN';
  const [savingBroadcastId, setSavingBroadcastId] = useState<string | null>(null);

  async function handleSaveBroadcast(
    id: string,
    settings: { zernioBroadcastEnabled?: boolean; zernioBroadcastChunk?: number },
  ) {
    setSavingBroadcastId(id);
    try {
      await updateChannel.mutateAsync({ id, ...settings });
      toast.success(
        settings.zernioBroadcastEnabled === undefined
          ? 'Configuração do broadcast salva'
          : settings.zernioBroadcastEnabled
            ? 'Broadcast ligado'
            : 'Broadcast desligado — as campanhas voltam ao envio 1-a-1',
        {
          description:
            settings.zernioBroadcastEnabled === true
              ? 'Campanhas SEM variável de campo passam a aparecer no painel do Zernio. As que usam variável continuam saindo pelo 1-a-1.'
              : undefined,
        },
      );
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    } finally {
      setSavingBroadcastId(null);
    }
  }

  async function handleSetActive(id: string, active: boolean) {
    setTogglingId(id);
    try {
      await updateChannel.mutateAsync({ id, active });
      toast.success(active ? 'Canal reativado' : 'Canal desativado', {
        description: active
          ? 'Ele volta a aparecer como opção de envio.'
          : 'Ele some do assistente de campanha e das abas do inbox. Nada foi apagado.',
      });
    } catch (err) {
      // O caso real: reativar um canal cuja conta Zernio já foi tomada por outro
      // canal ativo. O backend recusa com o motivo — mostre-o, não um erro mudo.
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    } finally {
      setTogglingId(null);
    }
  }

  // O job terminou (SUCCEEDED/FAILED): anuncia o resultado UMA vez e encerra.
  useEffect(() => {
    if (!status?.runId) return;
    if (status.status !== 'SUCCEEDED' && status.status !== 'FAILED') return;
    if (reported.current === status.runId) return;
    reported.current = status.runId;

    if (status.status === 'FAILED') {
      // O MOTIVO, não um 500 mudo: "chave revogada (401)", "Zernio fora"…
      toast.error('Sync do inbox falhou', {
        description: status.error ?? 'Motivo não informado pelo servidor.',
      });
      setSyncingId(null);
      return;
    }

    const parts = [
      `${status.processed} conversa(s)`,
      `${status.imported} mensagem(ns) nova(s)`,
    ];
    // Falha PARCIAL não é erro: 98 conversas entraram. Dizer "deu erro" apagaria
    // as 98 — que era exatamente o efeito do HTTP 500.
    if (status.failed > 0) parts.push(`${status.failed} conversa(s) com falha`);
    // Rodar 2x e não achar nada é o caso NORMAL (o sync é idempotente): dizer
    // isso com todas as letras evita que o operador ache que quebrou.
    toast.success(
      status.imported > 0 ? 'Inbox sincronizada' : 'Inbox já estava em dia — nada novo',
      { description: parts.join(' · ') },
    );
    // As conversas importadas têm de aparecer na inbox sem F5.
    void qc.invalidateQueries({ queryKey: ['chat'] });
    setSyncingId(null);
  }, [status, qc]);

  return (
    <div className="space-y-3">
      <CloudChannelList
        channels={channels}
        onSyncInbox={canSync ? (id) => void handleSync(id) : undefined}
        syncingId={syncingId}
        syncStatus={status ?? null}
        onSetActive={
          canToggle ? (id, active) => void handleSetActive(id, active) : undefined
        }
        togglingId={togglingId}
      />

      {/* A tela tem de DIZER o que "Desativar" faz. Sem isto o operador ou não
          clica (achando que apaga a conversa) ou clica achando que apagou o canal.
          O texto é o contrato inteiro da feature, em duas linhas. */}
      {canToggle && channels.length > 0 && (
        <p
          data-testid="deactivate-explainer"
          className="text-xs text-[var(--foreground-muted)]"
        >
          <strong>Desativar não apaga o canal.</strong> As conversas e o histórico
          dele continuam no inbox. O canal desativado deixa de ser oferecido no
          assistente de campanha e nas abas de número do inbox, e não pode ser usado
          para enviar — é a trava contra disparar pelo número errado. Dá para
          reativar a qualquer momento.
        </p>
      )}

      {/* ZB — a saúde ANTES do disparo. Um card por canal, na ordem da lista, e
          só para os canais que a leitura alcançou (um canal recém-criado ou com
          o Zernio fora do ar simplesmente não ganha card, em vez de ganhar um
          card vazio que ninguém sabe interpretar). */}
      {channels.map((ch) => {
        const health = healthByChannel.get(ch.id);
        return health ? (
          <ChannelHealthCard key={ch.id} health={health} />
        ) : null;
      })}

      {canConfigureBroadcast &&
        channels.map((ch) => (
          <ZernioBroadcastPanel
            key={ch.id}
            channel={ch}
            saving={savingBroadcastId === ch.id}
            onSave={(settings) => void handleSaveBroadcast(ch.id, settings)}
          />
        ))}

      {provider === 'ZERNIO' && (
        <Alert>
          <AlertTitle>Conecte a WABA no dashboard do Zernio</AlertTitle>
          <AlertDescription>
            A conexão da conta WhatsApp Business (WABA) é feita no painel do
            Zernio. Aqui você apenas registra o canal para roteamento e envio.
          </AlertDescription>
        </Alert>
      )}

      {role === 'ADMIN' && <CreateChannelForm provider={provider} />}
    </div>
  );
}
