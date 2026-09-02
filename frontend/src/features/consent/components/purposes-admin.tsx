import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { extractApiError } from '@/lib/api-error';
import {
  consentTextChecklist,
  declarationFrom,
  renderLandingBody,
  useAdminPurposes,
  useCreatePurpose,
  useDeletePurpose,
  usePublishConsentText,
  useSuggestedConsentText,
  useUpdatePurpose,
  waMePreview,
  type AdminPurpose,
} from '@/features/consent/admin';

/** Número de exemplo do preview: o remetente real vem do canal do ponto de coleta. */
const PREVIEW_DIGITS = '559231550103';
const PREVIEW_TOKEN = 'FEIRA-MANAUS-2026';

/**
 * Finalidades e textos de consentimento (spec §2.2, §3.0) — ADMIN.
 *
 * Sem esta seção, o orgamind só sabia colher consentimento para as 5 finalidades de
 * referência, com o nome de UMA organização dentro do texto. Um cliente novo
 * precisaria de uma migração de banco para ter a finalidade dele — e, até lá, os
 * titulares DELE estariam lendo, e "autorizando", uma declaração que nomeia outra
 * organização. Isso não é um bug de copy: a Meta exige que o texto nomeie a
 * organização, e um consentimento colhido sob o nome errado é inválido.
 *
 * A organização vem de Configurações (`/organization`), e o rascunho de um texto
 * novo já vem composto com ela — o operador não precisa lembrar de trocar o nome.
 *
 * Duas coisas que a tela NÃO deixa fazer, e são o ponto:
 *  - **trocar a chave** de uma finalidade (ela é a chave estável de toda a trilha);
 *  - **reescrever um texto publicado** — publicar é sempre criar uma versão nova.
 *    Os consentimentos já colhidos apontam para o texto que a pessoa LEU; reescrevê-lo
 *    apagaria a prova (art. 8º §2º — o ônus dela é do controlador).
 */
export function PurposesAdmin() {
  const purposes = useAdminPurposes();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminPurpose | null>(null);
  const [writing, setWriting] = useState<AdminPurpose | null>(null);

  const remove = useDeletePurpose();

  async function apagar(p: AdminPurpose) {
    try {
      await remove.mutateAsync(p.key);
      toast.success(`Finalidade "${p.label}" apagada`);
    } catch (err) {
      const { message } = await extractApiError(err);
      toast.error('Não foi possível apagar a finalidade', {
        description: message,
      });
    }
  }

  const list = purposes.data ?? [];

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle>Finalidades e textos de consentimento</CardTitle>
            <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
              Cada campanha declara <strong>uma</strong> finalidade, e o gate só
              envia a quem consentiu <strong>para ela</strong>. O texto é a prova:
              é o que a pessoa leu antes de dizer sim.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            Nova finalidade
          </Button>
        </CardHeader>

        <CardContent data-testid="purposes-admin" className="space-y-3">
          {list.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
              Nenhuma finalidade cadastrada.
            </p>
          ) : (
            list.map((p) => (
              <div
                key={p.key}
                data-testid={`purpose-${p.key}`}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.label}</span>
                    <code
                      className="rounded px-1.5 py-0.5 font-mono text-xs"
                      style={{
                        background: 'var(--muted)',
                        color: 'var(--foreground-muted)',
                      }}
                    >
                      {p.key}
                    </code>
                    {p.isSensitive && (
                      <span className="text-xs font-medium text-amber-600">
                        dado sensível
                      </span>
                    )}
                    {!p.active && (
                      <span
                        className="text-xs"
                        style={{ color: 'var(--foreground-muted)' }}
                      >
                        inativa
                      </span>
                    )}
                  </div>

                  <p
                    className="text-sm"
                    style={{ color: 'var(--foreground-muted)' }}
                  >
                    {p.description}
                  </p>

                  <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                    {p.activeText ? (
                      <>
                        Texto vigente:{' '}
                        <code className="font-mono">{p.activeText.version}</code>
                        {p.texts.length > 1 && ` (${p.texts.length} versões)`}
                      </>
                    ) : (
                      <span className="font-medium text-amber-600">
                        Sem texto publicado — esta finalidade não coleta nada.
                      </span>
                    )}
                    {p.consents > 0 && ` · ${p.consents} consentimento(s)`}
                  </p>
                </div>

                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setWriting(p)}
                  >
                    Texto
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(p)}
                  >
                    Editar
                  </Button>
                  {/* Só finalidade VIRGEM some. Com qualquer vínculo, o backend
                      recusa (409) e manda desativar — a trilha é prova. */}
                  {p.consents === 0 && p.events === 0 && p.campaigns === 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void apagar(p)}
                      disabled={remove.isPending}
                    >
                      Apagar
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <PurposeDialog
        open={creating || editing !== null}
        purpose={editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      />

      <ConsentTextDialog
        purpose={writing}
        onOpenChange={(open) => {
          if (!open) setWriting(null);
        }}
      />
    </>
  );
}

// ── Criar / editar finalidade ────────────────────────────────────────────────

