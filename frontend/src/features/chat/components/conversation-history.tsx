import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useConversationHistory } from '../api';
import { HISTORY_TRUNCATED_TEXT, historyLine, historyTime } from '../history-text';
import { Button } from '@/components/ui/button';

const MUTED = { color: 'var(--foreground-muted)' };

/** Corpo da seção: só existe (e só consulta) com a seção aberta (DK19). */
function HistoryBody({ conversationId }: { conversationId: string }) {
  const history = useConversationHistory(conversationId, true);

  if (history.isError && !history.data) {
    return (
      <div className="flex items-center gap-2 text-xs" style={MUTED}>
        <span>Não foi possível carregar o histórico</span>
        <Button size="sm" variant="outline" disabled={history.isFetching} onClick={() => history.refetch()}>
          Tentar de novo
        </Button>
      </div>
    );
  }
  if (!history.data) return <p className="text-xs" style={MUTED}>Carregando histórico…</p>;
  if (history.data.items.length === 0) return <p className="text-xs" style={MUTED}>Nenhuma mudança registrada.</p>;

  return (
    <>
      <ol className="space-y-1.5 text-xs">
        {history.data.items.map((item) => (
          <li key={item.id}>
            <div data-testid="history-line">{historyTime(item.createdAt)} · {historyLine(item)}</div>
            {item.note ? <div style={MUTED}>Observação: {item.note}</div> : null}
          </li>
        ))}
      </ol>
      {history.data.hasMore ? <p className="mt-2 text-xs" style={MUTED}>{HISTORY_TRUNCATED_TEXT}</p> : null}
    </>
  );
}

/** "Histórico da conversa" (K1-2): recolhido por padrão; a consulta só roda ao abrir. */
export function ConversationHistory({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section
      data-testid="conversation-history"
      className="px-4 py-1.5"
      style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs font-medium"
        style={MUTED}
      >
        <Chevron className="size-3.5" />
        Histórico da conversa
      </button>
      {/* Corpo sempre presente (alvo do aria-controls); o conteúdo só monta aberto. */}
      <div id={bodyId} hidden={!open} className="mt-2 max-h-48 overflow-y-auto pb-1">
        {open ? <HistoryBody conversationId={conversationId} /> : null}
      </div>
    </section>
  );
}
