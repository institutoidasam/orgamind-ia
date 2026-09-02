import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Printer, QrCode as QrCodeIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { OptInLink } from '../optin-links';

type Props = {
  link: OptInLink;
  onToggleActive: (active: boolean) => void;
};

/**
 * C3 — um ponto de coleta wa.me/QR (spec §3.1).
 *
 * O QR é gerado NO NAVEGADOR (lib `qrcode`), não no servidor: o conteúdo dele é
 * exatamente a `link.url` que o backend já devolveu, então mandar o servidor
 * rasterizar um PNG seria um round-trip para reencodar um dado que o cliente já
 * tem. Como PNG data-URI, ele imprime, copia e cabe num `<img>` sem rota nova.
 *
 * O que este cartão precisa deixar óbvio para quem vai IMPRIMIR:
 *  - o QR (o entregável físico — cartaz, prancheta, adesivo);
 *  - a DECLARAÇÃO que o link pré-preenche, por extenso: é ela que vira a prova,
 *    e o operador tem o direito de ver o que está mandando imprimir;
 *  - o funil (`grants`): muitos inbounds e poucos GRANTs = o titular está
 *    apagando o texto antes de enviar — problema de copy, não de canal (§7).
 */
export function OptInLinkCard({ link, onToggleActive }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Margem 2 e escala alta: o QR é lido de longe (cartaz) e por câmeras ruins.
    QRCode.toDataURL(link.url, { width: 512, margin: 2, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [link.url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success('Link copiado');
    } catch {
      toast.error('Não foi possível copiar o link');
    }
  }

  return (
    <article
      className="optin-link-card break-inside-avoid rounded-lg border p-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-base font-semibold tracking-tight">{link.token}</h3>
            {link.active ? (
              <Badge variant="secondary">Ativo</Badge>
            ) : (
              <Badge variant="outline">Inativo</Badge>
            )}
          </div>
          <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
            {link.purposeLabel}
            {link.description ? ` · ${link.description}` : ''}
          </p>
          <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
            Número: +{link.senderDigits}
            {link.channelName ? ` (${link.channelName})` : ''} · Texto{' '}
            <span className="font-mono">{link.consentTextVersion}</span>
          </p>
        </div>

        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">{link.grants}</div>
          <div className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
            {link.grants === 1 ? 'consentimento' : 'consentimentos'}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-4">
        <div className="shrink-0">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={`QR Code do link de opt-in ${link.token}`}
              className="size-40 rounded border bg-white p-2"
              style={{ borderColor: 'var(--border)' }}
            />
          ) : (
            <div
              className="grid size-40 place-items-center rounded border"
              style={{ borderColor: 'var(--border)' }}
              aria-hidden
            >
              <QrCodeIcon className="size-6 opacity-40" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          {/*
            A declaração, por extenso. É o texto que o titular vai enviar — e,
            portanto, a prova (art. 8º §2º). Não é detalhe de UI: um operador que
            não vê o que está imprimindo não pode conferir se o texto nomeia a
            organização e a finalidade certas.
          */}
          <div>
            <div
              className="mb-1 text-xs font-medium uppercase tracking-wider"
              style={{ color: 'var(--foreground-muted)' }}
            >
              Texto que o titular envia (a declaração)
            </div>
            <p
              className="rounded border p-2 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
            >
              {link.expectedText}
            </p>
          </div>

          <div className="no-print flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={copy}>
              <Copy className="size-4" /> Copiar link
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="size-4" /> Imprimir
            </Button>
            <Button
              variant={link.active ? 'outline' : 'default'}
              size="sm"
              onClick={() => onToggleActive(!link.active)}
            >
              {link.active ? 'Desativar' : 'Reativar'}
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}