function PurposeDialog({
  open,
  purpose,
  onOpenChange,
}: {
  open: boolean;
  purpose: AdminPurpose | null;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreatePurpose();
  const update = useUpdatePurpose();

  // O pai zera `purpose` no instante em que o dialog fecha, mas o Radix ainda
  // renderiza o conteúdo durante a animação de saída. Lendo `purpose` direto,
  // um dialog de EDIÇÃO pisca como "Nova finalidade" ao fechar — com a chave
  // editável e o botão virando "Criar", em cima dos dados que acabaram de ser
  // salvos. Parece que vai duplicar a finalidade. Espelhar o último valor
  // enquanto aberto mantém o dialog coerente até ele sumir de fato.
  const lastPurpose = useRef(purpose);
  if (open) lastPurpose.current = purpose;
  const editing = open ? purpose : lastPurpose.current;
  const isEdit = editing !== null;

  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [isSensitive, setIsSensitive] = useState(false);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!open) return;
    setKey(purpose?.key ?? '');
    setLabel(purpose?.label ?? '');
    setDescription(purpose?.description ?? '');
    setIsSensitive(purpose?.isSensitive ?? false);
    setActive(purpose?.active ?? true);
  }, [open, purpose]);

  const keyOk = /^[a-z0-9_]{2,64}$/.test(key);
  const canSubmit =
    (isEdit || keyOk) && label.trim().length > 0 && description.trim().length > 0;
  const pending = create.isPending || update.isPending;

  async function submit() {
    if (!canSubmit) return;
    try {
      if (editing) {
        await update.mutateAsync({
          key: editing.key,
          label: label.trim(),
          description: description.trim(),
          isSensitive,
          active,
        });
        toast.success('Finalidade atualizada');
      } else {
        await create.mutateAsync({
          key,
          label: label.trim(),
          description: description.trim(),
          isSensitive,
          active,
        });
        toast.success('Finalidade criada');
      }
      onOpenChange(false);
    } catch (err) {
      const { message } = await extractApiError(err);
      toast.error(
        isEdit ? 'Falha ao editar a finalidade' : 'Falha ao criar a finalidade',
        { description: message },
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Editar finalidade' : 'Nova finalidade'}
          </DialogTitle>
          <DialogDescription>
            A finalidade é o que autoriza o envio. Consentir para uma{' '}
            <strong>não</strong> autoriza as outras — autorização genérica é nula
            (LGPD art. 8º §4º).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="purpose-key">Chave</Label>
            <Input
              id="purpose-key"
              value={key}
              disabled={isEdit}
              onChange={(e) => setKey(e.target.value.toLowerCase())}
              placeholder="continuum_avisos"
              className="font-mono"
            />
            <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
              {isEdit
                ? 'A chave não muda: ela identifica esta finalidade em todos os consentimentos já registrados.'
                : 'Letras minúsculas, números e _ . É permanente — ela vive dentro de cada consentimento colhido.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="purpose-label">Rótulo</Label>
            <Input
              id="purpose-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Avisos do CONTINUUM"
            />
            <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
              Aparece dentro do texto de consentimento que o titular lê.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="purpose-description">Descrição</Label>
            <Textarea
              id="purpose-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="O que exatamente será enviado, na linguagem do titular."
              rows={2}
            />
          </div>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={isSensitive}
              onCheckedChange={(v) => setIsSensitive(v === true)}
            />
            <span>
              Dado sensível
              <span
                className="block text-xs"
                style={{ color: 'var(--foreground-muted)' }}
              >
                Saúde, etnia, religião, opinião política… Exige consentimento
                específico e destacado (art. 11) e o gate recusa qualquer outra
                base legal.
              </span>
            </span>
          </label>

          {isEdit && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={active}
                onCheckedChange={(v) => setActive(v === true)}
              />
              <span>
                Ativa
                <span
                  className="block text-xs"
                  style={{ color: 'var(--foreground-muted)' }}
                >
                  Desativar tira a finalidade das campanhas novas. Os
                  consentimentos já colhidos continuam valendo — e continuam sendo
                  prova.
                </span>
              </span>
            </label>
          )}
        </div>

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit || pending}
          >
            {pending ? 'Salvando…' : isEdit ? 'Salvar' : 'Criar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Escrever o texto de consentimento ────────────────────────────────────────

function ConsentTextDialog({
  purpose,
  onOpenChange,
}: {
  purpose: AdminPurpose | null;
  onOpenChange: (open: boolean) => void;
}) {
  const publish = usePublishConsentText();
  // O rascunho composto pelo backend com a identidade CONFIGURADA da organização
  // — e o veredito sobre o texto que está colhendo consentimento HOJE.
  const suggested = useSuggestedConsentText(purpose?.key ?? null);
  const [version, setVersion] = useState('');
  const [body, setBody] = useState('');

  const suggestion = suggested.data;
  const textoVigenteNomeiaOutra =
    suggestion !== undefined && !suggestion.activeTextNamesOrganization;

  useEffect(() => {
    if (!purpose || !suggestion) return;
    setVersion(suggestion.version);
    // Se o texto vigente NÃO nomeia esta organização, partir dele seria propagar
    // o erro — o rascunho certo é o composto. Se nomeia, o caso comum é ajustar o
    // que já vale, e uma tela em branco convida a esquecer uma cláusula.
    setBody(
      suggestion.activeTextNamesOrganization && purpose.activeText
        ? purpose.activeText.body
        : suggestion.body,
    );
  }, [purpose, suggestion]);

  if (!purpose) return null;

  const checklist = consentTextChecklist(body);
  const canSubmit = version.trim().length > 0 && body.trim().length > 0;

  async function submit() {
    if (!purpose || !canSubmit) return;
    try {
      await publish.mutateAsync({
        purposeKey: purpose.key,
        version: version.trim(),
        body: body.trim(),
      });
      toast.success(`Texto ${version.trim()} publicado`);
      onOpenChange(false);
    } catch (err) {
      const { message } = await extractApiError(err);
      toast.error('Falha ao publicar o texto', { description: message });
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Texto de consentimento — {purpose.label}</DialogTitle>
          <DialogDescription>
            Publicar cria uma <strong>versão nova</strong> e{' '}
            <strong>não altera as versões anteriores</strong>: quem já consentiu
            continua ligado ao texto que leu — é ele que prova o consentimento.
          </DialogDescription>
        </DialogHeader>

        {/*
          O alarme. O texto que está colhendo consentimento AGORA nomeia outra
          organização — e um consentimento colhido sob o nome errado é inválido
          (a Meta exige "clearly state the business's name"). Publicar a versão
          composta abaixo corrige daqui para a frente; o que já foi colhido
          continua apontando para o texto antigo, porque é o que a pessoa leu.
        */}
        {textoVigenteNomeiaOutra && (
          <p
            data-testid="aviso-organizacao"
            role="alert"
            className="rounded-md border p-3 text-xs"
            style={{ borderColor: 'var(--destructive)' }}
          >
            O texto vigente <strong>não nomeia a sua organização</strong>. Os
            consentimentos colhidos por ele não valem para ela. O rascunho abaixo
            já vem com a identidade configurada em{' '}
            <strong>Configurações</strong> — confira e publique.
          </p>
        )}

        <div className="grid gap-4 py-2 md:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="text-version">Versão</Label>
              <Input
                id="text-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="optin-continuum-v1"
                className="font-mono"
              />
              {purpose.activeText && (
                <p
                  className="text-xs"
                  style={{ color: 'var(--foreground-muted)' }}
                >
                  Vigente hoje:{' '}
                  <code className="font-mono">{purpose.activeText.version}</code>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="text-body">Texto de consentimento</Label>
              <Textarea
                id="text-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                className="font-mono text-xs"
              />
              <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                A <strong>primeira linha</strong> é a declaração — é só ela que
                vai no link wa.me. <code>{'{url}'}</code> vira o endereço da
                política de privacidade.
              </p>
            </div>

            <div
              data-testid="checklist-legal"
              className="rounded-md border p-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <p className="mb-2 text-xs font-medium">
                O texto precisa cumprir (confira — o orgamind não bloqueia):
              </p>
              <ul className="space-y-1">
                {checklist.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-start gap-2 text-xs"
                    style={{
                      color: c.ok ? 'var(--foreground)' : 'var(--foreground-muted)',
                    }}
                  >
                    <span aria-hidden>{c.ok ? '✓' : '○'}</span>
                    <span>{c.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="text-xs font-medium">Como aparece na landing</p>
              <div
                data-testid="preview-landing"
                className="rounded-md border p-3 text-sm whitespace-pre-wrap"
                style={{ borderColor: 'var(--border)' }}
              >
                <span className="mr-2" aria-hidden>
                  ☐
                </span>
                {renderLandingBody(body)}
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium">
                Como aparece no link wa.me / QR
              </p>
              <div
                data-testid="preview-wame"
                className="space-y-2 rounded-md border p-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <p className="text-sm">
                  {declarationFrom(body)} [{PREVIEW_TOKEN}]
                </p>
                <p
                  className="font-mono text-[10px] break-all"
                  style={{ color: 'var(--foreground-muted)' }}
                >
                  {waMePreview(body, PREVIEW_DIGITS, PREVIEW_TOKEN)}
                </p>
              </div>
              <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                Exemplo com um remetente e um token quaisquer — os reais vêm do
                ponto de coleta.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={publish.isPending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit || publish.isPending}
          >
            {publish.isPending ? 'Publicando…' : 'Publicar versão'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Não há mais `modeloPara()` aqui, e é de propósito: o esqueleto do §3.0 vivia
 * neste arquivo com um `[NOME DA ORGANIZAÇÃO POR EXTENSO]` que o operador tinha
 * de lembrar de substituir — e esquecer disso publica um texto inválido. Hoje o
 * corpo é composto no backend a partir de `Organization` (o mesmo composer que o
 * seed usa), e chega aqui pelo `useSuggestedConsentText`. Uma fonte só.
 */
