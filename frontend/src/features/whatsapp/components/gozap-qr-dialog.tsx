import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useGozapQr } from '../api';
import { QrPane } from './create-instance-dialog';

type Props = {
  channelId: string | null;
  channelName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Pareia (ou repareia) um canal GOZAP já criado — análogo ao
 * ConnectInstanceDialog do EVOLUTION, mas sobre GET /whatsapp/channels/:id/qr
 * (um `Channel` cloud, não uma `Instance`). Serve tanto o "Conectar" de um
 * canal existente na lista quanto o passo seguinte à criação (GozapSection
 * abre este mesmo dialog assim que `CreateGozapChannelDialog` devolve o canal
 * recém-criado) — um único dialog de QR para as duas entradas.
 *
 * O polling herda a proteção de `qrRefetchInterval` via `useGozapQr`: para
 * assim que `state === 'open'`. Só polla enquanto o dialog está aberto
 * (`channelId` vira `undefined` quando fechado) — mesma razão do EVOLUTION,
 * não ficar consultando o GoZap em segundo plano.
 */
export function GozapQrDialog({ channelId, channelName, open, onOpenChange }: Props) {
  const qr = useGozapQr(open ? (channelId ?? undefined) : undefined);
  const qc = useQueryClient();

  /**
   * Pareou → a lista de canais em cache está velha.
   *
   * `useProviders` é `staleTime: Infinity` + `gcTime: Infinity` (ver `api.ts`) —
   * de propósito, porque o conjunto de provedores configurados só muda em
   * deploy. Só que o `phoneE164` de um canal GOZAP vive nessa mesma resposta e
   * MUDA no pareamento (o backend passou a gravá-lo ao ver a sessão viva). Sem
   * invalidar aqui, o operador vê "Conectado!" no diálogo e, ao ir para
   * Campanhas → Nova, encontra o canal ainda rotulado "desconectada" e com o
   * rádio desabilitado (`campaigns/new.tsx` usa `phoneE164` como prova de
   * conexão). Só um F5 resolveria — navegar entre telas, não.
   */
  const paired = qr.data?.state === 'open';
  useEffect(() => {
    if (!paired) return;
    void qc.invalidateQueries({ queryKey: ['whatsapp', 'providers'] });
  }, [paired, qc]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Conectar {channelName}</DialogTitle>
        </DialogHeader>
        <QrPane
          qr={qr.data}
          state={qr.data?.state}
          instanceName={channelName}
          onRetry={() => void qr.refetch()}
          isFetching={qr.isFetching}
          isError={qr.isError}
        />
      </DialogContent>
    </Dialog>
  );
}
