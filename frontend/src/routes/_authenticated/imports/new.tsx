import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ExcelUploader } from '@/features/imports/components/excel-uploader';

export const Route = createFileRoute('/_authenticated/imports/new')({
  component: NewImportPage,
});

function NewImportPage() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Nova importação</h1>
      <p className="text-sm text-muted-foreground">
        Colunas suportadas: <code>nome</code>, <code>telefone</code>, <code>cidade</code>, <code>grupo</code>, <code>tags</code> (vírgula). Outras colunas viram <code>customFields</code>.
      </p>
      {/*
        C4 (§3.3) — consentimento coletado na ficha de papel. As quatro colunas
        são exigidas JUNTAS: sem termo assinado, sem finalidade ou sem a data da
        assinatura, o contato entra e o consentimento não. Um "autorizo contato"
        genérico numa folha de presença não é opt-in.
      */}
      <p className="text-sm text-muted-foreground">
        <strong className="text-foreground">Consentimento coletado no papel:</strong> preencha{' '}
        <code>consentimento</code> (SIM/NÃO), <code>termo_ref</code> (o termo assinado),{' '}
        <code>finalidade</code> e <code>data_coleta</code> (quando a pessoa assinou) — as
        quatro juntas. Opcionais: <code>evento_local</code> e <code>link_scan</code> (a ficha
        digitalizada). Faltando alguma, o contato é importado <em>sem</em> consentimento.
      </p>
      <ExcelUploader
        onComplete={() =>
          // The import runs asynchronously now; send the operator to the
          // Histórico, which polls each batch's status until it finishes.
          navigate({ to: '/imports' })
        }
      />
    </div>
  );
}
