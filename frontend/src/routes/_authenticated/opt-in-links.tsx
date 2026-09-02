import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useOptInLinks,
  useCreateOptInLink,
  useSetOptInLinkActive,
} from '@/features/consent/optin-links';
import { useConsentPurposes } from '@/features/consent/api';
import { useInstances } from '@/features/whatsapp/api';
import { OptInLinkCard } from '@/features/consent/components/optin-link-card';

export const Route = createFileRoute('/_authenticated/opt-in-links')({
  component: OptInLinksPage,
});

/**
 * C3 — Links & QR de opt-in (spec §3.1).
 *
 * A tela existe porque a coleta de consentimento saiu do WhatsApp. O orgamind não
 * pode disparar para a base fria pedindo permissão (é violação da política da
 * Meta e o número morre); o que ele pode é gerar um link/QR que a PESSOA aciona
 * — custo zero, risco de ban zero, e a mensagem dela já é a declaração.
 *
 * Onde isto vai parar: cartaz de evento, prancheta do agente de campo, adesivo
 * em material impresso, bio do Instagram, Status do WhatsApp, site, e o locutor
 * da rádio comunitária ditando o número.
 */
function OptInLinksPage() {
  const links = useOptInLinks();
  const purposes = useConsentPurposes();
  const instances = useInstances();
  const create = useCreateOptInLink();
  const setActive = useSetOptInLinkActive();

  const [token, setToken] = useState('');
  const [purposeKey, setPurposeKey] = useState('');
  const [channelId, setChannelId] = useState('');
  const [description, setDescription] = useState('');

  const canSubmit = token.trim().length >= 3 && !!purposeKey && !!channelId;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      await create.mutateAsync({
        token: token.trim().toUpperCase(),
        purposeKey,
        channelId,
        description: description.trim() || undefined,
      });
      toast.success('Link de opt-in criado');
      setToken('');
      setDescription('');
    } catch {
      toast.error('Falha ao criar o link (token já usado? finalidade sem texto publicado?)');
    }
  }

  if (links.isError) {
    return <QueryErrorFallback error={links.error} onRetry={() => links.refetch()} />;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Links &amp; QR de opt-in</h1>
        <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
          Cada link gera um QR Code imprimível. O texto que já vem escrito na mensagem{' '}
          <strong>é a autorização</strong> — quem envia está consentindo, e o token de origem
          diz de qual cartaz, evento ou canal esse consentimento veio.
        </p>
      </header>

      <Card className="no-print">
        <CardHeader>
          <CardTitle>Novo ponto de coleta</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="token">Token de origem</Label>
              <Input
                id="token"
                value={token}
                onChange={(e) => setToken(e.target.value.toUpperCase())}
                placeholder="FEIRA-MANAUS-2026"
                className="font-mono"
              />
              <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                Um por cartaz/evento/canal. Letras, números e hífen. É o que atribui o
                consentimento à origem certa.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="purpose">Finalidade</Label>
              <Select value={purposeKey} onValueChange={setPurposeKey}>
                <SelectTrigger id="purpose">
                  <SelectValue placeholder="Escolha a finalidade" />
                </SelectTrigger>
                <SelectContent>
                  {(purposes.data ?? []).map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                O texto da autorização é montado a partir dela — e vale só para ela.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="channel">Número que recebe</Label>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger id="channel">
                  <SelectValue placeholder="Escolha o canal" />
                </SelectTrigger>
                <SelectContent>
                  {(instances.data ?? []).map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}
                      {i.phoneE164 ? ` — ${i.phoneE164}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description">Onde vai ser usado (opcional)</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Cartaz da feira de Manaus"
              />
            </div>

            <div className="sm:col-span-2">
              <Button type="submit" disabled={!canSubmit || create.isPending}>
                {create.isPending ? 'Gerando…' : 'Gerar link e QR'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <section className="space-y-4">
        {links.isLoading ? (
          <>
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-56 w-full" />
          </>
        ) : (links.data ?? []).length === 0 ? (
          <p
            className="rounded-lg border border-dashed p-8 text-center text-sm"
            style={{ borderColor: 'var(--border)', color: 'var(--foreground-muted)' }}
          >
            Nenhum ponto de coleta ainda. Gere o primeiro acima — sem link/QR, não há como
            coletar consentimento fora do WhatsApp.
          </p>
        ) : (
          (links.data ?? []).map((link) => (
            <OptInLinkCard
              key={link.id}
              link={link}
              onToggleActive={async (active) => {
                try {
                  await setActive.mutateAsync({ id: link.id, active });
                  toast.success(active ? 'Link reativado' : 'Link desativado');
                } catch {
                  toast.error('Falha ao atualizar o link');
                }
              }}
            />
          ))
        )}
      </section>
    </div>
  );
}
