import { useId, useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiErrorText } from '@/features/people-export/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDiscardImport, useRemapImport } from '../api';
import { FIELD_LABEL } from '../labels';
import { IMPORT_FIELDS, type BatchSummary, type ColumnMapping, type ImportField } from '../schemas';

/** "Não usar" não pode ser '' (o item do Select exige valor). */
const NOT_USED = '__not_used__';
const REMAP_FALLBACK = 'Não foi possível refazer a prévia. Tente de novo.';
const DISCARD_FALLBACK = 'Não foi possível descartar o lote. Tente de novo.';

function toastApiError(error: unknown, fallback: string): void {
  void apiErrorText(error, fallback).then((text) => toast.error(text));
}

/** Campo que a coluna `index` serve, ou `null` quando está em "Não usar". */
function fieldOfColumn(mapping: ColumnMapping, index: number): ImportField | null {
  return IMPORT_FIELDS.find((field) => mapping[field] === index) ?? null;
}

/** A coluna passa a servir ao campo (ou a nenhum, com `null`); o campo que ela servia fica sem coluna. */
function assignColumn(mapping: ColumnMapping, index: number, field: ImportField | null): ColumnMapping {
  const next = { ...mapping };
  const current = fieldOfColumn(mapping, index);
  if (current) next[current] = null;
  if (field) next[field] = index;
  return next;
}

function isChanged(mapping: ColumnMapping, original: ColumnMapping): boolean {
  return IMPORT_FIELDS.some((field) => mapping[field] !== original[field]);
}

/** Mesmas regras e textos de `mappingProblem` do backend (CX6): desabilita "Ver prévia" antes de enviar. */
function localProblem(mapping: ColumnMapping, headerCount: number, isAdmin: boolean): string | null {
  const used = IMPORT_FIELDS.map((field) => mapping[field]).filter((index): index is number => index !== null);
  if (used.some((index) => index >= headerCount)) return 'Coluna inexistente no arquivo.';
  if (new Set(used).size !== used.length) return 'Cada coluna serve a um campo só.';
  if (mapping.name === null || (mapping.phone === null && mapping.registration === null)) {
    return 'Escolha a coluna de Nome e pelo menos uma entre Telefone e Matrícula.';
  }
  if (!isAdmin && mapping.sector === null) {
    return 'Escolha a coluna de Setor: quem não é administrador informa o setor em todas as linhas.';
  }
  return null;
}

type FieldSelectProps = {
  header: string;
  index: number;
  mapping: ColumnMapping;
  onChange: (field: ImportField | null) => void;
};

/** Cada campo recebe no máximo uma coluna: o campo de outra coluna fica indisponível aqui (spec E3). */
function FieldSelect({ header, index, mapping, onChange }: FieldSelectProps) {
  return (
    <Select
      value={fieldOfColumn(mapping, index) ?? NOT_USED}
      onValueChange={(value) => onChange(IMPORT_FIELDS.find((field) => field === value) ?? null)}
    >
      <SelectTrigger aria-label={`Campo da coluna ${header}`} className="w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NOT_USED}>Não usar</SelectItem>
        {IMPORT_FIELDS.map((field) => (
          <SelectItem key={field} value={field} disabled={mapping[field] !== null && mapping[field] !== index}>
            {FIELD_LABEL[field]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type MappingTableProps = {
  headers: string[];
  mapping: ColumnMapping;
  onAssign: (index: number, field: ImportField | null) => void;
};

function MappingTable({ headers, mapping, onAssign }: MappingTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Coluna do arquivo</TableHead>
          <TableHead>Campo</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {headers.map((header, index) => (
          <TableRow key={`${index}-${header}`}>
            <TableCell className="font-medium">{header}</TableCell>
            <TableCell>
              <FieldSelect header={header} index={index} mapping={mapping} onChange={(f) => onAssign(index, f)} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type DiscardProps = {
  batch: BatchSummary;
  onDiscarded: () => void;
};

/** "Descartar lote" apaga o lote e as linhas (sem registro); por isso pede confirmação. */
function DiscardBatch({ batch, onDiscarded }: DiscardProps) {
  const [open, setOpen] = useState(false);
  const discard = useDiscardImport(batch.id);
  const confirm = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    discard.mutate(undefined, {
      onSuccess: () => {
        setOpen(false);
        onDiscarded();
      },
      onError: (error) => toastApiError(error, DISCARD_FALLBACK),
    });
  };
  return (
    <>
      <Button type="button" variant="outline" disabled={!batch.canDiscard} onClick={() => setOpen(true)}>
        Descartar lote
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar este lote?</AlertDialogTitle>
            <AlertDialogDescription>
              A planilha enviada e a prévia serão apagadas. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discard.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirm} disabled={discard.isPending}>
              {discard.isPending ? 'Descartando…' : 'Descartar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type Props = {
  batch: BatchSummary;
  onReady: (summary: BatchSummary) => void;
  onDiscarded: () => void;
};

/**
 * Passo 2 da importação (spec E1, E3): o sistema sugere o campo de cada coluna e a pessoa
 * confere. O estado parte de `batch.mapping`; a página monta o passo com `key={batch.id}`.
 */
export function MappingStep({ batch, onReady, onDiscarded }: Props) {
  const isAdmin = useAuthStore((state) => state.user?.role === 'ADMIN');
  const [mapping, setMapping] = useState<ColumnMapping>(batch.mapping);
  const remap = useRemapImport(batch.id);
  const problemId = useId();
  const changed = isChanged(mapping, batch.mapping);
  const local = localProblem(mapping, batch.headers.length, isAdmin);
  const problem = changed ? local : (batch.mappingProblem ?? local);
  const next = () => {
    if (!changed) {
      onReady(batch);
      return;
    }
    remap.mutate(mapping, {
      onSuccess: (summary) => onReady(summary),
      onError: (error) => toastApiError(error, REMAP_FALLBACK),
    });
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Confira a que campo corresponde cada coluna do arquivo. Colunas sem campo ficam como “Não usar”.
      </p>
      {problem && (
        <Alert variant="destructive">
          <AlertDescription id={problemId}>{problem}</AlertDescription>
        </Alert>
      )}
      <MappingTable
        headers={batch.headers}
        mapping={mapping}
        onAssign={(index, field) => setMapping((current) => assignColumn(current, index, field))}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DiscardBatch batch={batch} onDiscarded={onDiscarded} />
        <Button
          type="button"
          onClick={next}
          disabled={problem !== null || remap.isPending}
          aria-describedby={problem ? problemId : undefined}
        >
          {remap.isPending ? 'Refazendo a prévia…' : 'Ver prévia'}
        </Button>
      </div>
    </div>
  );
}
