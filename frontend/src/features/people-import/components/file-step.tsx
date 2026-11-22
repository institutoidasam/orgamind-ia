import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiErrorText } from '@/features/people-export/api';
import { downloadTemplate, IMPORT_MAX_BYTES, useUploadImport } from '../api';
import type { BatchSummary } from '../schemas';

const TOO_BIG_TEXT = 'O arquivo passa de 5 MB. Divida a planilha e envie em partes.';
const UPLOAD_FALLBACK = 'Não foi possível enviar a planilha. Tente de novo.';
const TEMPLATE_FALLBACK = 'Não foi possível baixar o modelo. Tente de novo.';

type TemplateFormat = 'csv' | 'xlsx';

/** Erro por toast, com o texto da API (`detail`) ou a reserva (padrão do Lote D). */
function toastApiError(error: unknown, fallback: string): void {
  void apiErrorText(error, fallback).then((text) => toast.error(text));
}

function TemplateButtons() {
  const [downloading, setDownloading] = useState<TemplateFormat | null>(null);
  const download = (format: TemplateFormat) => {
    setDownloading(format);
    downloadTemplate(format)
      .catch((error: unknown) => toastApiError(error, TEMPLATE_FALLBACK))
      .finally(() => setDownloading(null));
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={downloading !== null} onClick={() => download('csv')}>
        Baixar modelo CSV
      </Button>
      <Button type="button" variant="outline" disabled={downloading !== null} onClick={() => download('xlsx')}>
        Baixar modelo XLSX
      </Button>
    </div>
  );
}

type Props = {
  onUploaded: (summary: BatchSummary) => void;
};

/** Passo 1 da importação (spec E1): baixar o modelo e enviar a planilha preenchida. */
export function FileStep({ onUploaded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const upload = useUploadImport();
  const warningId = useId();
  const tooBig = file !== null && file.size > IMPORT_MAX_BYTES;
  const send = () => {
    if (!file || tooBig) return;
    upload.mutate(file, {
      onSuccess: (summary) => onUploaded(summary),
      onError: (error) => toastApiError(error, UPLOAD_FALLBACK),
    });
  };
  return (
    <div className="space-y-6">
      <TemplateButtons />
      <div className="max-w-md space-y-1.5">
        <Label htmlFor="import-file">Planilha (.csv ou .xlsx, até 5 MB)</Label>
        <Input
          id="import-file"
          type="file"
          accept=".csv,.xlsx"
          aria-describedby={tooBig ? warningId : undefined}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </div>
      {tooBig && (
        <Alert variant="destructive">
          <AlertDescription id={warningId}>{TOO_BIG_TEXT}</AlertDescription>
        </Alert>
      )}
      <Button
        type="button"
        onClick={send}
        disabled={!file || tooBig || upload.isPending}
        aria-describedby={tooBig ? warningId : undefined}
      >
        {upload.isPending ? 'Enviando…' : 'Enviar planilha'}
      </Button>
    </div>
  );
}
