import { useEffect, useId, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Paperclip, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ChannelProvider } from '@/features/whatsapp/api';
import { useProviderInfo } from '@/features/whatsapp/api';
import { DISABLED_PROVIDER_LABEL, isEnabledProvider } from '@/features/whatsapp/disabled-provider';
import { PROVIDER_LABEL } from '@/features/whatsapp/provider-scope';
import { readApiErrorBody } from '@/lib/api-error';
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

/** Aviso de canal de integração desligada (GC11). */
function providerDisabledNotice(provider: ChannelProvider): string {
  return `Este número usa uma integração desligada (${DISABLED_PROVIDER_LABEL[provider]}). Para responder, conecte um número Evolution em Conexões.`;
}

/**
 * O 409 `channel.provider_disabled` do back (guard de envio) chega mesmo com o
 * composer bloqueado se o dado da conversa estava defasado: devolve a mensagem
 * pt-BR do `title` (nunca o `detail`, que é dado de máquina, ex.: provider=GOZAP)
 * para exibir no lugar do "Falha ao enviar" genérico; outro erro → null.
 * `title` vazio cai no aviso de fallback informado pelo chamador.
 */
async function providerDisabledMessage(err: unknown, fallback: string): Promise<string | null> {
  const body = await readApiErrorBody(err);
  if (body?.code !== 'channel.provider_disabled') return null;
  return body.title?.trim() || fallback;
}

/** Fallback do 409 sem `title`: o aviso GC11 quando o provedor é conhecido. */
function providerDisabledFallback(disabledProvider: ChannelProvider | null): string {
  return disabledProvider
    ? providerDisabledNotice(disabledProvider)
    : 'Este número usa uma integração desligada. Para responder, conecte um número Evolution em Conexões.';
}

type ProviderInfoOrUndefined = ReturnType<typeof useProviderInfo>;

/** Provedor da conversa quando ele está DESLIGADO (R11); null = ligado ou sem provedor. */
function disabledProviderOf(provider: ChannelProvider | undefined): ChannelProvider | null {
  return provider !== undefined && !isEnabledProvider(provider) ? provider : null;
}

/** Info carregada e sem a capacidade (info ausente não afirma nada: false). */
function lacksCapability(info: ProviderInfoOrUndefined, capability: 'inboxChat' | 'chatMedia'): boolean {
  return info !== undefined && !info.capabilities.includes(capability);
}

/**
 * FAIL-CLOSED enquanto a info do provedor não chegou (`providerInfoUnknown`):
 * antes da F0 estes gates eram literais SÍNCRONOS; ao virarem assíncronos,
 * `info === undefined` (query em voo OU COM ERRO) colapsava tudo para
 * permissivo — META abria sem o banner e TWILIO/ZERNIO com a janela FECHADA
 * abriam texto E anexo. E grudava: useProviders usa staleTime/gcTime Infinity,
 * então um primeiro fetch que falha nunca é refeito. Canal desligado fica de
 * fora: ele não está em /whatsapp/providers, a info nunca chega e o composer
 * ficaria em "Carregando…" para sempre (o banner de GC11 vale por ele).
 *
 * `providerRestricted` = info CHEGOU e o adapter não implementa `inboxChat` →
 * não há caminho de envio de chat (banner "em breve"). Dirigido por CAPACIDADE,
 * não por trait; exigir a info é de propósito: "em breve" é uma afirmação sobre
 * o PROVIDER e não se afirma nada sem o dado.
 */
function providerRestrictions(provider: ChannelProvider | undefined, disabledProvider: ChannelProvider | null, info: ProviderInfoOrUndefined) {
  return {
    providerInfoUnknown: provider !== undefined && disabledProvider === null && info === undefined,
    providerRestricted: provider !== undefined && lacksCapability(info, 'inboxChat'),
  };
}

/**
 * Relógio que avança por minuto enquanto a janela de 24h está aberta — o
 * countdown do badge atualiza e o composer trava sozinho quando ela fecha.
 * Sem expiração conhecida a janela conta como fechada (fail-closed).
 */
