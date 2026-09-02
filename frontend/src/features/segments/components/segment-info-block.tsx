import { Info } from "lucide-react";

export function SegmentInfoBlock() {
  return (
    <div className="rounded-lg border p-4" title="Informações sobre segmentos">
      <div className="flex gap-3">
        <Info className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
        <div className="flex-1 space-y-2 text-sm">
          <p className="font-medium">O que é um segmento?</p>
          <p className="text-muted-foreground">
            Um segmento é um público que você salva com filtros de contatos. Exemplo: "Mulheres de Manaus do grupo Apoiadores". Cria uma vez e reutiliza na campanha sem refazer os filtros.
          </p>
          <div className="mt-3 space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Como usar:</p>
            <ol className="list-inside list-decimal space-y-1">
              <li>Configure os filtros de contatos</li>
              <li>Salve com um nome que identifique o público</li>
              <li>Ao criar campanha, escolha em "Carregar de um segmento"</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
