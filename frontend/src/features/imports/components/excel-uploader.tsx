import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useImportExcel, importTimeoutMessage } from '../api';
import { toast } from 'sonner';
import type { ImportUploadResult } from '../schemas';

// Backend rejects anything over 10MB and ExcelJS can only parse the modern
// OOXML `.xlsx` (legacy `.xls` passes a loose MIME gate but blows up on parse).
// Validate both here so the operator gets immediate, accurate feedback instead
// of a server-side failure.
const MAX_SIZE_BYTES = 10 * 1024 * 1024;

function validateFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    return 'Apenas arquivos .xlsx são suportados (o formato antigo .xls não funciona).';
  }
  if (file.size > MAX_SIZE_BYTES) {
    return 'Arquivo muito grande — o limite é 10MB.';
  }
  return null;
}

export function ExcelUploader({
  onComplete,
}: {
  onComplete?: (r: ImportUploadResult) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mutation = useImportExcel();

  const accept = (picked: File | undefined | null) => {
    if (!picked) return;
    const err = validateFile(picked);
    if (err) {
      setFile(null);
      toast.error(err);
      return;
    }
    setFile(picked);
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div
          className="cursor-pointer rounded border-2 border-dashed p-8 text-center hover:bg-accent"
          onClick={() => inputRef.current?.click()}
          onDrop={(e) => {
            e.preventDefault();
            accept(e.dataTransfer.files[0]);
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => accept(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <p className="text-sm">
              {file.name} ({Math.round(file.size / 1024)}KB)
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Clique ou arraste um arquivo .xlsx
            </p>
          )}
        </div>

        <Button
          disabled={!file || mutation.isPending}
          onClick={async () => {
            if (!file) return;
            try {
              const r = await mutation.mutateAsync(file);
              // The import now runs asynchronously in the worker, so there's no
              // per-row result to report yet — point the operator at the
              // Histórico, which polls the batch status until it's done.
              toast.success(
                'Importação iniciada — acompanhe no Histórico.',
              );
              setFile(null);
              onComplete?.(r);
            } catch (err) {
              toast.error(importTimeoutMessage(err));
            }
          }}
        >
          {mutation.isPending ? 'Importando...' : 'Importar'}
        </Button>
      </CardContent>
    </Card>
  );
}
