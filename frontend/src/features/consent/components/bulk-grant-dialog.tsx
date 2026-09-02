import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FilterBuilder } from '@/features/campaigns/components/filter-builder';
import type { FilterGroup } from '@/features/campaigns/schemas';
import { extractApiError } from '@/lib/api-error';
import {
  useAdminPurposes,
  useBulkGrant,
  useBulkGrantPreview,
  type BulkGrantResult,
} from '@/features/consent/admin';

const EMPTY_FILTERS: FilterGroup = { combinator: 'and', rules: [] };

const nf = new Intl.NumberFormat('pt-BR');
const num = (n: number) => nf.format(n);

/**
 * §6.2 coorte C2 — registrar o consentimento da BASE EXISTENTE.
 *
 * A situação real: a base legada tem base legal (os titulares concordaram em
 * receber comunicações, fora do WhatsApp — num contrato, numa ficha, num
 * cadastro), mas nenhum `ConsentEvent`. O gate por finalidade, que é a correção
 * jurídica inteira, pula 100% dela — e nenhuma campanha sai. Sem esta tela, a
 * única saída seria um UPDATE na mão no banco.
 *
 * O que a tela obriga, e é o ponto: **dizer onde e quando concordaram**. Um
 * registro em massa sem evidência é a autorização genérica que o art. 8º §4º
 * anula — e, num processo, é prova produzida pelo próprio controlador de que ele
 * registrou consentimento sem saber de onde veio. Por isso o aviso legal é
 * explícito e o botão só destrava com a evidência preenchida.
 */
