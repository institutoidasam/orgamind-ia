import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTemplates } from '@/features/templates/api';
import { TemplateFormDialog } from '@/features/templates/components/template-form-dialog';
import { ConsentButtonsDialog } from '@/features/templates/components/consent-buttons-dialog';
import { DeleteTemplateDialog } from '@/features/templates/components/delete-template-dialog';
import type { Template } from '@/features/templates/schemas';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { ProviderBadge } from '@/features/whatsapp/provider-scope';

export const Route = createFileRoute('/_authenticated/templates')({
  component: TemplatesPage,
});

const TEMPLATE_STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Aprovado',
  PENDING: 'Pendente',
  REJECTED: 'Rejeitado',
  PAUSED: 'Pausado',
};

// twilio-platform T3 — badge colorido por status: Aprovado verde, Pendente
// âmbar, Rejeitado vermelho, Pausado laranja (âmbar ocupa o Pendente). Segue o
// padrão de classes claro/escuro já usado em schedule-info-card.tsx. Status
// fora do enum (defensivo) cai no visual outline padrão.
const TEMPLATE_STATUS_BADGE_CLASS: Record<string, string> = {
  APPROVED:
    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  PENDING:
    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  REJECTED:
    'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  PAUSED:
    'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-300',
};

// Só REJEITADO/PAUSADO expõem o motivo — um template re-aprovado pode manter
// um twilioRejectionReason antigo na coluna, que não deve reaparecer no card.
const STATUSES_WITH_REASON = new Set(['REJECTED', 'PAUSED']);

/**
 * Rótulo relativo simples (sem lib) para o frescor do catálogo Twilio.
 * O valor chega como ISO string em runtime (o fetch não passa pelo zod),
 * por isso aceita `Date | string`.
 */
