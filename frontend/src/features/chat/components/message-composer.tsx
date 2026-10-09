import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Paperclip, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ChannelProvider } from '@/features/whatsapp/api';
import { useProviderInfo } from '@/features/whatsapp/api';
import { PROVIDER_LABEL } from '@/features/whatsapp/provider-scope';
import { useSendReply, useTyping, useSendMedia } from '../api';

export type ReplyTarget = { waMessageId: string; preview: string } | null;

/**
 * Resto da janela de 24h em PT-BR: "5h 32min" / "45min". Nunca "0min" — abaixo
 * de um minuto arredonda para "1min" (o tick por minuto fecha o composer logo
 * em seguida). Exportado para teste unitário.
 */
export function formatWindowRemaining(ms: number): string {
  const totalMin = Math.max(1, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

export function MessageComposer({ conversationId, reply, onClearReply, provider, twilioWindowExpiresAt }: {
  conversationId: string; reply: ReplyTarget; onClearReply: () => void;
  /**
   * Provider of the channel this conversation belongs to (multi-provider
   * channels — F4).
   *  - EVOLUTION: free-text sempre liberado (Baileys não tem janela).
   *  - TWILIO e ZERNIO: texto de sessão liberado DENTRO da janela de 24h da
   *    Meta (ver twilioWindowExpiresAt); fora dela o backend responde 409
   *    chat.twilio_window_closed — o composer trava antes disso.
   *  - META: segue bloqueado ("em breve") — não há caminho de envio.
   * Left `undefined` (dado de conversa ausente/legado) é tratado como
   * irrestrito — ramo histórico, anterior ao multi-provider. NÃO confundir com
   * "provider conhecido mas a info do provider ainda não carregou": esse é
   * fail-closed (ver `providerInfoUnknown` abaixo).
   */
  provider?: ChannelProvider;
  /**
   * Fim da janela de atendimento de 24h (ISO) vindo do resumo da conversa.
   * Considerado nos canais com janela de sessão (TWILIO e ZERNIO). null/ausente
   * = janela fechada (nenhum inbound registrado, ou backend antigo que ainda não
   * expõe o campo — nesse caso o envio falharia de qualquer forma). O nome do
   * campo é histórico; a regra é da Meta, não da Twilio.
   */
  twilioWindowExpiresAt?: string | null;
}) {
  const [text, setText] = useState('');
  const send = useSendReply(conversationId);
  const typing = useTyping(conversationId);
  const sendMedia = useSendMedia(conversationId);
  const lastTyping = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const info = useProviderInfo(provider);
  // A janela de 24h é regra da META, não mecânica do adapter: continua vindo
  // do TRAIT `sessionWindow` (vale para todo canal com essa política — TWILIO
  // e ZERNIO hoje), não de uma capacidade.
  const hasSessionWindow = info?.traits.sessionWindow ?? false;
  // FAIL-CLOSED enquanto a info do provider não chegou. Antes da F0 estes
  // gates eram literais SÍNCRONOS; ao virarem assíncronos, `info === undefined`
  // (query em voo OU COM ERRO) colapsava tudo para permissivo — META abria sem
  // o banner e TWILIO/ZERNIO com a janela FECHADA abriam texto E anexo. Isso
  // não preservava "o default permissivo histórico": META nunca foi
  // permissivo. E grudava: useProviders usa staleTime/gcTime Infinity, então
  // um primeiro fetch que falha nunca fica stale nem é refeito — o permissivo
  // duraria a sessão inteira. Fechar custa ~zero: a query é cacheada app-wide
  // e a lista de conversas monta antes, aquecendo o cache.
  const providerInfoUnknown = provider !== undefined && info === undefined;
  // Restrito = tem provider, a info CHEGOU e o adapter não implementa
  // `inboxChat` → não existe caminho de envio de chat (META hoje): banner "em
  // breve". Dirigido por CAPACIDADE (o que o adapter de fato implementa), não
  // por trait (política): um futuro provider `sessionBased` que não seja a
  // Evolution e não tenha `inboxChat` cai aqui igual ao META, em vez de abrir
  // a caixa de texto contra um backend que lança exceção. Exigir a info
  // carregada é de propósito: "em breve" é uma afirmação sobre o PROVIDER, e
  // não se afirma nada sem o dado — sem ela vale o estado neutro de
  // carregamento, não este banner.
  const providerRestricted =
    provider !== undefined && info !== undefined &&
    !info.capabilities.includes('inboxChat');

  // Relógio que avança por minuto enquanto a janela está aberta — o countdown do
  // badge atualiza e o composer trava sozinho quando ela fecha.
  const [now, setNow] = useState(() => Date.now());
  const windowExpiry = hasSessionWindow && twilioWindowExpiresAt ? Date.parse(twilioWindowExpiresAt) : null;
  const windowOpen = windowExpiry !== null && !Number.isNaN(windowExpiry) && windowExpiry > now;
  useEffect(() => {
    if (!windowOpen) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [windowOpen]);

  // Fail-closed: canal com janela e sem expiração conhecida = fechada.
  const sessionWindowClosed = hasSessionWindow && !windowOpen;
  const restricted = providerRestricted || sessionWindowClosed || providerInfoUnknown;
  // Mídia outbound via chat depende da capacidade `chatMedia` do adapter
  // (chat-media.service lança ChannelNotEvolutionError quando ausente) — hoje
  // só EVOLUTION a implementa. Composto sobre `restricted`, não substituído:
  // qualquer motivo que já trave o texto (sem info, sem inboxChat, janela
  // fechada) também trava o anexo. O `info !== undefined` extra é o que
  // preserva o ramo `provider === undefined` liberado — sem `info` não há
  // capacidade nenhuma para checar, e ali `restricted` já é `false`.
  const attachRestricted =
    restricted || (info !== undefined && !info.capabilities.includes('chatMedia'));

  // Tracks whether a 'composing' indicator is currently outstanding so we only
  // emit 'paused' when there's something to pause (avoids spamming the wire).
  const composing = useRef(false);

  function emitPaused() {
    if (!composing.current) return;
    composing.current = false;
    lastTyping.current = 0;
    typing.mutate('paused');
  }

  function onChange(v: string) {
    if (restricted) return;
    setText(v);
    const now = Date.now();
    if (v && now - lastTyping.current > 2500) {
      lastTyping.current = now;
      composing.current = true;
      typing.mutate('composing');
    }
    // Clearing the box stops typing — let the contact's "typing…" indicator drop.
    if (!v) emitPaused();
  }

  async function submit() {
    if (restricted) return;
    const t = text.trim();
    if (!t || send.isPending) return;
    try {
      await send.mutateAsync({ text: t, quotedWaMessageId: reply?.waMessageId, quotedPreview: reply?.preview });
    } catch {
      // Falha já exibida: erro inline via send.isError e, no 409 de janela
      // fechada, toast + refetch da conversa (useSendReply.onError). Mantém o
      // texto digitado para o operador não perdê-lo.
      return;
    }
    setText('');
    emitPaused();
    onClearReply();
  }

  return (
    <div style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
      {reply ? (
        <div className="flex items-center justify-between gap-2 px-4 pt-2 text-xs" style={{ color: 'var(--foreground-muted)' }}>
          <span className="truncate" style={{ borderLeft: '3px solid var(--brand-orange)', paddingLeft: 8 }}>↩︎ {reply.preview}</span>
          <button type="button" onClick={onClearReply} aria-label="Cancelar resposta"><X className="size-3.5" /></button>
        </div>
      ) : null}
      {providerInfoUnknown ? (
        <p data-testid="provider-traits-loading" className="px-4 pt-2 text-xs" style={{ color: 'var(--foreground-muted)' }}>
          Carregando…
        </p>
      ) : null}
      {providerRestricted ? (
        <p data-testid="provider-not-supported-banner" className="px-4 pt-2 text-xs" style={{ color: 'var(--foreground-muted)' }}>
          Respostas por este canal ainda não estão disponíveis — o envio de texto livre por {PROVIDER_LABEL[provider!]} será liberado em breve.
        </p>
      ) : null}
      {hasSessionWindow && windowOpen && windowExpiry !== null ? (
        <p data-testid="twilio-window-badge" className="px-4 pt-2 text-xs" style={{ color: 'var(--foreground-muted)' }}>
          Janela fecha em {formatWindowRemaining(windowExpiry - now)}
        </p>
      ) : null}
      {sessionWindowClosed ? (
        <div data-testid="twilio-window-closed-banner" className="flex items-center justify-between gap-2 px-4 pt-2 text-xs" style={{ color: 'var(--foreground-muted)' }}>
          <span>Janela de 24h fechada — envie um template aprovado para reabrir a conversa.</span>
          {/* Caminho mais simples existente para enviar um template aprovado:
              o fluxo de campanha (não há envio avulso de template 1:1 hoje). */}
          <Link to="/campaigns/new" className="shrink-0 font-medium underline" style={{ color: 'var(--brand-blue)' }}>
            Enviar template
          </Link>
        </div>
      ) : null}
      <div className="flex items-end gap-2 px-4 py-3">
        <input ref={fileRef} type="file" hidden data-testid="chat-file-input"
          onChange={async (e) => {
            const input = e.target;
            const file = input.files?.[0];
            if (!file || attachRestricted) return;
            try {
              await sendMedia.mutateAsync({ file, caption: text.trim() || undefined });
              setText('');
            } catch {
              // The rejection surfaces via sendMedia.isError below; swallow it
              // here so it isn't an unhandled promise rejection.
            } finally {
              // Always reset so the SAME file can be re-selected after a failure
              // (the browser won't re-fire onChange for an unchanged value).
              input.value = '';
            }
          }} />
        <button type="button" onClick={() => { if (!attachRestricted) fileRef.current?.click(); }} disabled={sendMedia.isPending || attachRestricted} aria-label="Anexar" className="shrink-0" style={{ color: 'var(--foreground-muted)' }}>
          <Paperclip className="size-5" />
        </button>
        <Textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={emitPaused}
          onPaste={(e) => { if (restricted) e.preventDefault(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
          placeholder="Escreva uma mensagem…"
          rows={1}
          disabled={restricted}
          className="max-h-32 min-h-9 flex-1 resize-none"
        />
        <Button type="button" onClick={() => void submit()} disabled={!text.trim() || send.isPending || restricted} aria-label="Enviar">
          <Send className="size-4" />
        </Button>
      </div>
      {sendMedia.isPending ? <p className="px-4 pb-2 text-xs" style={{ color: 'var(--foreground-muted)' }}>Enviando arquivo…</p> : null}
      {sendMedia.isError ? <p className="px-4 pb-2 text-xs" style={{ color: 'var(--st-failed-fg)' }}>Falha ao enviar o arquivo. Tente novamente.</p> : null}
      {send.isError && !sessionWindowClosed ? <p className="px-4 pb-2 text-xs" style={{ color: 'var(--st-failed-fg)' }}>Falha ao enviar. Tente novamente.</p> : null}
    </div>
  );
}