function useSessionWindow(hasSessionWindow: boolean, expiresAt: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  const windowExpiry = hasSessionWindow && expiresAt ? Date.parse(expiresAt) : null;
  const windowOpen = windowExpiry !== null && !Number.isNaN(windowExpiry) && windowExpiry > now;
  useEffect(() => {
    if (!windowOpen) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [windowOpen]);
  return { now, windowExpiry, windowOpen };
}

/**
 * Gates de envio do composer derivados do provedor da conversa. O canal
 * desligado (R11) é decidido ANTES de olhar a info do provedor. A janela de 24h
 * é regra da META e vem do TRAIT `sessionWindow`, não de uma capacidade. Mídia
 * outbound depende da capacidade `chatMedia` e compõe sobre `restricted`:
 * qualquer motivo que já trave o texto também trava o anexo.
 */
function useProviderGate(provider: ChannelProvider | undefined, twilioWindowExpiresAt: string | null | undefined) {
  const disabledProvider = disabledProviderOf(provider);
  const info = useProviderInfo(disabledProvider ? undefined : provider);
  const hasSessionWindow = info?.traits.sessionWindow ?? false;
  const { now, windowExpiry, windowOpen } = useSessionWindow(hasSessionWindow, twilioWindowExpiresAt);
  const { providerInfoUnknown, providerRestricted } = providerRestrictions(provider, disabledProvider, info);
  const sessionWindowClosed = hasSessionWindow && !windowOpen;
  const restricted = disabledProvider !== null || providerRestricted || sessionWindowClosed || providerInfoUnknown;
  const attachRestricted = restricted || lacksCapability(info, 'chatMedia');
  return {
    disabledProvider, providerInfoUnknown, providerRestricted, hasSessionWindow,
    windowOpen, windowExpiry, now, sessionWindowClosed, restricted, attachRestricted,
  };
}

/**
 * Linhas de estado abaixo da caixa de texto. O texto do 409 de canal desligado
 * (`blockedMessage`) substitui os avisos genéricos de falha.
 */
function SendStatus({ mediaPending, mediaError, sendError, blockedMessage }: {
  mediaPending: boolean; mediaError: boolean; sendError: boolean; blockedMessage: string | null;
}) {
  const failedColor = { color: 'var(--st-failed-fg)' };
  return (
    <>
      {mediaPending ? <p className="px-4 pb-2 text-xs" style={{ color: 'var(--foreground-muted)' }}>Enviando arquivo…</p> : null}
      {blockedMessage ? <p data-testid="provider-disabled-send-error" role="alert" className="px-4 pb-2 text-xs" style={failedColor}>{blockedMessage}</p> : null}
      {mediaError && !blockedMessage ? <p className="px-4 pb-2 text-xs" style={failedColor}>Falha ao enviar o arquivo. Tente novamente.</p> : null}
      {sendError && !blockedMessage ? <p className="px-4 pb-2 text-xs" style={failedColor}>Falha ao enviar. Tente novamente.</p> : null}
    </>
  );
}

export function MessageComposer({ conversationId, reply, onClearReply, provider, twilioWindowExpiresAt }: {
  conversationId: string; reply: ReplyTarget; onClearReply: () => void;
  /**
   * Provider of the channel this conversation belongs to (multi-provider
   * channels — F4).
   *  - Provedor DESLIGADO (`!isEnabledProvider`, R11): histórico legível, mas
   *    texto, anexo e envio ficam bloqueados com o aviso de GC11.
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
  const disabledNoticeId = useId();

  const {
    disabledProvider, providerInfoUnknown, providerRestricted, hasSessionWindow,
    windowOpen, windowExpiry, now, sessionWindowClosed, restricted, attachRestricted,
  } = useProviderGate(provider, twilioWindowExpiresAt);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);

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
    setBlockedMessage(null);
    try {
      await send.mutateAsync({ text: t, quotedWaMessageId: reply?.waMessageId, quotedPreview: reply?.preview });
    } catch (err) {
      // Falha já exibida: erro inline via send.isError (ou o texto do 409 de
      // canal desligado) e, no 409 de janela fechada, toast + refetch da
      // conversa (useSendReply.onError). Mantém o texto digitado para o
      // operador não perdê-lo.
      setBlockedMessage(await providerDisabledMessage(err, providerDisabledFallback(disabledProvider)));
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
      {disabledProvider ? (
        <p id={disabledNoticeId} data-testid="provider-disabled-banner" className="px-4 pt-2 text-xs" style={{ color: 'var(--foreground-muted)' }}>
          {providerDisabledNotice(disabledProvider)}
        </p>
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
            setBlockedMessage(null);
            try {
              await sendMedia.mutateAsync({ file, caption: text.trim() || undefined });
              setText('');
            } catch (err) {
              // The rejection surfaces via sendMedia.isError below (or the
              // 409 de canal desligado); swallow it here so it isn't an
              // unhandled promise rejection.
              setBlockedMessage(await providerDisabledMessage(err, providerDisabledFallback(disabledProvider)));
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
          aria-describedby={disabledProvider ? disabledNoticeId : undefined}
          className="max-h-32 min-h-9 flex-1 resize-none"
        />
        <Button type="button" onClick={() => void submit()} disabled={!text.trim() || send.isPending || restricted} aria-label="Enviar" aria-describedby={disabledProvider ? disabledNoticeId : undefined}>
          <Send className="size-4" />
        </Button>
      </div>
      <SendStatus
        mediaPending={sendMedia.isPending}
        mediaError={sendMedia.isError}
        sendError={send.isError && !sessionWindowClosed}
        blockedMessage={blockedMessage}
      />
    </div>
  );
}