function syncFreshnessLabel(
  syncedAt: Date | string,
  now: number = Date.now(),
): string {
  const diffMs = Math.max(0, now - new Date(syncedAt).getTime());
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'sincronizado agora';
  if (mins < 60) return `sincronizado há ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `sincronizado há ${hours} h`;
  return `sincronizado há ${Math.floor(hours / 24)} d`;
}

const TEMPLATE_KIND_LABEL: Record<string, string> = {
  TEXT: 'texto',
  LIST: 'lista',
  BUTTONS: 'botões',
  POLL: 'enquete',
};

/**
 * ZC — o motivo da rejeição/pausa, venha de onde vier. Cada provedor tem a sua
 * coluna (a Twilio reporta o `rejection_reason` da Meta; o Zernio manda o
 * `reason` no webhook de status), mas para o operador é a mesma frase.
 */
function rejectionReason(t: Template): string | null {
  return t.twilioRejectionReason ?? t.zernioRejectionReason ?? null;
}

/**
 * ZC — quando o catálogo daquele template foi sincronizado pela última vez.
 * TWILIO tem o job de 2 min; ZERNIO tem o webhook (na hora) + a reconciliação de
 * 1h. EVOLUTION/META não têm sync de catálogo — e por isso o provedor é
 * consultado antes da coluna: uma linha EVOLUTION que carregue um
 * `lastTwilioSyncAt` legado NÃO pode exibir um frescor que não existe.
 */
function lastSyncAt(t: Template): Date | string | null {
  if (t.provider === 'TWILIO') return t.lastTwilioSyncAt ?? null;
  if (t.provider === 'ZERNIO') return t.lastZernioSyncAt ?? null;
  return null;
}

/** Human label for a template status, falling back to the raw enum value. */
function statusLabel(status: string): string {
  return TEMPLATE_STATUS_LABEL[status] ?? status;
}

/** Human label for a non-TEXT kind, falling back to its lowercased value. */
function kindLabel(kind: string): string {
  return TEMPLATE_KIND_LABEL[kind] ?? kind.toLowerCase();
}

/**
 * Pull a one-line preview from a template, varying by kind. Interactive
 * configs are stored as Json on the backend; the frontend reads them as
 * `unknown` and we shallowly probe for the headline string.
 */
function previewText(t: Template): string {
  if (t.kind === 'LIST') {
    const cfg = t.interactiveConfig as { title?: string } | null | undefined;
    return `Lista: ${cfg?.title ?? '(sem título)'}`;
  }
  if (t.kind === 'BUTTONS') {
    const cfg = t.interactiveConfig as
      | { description?: string }
      | null
      | undefined;
    return `Botões: ${cfg?.description ?? '(sem descrição)'}`;
  }
  if (t.kind === 'POLL') {
    const cfg = t.interactiveConfig as
      | { question?: string }
      | null
      | undefined;
    return `Enquete: ${cfg?.question ?? '(sem pergunta)'}`;
  }
  return t.body;
}

type DialogState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; template: Template }
  // ★ ZB — dizer o que os botões de um template IMPORTADO significam. Sem isso o
  // gate de campanha o recusa: um rótulo que o sistema não lê pode ser o "sim" de
  // um opt-in, e cada clique iria para o lixo.
  | { kind: 'consent-buttons'; template: Template };

function TemplateCard({
  template: t,
  onEdit,
  onDelete,
  onClassifyButtons,
}: {
  template: Template;
  onEdit: (t: Template) => void;
  onDelete: (t: Template) => void;
  onClassifyButtons: (t: Template) => void;
}) {
  // ★ ZB — o veredito dos botões vem do BACKEND (quem é dono do reconhecedor).
  // Não-vazio = a campanha RECUSA este template: há um botão cujo clique o
  // sistema não sabe ler, e ele pode ser o "sim" de um opt-in jogando cada
  // clique no lixo. Ver consent-buttons-dialog.tsx.
  const buttonProblems = t.consentButtons?.problems ?? [];
  return (
    <div
      className="rounded-xl border p-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="truncate font-semibold">{t.metaName}</h3>
        <Badge
          variant="outline"
          className={TEMPLATE_STATUS_BADGE_CLASS[t.status] ?? ''}
        >
          {statusLabel(t.status)}
        </Badge>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        <ProviderBadge provider={t.provider} />
        <Badge variant="outline">{t.language}</Badge>
        <Badge variant="outline">{t.category}</Badge>
        {t.kind && t.kind !== 'TEXT' && (
          <Badge variant="outline">{kindLabel(t.kind)}</Badge>
        )}
      </div>
      {buttonProblems.length > 0 && (
        <div
          role="alert"
          className="mt-2 rounded-md border border-red-300 bg-red-50 p-2 text-[11px] leading-relaxed text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <p className="font-medium">
            Os botões deste template não podem ser usados numa campanha.
          </p>
          <p className="mt-0.5">
            O sistema não sabe o que o clique significa — se algum deles for o
            "sim" de um opt-in, os cliques iriam para o lixo e nenhum
            consentimento seria gravado.
          </p>
        </div>
      )}
      {STATUSES_WITH_REASON.has(t.status) && rejectionReason(t) && (
        <p
          className={
            t.status === 'PAUSED'
              ? 'mt-1.5 text-xs text-orange-700 dark:text-orange-400'
              : 'mt-1.5 text-xs text-red-700 dark:text-red-400'
          }
          title={rejectionReason(t) ?? undefined}
        >
          Motivo: {rejectionReason(t)}
        </p>
      )}
      <pre
        className="mt-3 whitespace-pre-wrap rounded-md p-3 text-sm"
        style={{ background: 'var(--surface-sunken)' }}
      >
        {previewText(t)}
      </pre>
      {t.variables.length > 0 && (
        <div className="mt-3">
          <div className="ds-eyebrow">variáveis</div>
          <div className="ds-mono mt-1 text-xs">
            {t.variables.map((v) => `{{${v}}}`).join(' · ')}
          </div>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        {/* Frescor do catálogo sincronizado: TWILIO (job de 2 min) e ZERNIO
            (webhook na hora + reconciliação de 1h). EVOLUTION/META não têm sync
            de catálogo e não mostram nada aqui. */}
        {lastSyncAt(t) ? (
          <span className="text-[11px] text-muted-foreground">
            {syncFreshnessLabel(lastSyncAt(t)!)}
          </span>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1">
          {buttonProblems.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onClassifyButtons(t)}
            >
              Classificar botões
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Editar"
            onClick={() => onEdit(t)}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Excluir"
            onClick={() => onDelete(t)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>
  );
}

function TemplateList({
  data,
  isLoading,
  onEdit,
  onDelete,
  onClassifyButtons,
}: {
  data: Template[] | undefined;
  isLoading: boolean;
  onEdit: (t: Template) => void;
  onDelete: (t: Template) => void;
  onClassifyButtons: (t: Template) => void;
}) {
  if (isLoading) {
    return <p>Carregando...</p>;
  }
  if (data && data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nenhum template ainda. Crie um novo.
      </p>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {data?.map((t) => (
        <TemplateCard
          key={t.id}
          template={t}
          onEdit={onEdit}
          onDelete={onDelete}
          onClassifyButtons={onClassifyButtons}
        />
      ))}
    </div>
  );
}

function TemplatesPage() {
  // R12/R15 — só templates Evolution: o backend já filtra a lista e a UI não
  // oferece abas, filtro nem escolha de provedor.
  const { data, isLoading, isError, error, refetch } = useTemplates();

  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' });
  const [toDelete, setToDelete] = useState<Template | null>(null);

  if (isError) {
    return <QueryErrorFallback error={error} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <header className="space-y-1">
          <div className="ds-eyebrow">templates · {data?.length ?? 0}</div>
          <h1 className="ds-display !text-3xl">Catálogo.</h1>
        </header>
        <div className="flex gap-2">
          <Button onClick={() => setDialog({ kind: 'create' })}>
            Novo template
          </Button>
        </div>
      </div>

      <TemplateList
        data={data}
        isLoading={isLoading}
        onEdit={(t) => setDialog({ kind: 'edit', template: t })}
        onDelete={(t) => setToDelete(t)}
        onClassifyButtons={(t) =>
          setDialog({ kind: 'consent-buttons', template: t })
        }
      />

      {dialog.kind === 'create' && (
        <TemplateFormDialog
          mode="create"
          open
          onOpenChange={(o) => !o && setDialog({ kind: 'closed' })}
        />
      )}
      {dialog.kind === 'edit' && (
        <TemplateFormDialog
          mode="edit"
          initialData={dialog.template}
          open
          onOpenChange={(o) => !o && setDialog({ kind: 'closed' })}
        />
      )}
      {dialog.kind === 'consent-buttons' && (
        <ConsentButtonsDialog
          template={dialog.template}
          open
          onOpenChange={(o) => !o && setDialog({ kind: 'closed' })}
        />
      )}

      <DeleteTemplateDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        template={toDelete}
      />
    </div>
  );
}
