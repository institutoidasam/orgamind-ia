import { useEffect, useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { extractApiError } from '@/lib/api-error';
import { useAuthStore } from '@/stores/auth.store';
import {
  useOrganization,
  useUpdateOrganization,
} from '@/features/organization/api';

/**
 * Configurações → a identidade da organização titular deste deploy.
 *
 * **ADMIN.** Quem edita esta tela edita o nome que vai aparecer no consentimento
 * de todos os titulares daqui para a frente — é a mesma gravidade de escrever o
 * texto de consentimento.
 *
 * O orgamind é single-tenant por instalação (um deploy por cliente): a identidade é
 * um singleton, semeado do env (`ORG_NAME`, `ORG_LEGAL_NAME`) no primeiro
 * deploy. A partir daí a tela vence o env — o seed roda em todo deploy e NÃO
 * sobrescreve o que foi ajustado aqui.
 */
export const Route = createFileRoute('/_authenticated/configuracoes')({
  beforeLoad: () => {
    const { user } = useAuthStore.getState();
    if (user?.role !== 'ADMIN') {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: ConfiguracoesPage,
});

function ConfiguracoesPage() {
  const org = useOrganization();
  const update = useUpdateOrganization();

  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState('');
  const [supportContact, setSupportContact] = useState('');

  useEffect(() => {
    if (!org.data) return;
    setName(org.data.name);
    setLegalName(org.data.legalName);
    setPrivacyPolicyUrl(org.data.privacyPolicyUrl ?? '');
    setSupportContact(org.data.supportContact ?? '');
  }, [org.data]);

  if (org.isError) {
    return <QueryErrorFallback error={org.error} onRetry={() => org.refetch()} />;
  }

  // Sem nome não há organização nomeada — e um texto de consentimento que não
  // nomeia o negócio é inválido para a Meta e para a LGPD. O botão não salva.
  const canSubmit = name.trim().length > 0 && legalName.trim().length > 0;

  async function salvar() {
    if (!canSubmit) return;
    try {
      await update.mutateAsync({
        name: name.trim(),
        legalName: legalName.trim(),
        privacyPolicyUrl: privacyPolicyUrl.trim() || null,
        supportContact: supportContact.trim() || null,
      });
      toast.success('Identidade da organização salva', {
        description:
          'Os textos de consentimento já publicados não mudaram. Para colher sob o nome novo, publique uma nova versão do texto em Opt-in → Finalidades → Texto.',
      });
    } catch (err) {
      const { message } = await extractApiError(err);
      toast.error('Falha ao salvar a identidade', { description: message });
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Configurações</h1>
        <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
          A identidade que o <strong>titular dos dados</strong> vê: o nome no
          texto de consentimento, na página de opt-in e no link/QR do WhatsApp.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Organização</CardTitle>
          <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
            A Meta exige que o texto de opt-in <strong>nomeie o negócio</strong> e
            a LGPD exige o controlador determinado (art. 8º). Um titular que
            autoriza o nome de outra organização não deu um consentimento válido —
            é por isso que este campo não é decoração.
          </p>
        </CardHeader>

        <CardContent data-testid="organization-form" className="space-y-4">
          {org.isLoading || !org.data ? (
            <>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="org-name">Nome curto</Label>
                  <Input
                    id="org-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="CONTINUUM"
                  />
                  <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                    O rótulo do dia a dia: cabeçalho da página de opt-in e das
                    mensagens ao titular.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="org-legal-name">Razão social por extenso</Label>
                  <Input
                    id="org-legal-name"
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder="Canal do Matheus Garcia - CONTINUUM"
                  />
                  <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                    É esta que entra <strong>dentro</strong> do texto de
                    consentimento. Confira contra o CNPJ: é ela que identifica o
                    controlador dos dados.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="org-privacy">Política de privacidade (URL)</Label>
                  <Input
                    id="org-privacy"
                    value={privacyPolicyUrl}
                    onChange={(e) => setPrivacyPolicyUrl(e.target.value)}
                    placeholder="https://exemplo.com.br/privacidade"
                  />
                  <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                    Substitui o <code>{'{url}'}</code> do texto de consentimento.
                    Em branco, aponta para a página do próprio orgamind.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="org-support">Contato de suporte</Label>
                  <Input
                    id="org-support"
                    value={supportContact}
                    onChange={(e) => setSupportContact(e.target.value)}
                    placeholder="contato@exemplo.com.br"
                  />
                  <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                    Por onde o titular fala com a organização. Aparece no rodapé
                    da página pública de opt-in.
                  </p>
                </div>
              </div>

              {/* O aviso que evita o erro silencioso: trocar o nome aqui e seguir
                  colhendo sob o texto antigo (que nomeia outra organização). */}
              <p
                className="rounded-md border p-3 text-xs"
                style={{ borderColor: 'var(--border)', color: 'var(--foreground-muted)' }}
              >
                Trocar a identidade <strong>não reescreve</strong> os
                consentimentos já colhidos: cada um continua apontando para o
                texto que a pessoa leu — é isso que os torna prova (LGPD art. 8º
                §2º, o ônus é do controlador). Para colher sob o nome novo,
                publique uma <strong>nova versão do texto</strong> em Opt-in →
                Finalidades → Texto: o rascunho já vem com esta identidade.
              </p>

              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={() => void salvar()}
                  disabled={!canSubmit || update.isPending}
                >
                  {update.isPending ? 'Salvando…' : 'Salvar'}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