export function BulkGrantSection() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle>Consentimento da base existente</CardTitle>
            <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
              Para quem já concordou em receber mensagens <strong>fora do
              WhatsApp</strong> (contrato, ficha, cadastro) e por isso não tem
              registro no orgamind. Não envia nada — só grava o consentimento que já
              existe, com a evidência dele.
            </p>
          </div>
          <Button size="sm" onClick={() => setOpen(true)}>
            Registrar consentimento da base existente
          </Button>
        </CardHeader>
      </Card>

      <BulkGrantDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function BulkGrantDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const purposes = useAdminPurposes();
  const preview = useBulkGrantPreview();
  const apply = useBulkGrant();

  const [purposeKey, setPurposeKey] = useState('');
  const [filters, setFilters] = useState<FilterGroup>(EMPTY_FILTERS);
  const [evidenceRef, setEvidenceRef] = useState('');
  const [collectedAt, setCollectedAt] = useState('');
  const [evidenceNote, setEvidenceNote] = useState('');
  const [counts, setCounts] = useState<BulkGrantResult | null>(null);
  const [result, setResult] = useState<BulkGrantResult | null>(null);

  const ativas = (purposes.data ?? []).filter((p) => p.active);

  useEffect(() => {
    if (!open) return;
    setPurposeKey('');
    setFilters(EMPTY_FILTERS);
    setEvidenceRef('');
    setCollectedAt('');
    setEvidenceNote('');
    setCounts(null);
    setResult(null);
  }, [open]);

  // A contagem é recalculada a cada mudança de finalidade/filtro. Debounce
  // porque a árvore de filtros emite a cada tecla, e a resolução varre a base.
  useEffect(() => {
    if (!open || !purposeKey) {
      setCounts(null);
      return;
    }
    const t = setTimeout(() => {
      void preview
        .mutateAsync({
          purposeKey,
          filters,
          // O preview só conta — a evidência ainda não importa aqui, mas o
          // contrato do endpoint a exige, então mandamos um placeholder válido.
          evidenceRef: evidenceRef.trim() || 'preview',
          collectedAt: collectedAt || hojeISO(),
        })
        .then(setCounts)
        .catch(() => setCounts(null));
    }, 300);
    return () => clearTimeout(t);
    // As deps cobrem finalidade + filtro (é o que muda a audiência). A evidência
    // fica de fora de propósito: digitar o número do contrato não pode disparar
    // uma varredura da base a cada tecla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, purposeKey, JSON.stringify(filters)]);

  const canSubmit =
    !!purposeKey &&
    evidenceRef.trim().length >= 3 &&
    !!collectedAt &&
    !apply.isPending;

  async function registrar() {
    if (!canSubmit) return;
    try {
      const res = await apply.mutateAsync({
        purposeKey,
        filters,
        evidenceRef: evidenceRef.trim(),
        collectedAt,
        ...(evidenceNote.trim() ? { evidenceNote: evidenceNote.trim() } : {}),
      });
      setResult(res);
      toast.success(
        `${num(res.granted)} consentimento(s) registrado(s) para esta finalidade`,
      );
    } catch (err) {
      const { message } = await extractApiError(err);
      toast.error('Falha ao registrar o consentimento', {
        description: message,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        O construtor de filtros (FilterBuilder) precisa de espaço horizontal
        real para a linha campo|operador|valor não transbordar. O default do
        Dialog é `sm:max-w-sm` (estreito) — um override SEM o prefixo `sm:`
        (ex.: `max-w-2xl`) não vence esse default no CSS: o tailwind-merge só
        deduplica classes com o MESMO modificador de variante, então
        `sm:max-w-sm` sobrevive junto e, por ordem de cascata (regras
        responsivas vêm depois das regras base), ele ganha em telas >= 640px.
        Por isso o override tem que usar o mesmo prefixo `sm:`.
      */}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Registrar consentimento da base existente</DialogTitle>
          <DialogDescription>
            Nenhuma mensagem é enviada. O orgamind apenas grava, com evidência, o
            consentimento que estes titulares já deram fora do WhatsApp.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <ResultPanel result={result} onClose={() => onOpenChange(false)} />
        ) : (
          <>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="bulk-purpose">Finalidade</Label>
                <Select value={purposeKey} onValueChange={setPurposeKey}>
                  <SelectTrigger id="bulk-purpose">
                    <SelectValue placeholder="Escolha a finalidade" />
                  </SelectTrigger>
                  <SelectContent>
                    {ativas.map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p
                  className="text-xs"
                  style={{ color: 'var(--foreground-muted)' }}
                >
                  O consentimento vale só para esta finalidade — consentir para
                  uma não autoriza as outras.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Quem</Label>
                <FilterBuilder value={filters} onChange={setFilters} />
              </div>

              {purposeKey && (
                <div
                  data-testid="bulk-preview"
                  className="rounded-md border p-3 text-sm"
                  style={{ borderColor: 'var(--border)' }}
                >
                  {preview.isPending && !counts ? (
                    <span style={{ color: 'var(--foreground-muted)' }}>
                      Calculando…
                    </span>
                  ) : counts ? (
                    <div className="space-y-1">
                      <p>
                        <strong>{num(counts.total)}</strong> contato(s) no filtro
                        · <strong>{num(counts.granted)}</strong> receberão o
                        consentimento
                      </p>
                      <p
                        className="text-xs"
                        style={{ color: 'var(--foreground-muted)' }}
                      >
                        {num(counts.skippedSuppressed)} serão pulados por
                        supressão (pediram PARAR — isso não se fura) ·{' '}
                        {num(counts.alreadyGranted)} já tinham consentimento para
                        esta finalidade
                      </p>
                    </div>
                  ) : (
                    <span style={{ color: 'var(--foreground-muted)' }}>
                      Escolha o filtro para ver quantos serão afetados.
                    </span>
                  )}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="bulk-ref">Onde concordaram</Label>
                  <Input
                    id="bulk-ref"
                    value={evidenceRef}
                    onChange={(e) => setEvidenceRef(e.target.value)}
                    placeholder="Contrato CONTINUUM #123"
                  />
                  <p
                    className="text-xs"
                    style={{ color: 'var(--foreground-muted)' }}
                  >
                    A evidência: contrato, ficha, cadastro. É o que prova o
                    consentimento numa fiscalização.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="bulk-date">Quando concordaram</Label>
                  <Input
                    id="bulk-date"
                    type="date"
                    value={collectedAt}
                    max={hojeISO()}
                    onChange={(e) => setCollectedAt(e.target.value)}
                  />
                  <p
                    className="text-xs"
                    style={{ color: 'var(--foreground-muted)' }}
                  >
                    A data real da coleta — é ela que fica gravada, não a de hoje.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bulk-note">Observação (opcional)</Label>
                <Textarea
                  id="bulk-note"
                  value={evidenceNote}
                  onChange={(e) => setEvidenceNote(e.target.value)}
                  rows={2}
                  placeholder="Cláusula 7 do contrato assinado por cada participante."
                />
              </div>

              <div
                data-testid="aviso-legal"
                className="rounded-md border p-3 text-sm"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--muted)',
                }}
              >
                <strong>Você declara</strong> que estes titulares consentiram
                receber mensagens desta organização, e que há{' '}
                <strong>registro comprovável</strong> disso. Este registro fica
                gravado com <strong>sua identificação</strong> e é{' '}
                <strong>auditável</strong>.
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={apply.isPending}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                onClick={() => void registrar()}
                disabled={!canSubmit}
              >
                {apply.isPending
                  ? 'Registrando…'
                  : counts
                    ? `Registrar ${num(counts.granted)} consentimento(s)`
                    : 'Registrar consentimento'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResultPanel({
  result,
  onClose,
}: {
  result: BulkGrantResult;
  onClose: () => void;
}) {
  return (
    <>
      <div data-testid="bulk-result" className="space-y-3 py-2">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Concedidos" value={result.granted} />
          <Stat label="Pulados por supressão" value={result.skippedSuppressed} />
          <Stat label="Já tinham" value={result.alreadyGranted} />
        </div>

        {result.failed > 0 && (
          <p className="text-sm text-amber-600">
            {num(result.failed)} contato(s) falharam. Rodar de novo é seguro:
            quem já recebeu o consentimento não recebe duas vezes.
          </p>
        )}

        <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
          Os pulados por supressão pediram para parar de receber. Isso não se fura
          — nem com contrato, nem com admin.
        </p>
      </div>

      <DialogFooter className="pt-2">
        <Button type="button" onClick={onClose}>
          Fechar
        </Button>
      </DialogFooter>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="rounded-md border p-3"
      style={{ borderColor: 'var(--border)' }}
    >
      <p className="text-2xl font-semibold">{num(value)}</p>
      <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
        {label}
      </p>
    </div>
  );
}

/** `yyyy-mm-dd` de hoje — teto do seletor de data (consentimento futuro não existe). */
function hojeISO(): string {
  return new Date().toISOString().slice(0, 10);
}
