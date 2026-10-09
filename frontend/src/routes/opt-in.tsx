import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Skeleton } from '@/components/ui/skeleton';
import { OptInForm } from '@/features/consent/components/opt-in-form';
import {
  usePublicConsentText,
  usePublicOptIn,
  type PublicOptInResult,
} from '@/features/consent/public-optin';
import { usePublicOrganization } from '@/features/organization/api';
import logoSvg from '@/assets/logo.svg';

const optInSearchSchema = z.object({
  /** Finalidade. Vem no QR/link do ponto de coleta (`/opt-in?purposeKey=…`). */
  purposeKey: z.string().optional(),
});

/**
 * C4 — a landing pública de opt-in (spec §3.2). **FORA de `_authenticated`**: é
 * aberta no celular de quem não tem (nem terá) conta no orgamind, por QR de cartaz,
 * link de bio ou SMS.
 *
 * O que a página exibe ao lado do checkbox é o `ConsentText` VERSIONADO servido
 * pelo backend — não copy do React. O corpo é a prova, e o mesmo corpo é gravado
 * em `ConsentEvent.evidenceText` junto com IP, user-agent e a versão do texto.
 *
 * E a organização que a página NOMEIA vem de `GET /public/organization` — não de
 * uma constante. Era hardcoded, e um titular deste deploy autorizando o nome de
 * outra organização é um consentimento incoerente: a Meta exige que o opt-in
 * nomeie o negócio e a LGPD exige controlador determinado (art. 8º).
 */
export const Route = createFileRoute('/opt-in')({
  validateSearch: optInSearchSchema,
  component: OptInPage,
});

/** Sem `?purposeKey=`, a finalidade mais provável de um cartaz/QR de campo. */
const DEFAULT_PURPOSE = 'convite_atividades';

function OptInPage() {
  const { purposeKey } = Route.useSearch();
  const text = usePublicConsentText(purposeKey ?? DEFAULT_PURPOSE);
  const org = usePublicOrganization();
  const optIn = usePublicOptIn();
  const [result, setResult] = useState<PublicOptInResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Enquanto a identidade não chega, a página não NOMEIA ninguém. Um placeholder
  // ("Organização", ou pior: um nome default) apareceria por um instante numa
  // tela cuja função é declarar quem está pedindo o consentimento — e um nome
  // errado, mesmo por um instante, é o bug que esta feature existe para matar.
  const nome = org.data?.name ?? '';
  const razaoSocial = org.data?.legalName ?? '';

  return (
    <div className="flex min-h-screen flex-col" style={{ background: 'var(--canvas)' }}>
      <header
        className="flex items-center gap-2 px-5 py-4 text-white"
        style={{ background: 'var(--brand-navy)' }}
      >
        <img src={logoSvg} alt="" className="size-6" aria-hidden />
        <span className="text-lg font-bold tracking-tight">{nome}</span>
      </header>

      {/* max-w + px generosos: isto é aberto no celular, em 3G, no meio do campo. */}
      <main className="mx-auto w-full max-w-[520px] flex-1 px-5 py-8 sm:py-12"><div className="rounded-lg border p-5 sm:p-6" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          {result ? (
          <ResultPanel result={result} />
        ) : text.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : text.isError || !text.data ? (
          <div className="space-y-2">
            <h1 className="text-xl font-semibold">Link indisponível</h1>
            <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
              Este link de autorização não está mais válido. Procure a equipe
              {nome ? ` de ${nome}` : ''} para receber um link novo.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold leading-tight">
                {nome ? `Receber mensagens de ${nome}` : 'Receber mensagens'}
              </h1>
              <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
                {text.data.purposeLabel}
              </p>
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-lg border p-3 text-sm text-destructive"
                style={{ borderColor: 'var(--destructive)' }}
              >
                {error}
              </p>
            )}

            <OptInForm
              text={text.data}
              isPending={optIn.isPending}
              onSubmit={async (input) => {
                setError(null);
                try {
                  setResult(await optIn.mutateAsync(input));
                } catch {
                  // Sem `toast` aqui: a landing é uma página só, aberta em 3G, e
                  // um toast que some é exatamente o que não se quer quando o
                  // envio falhou. O erro fica na tela até a pessoa reenviar.
                  setError(
                    'Não foi possível registrar agora. Confira o número e tente de novo em alguns instantes.',
                  );
                }
              }}
            />
          </div>
          )}
        </div></main>

      {/* A razão social por extenso: quem é o CONTROLADOR dos dados. É o que a
          LGPD (art. 9º I) quer visível para o titular, e vem da configuração. */}
      <footer
        className="px-5 py-6 text-center text-xs"
        style={{ color: 'var(--foreground-muted)' }}
      >
        {razaoSocial}
        {org.data?.supportContact ? (
          <span className="mt-1 block">{org.data.supportContact}</span>
        ) : null}
      </footer>
    </div>
  );
}

/**
 * Tela de sucesso — e a de "você pediu PARAR". A segunda não é um erro: é a
 * recusa deliberada de ressuscitar, por formulário público, quem revogou. O
 * caminho de volta é pelo WhatsApp (VOLTAR), que prova posse do número.
 */
function ResultPanel({ result }: { result: PublicOptInResult }) {
  const ok = result.status === 'ok';
  return (
    <div className="space-y-3 text-center">
      <div
        aria-hidden
        className="mx-auto flex size-14 items-center justify-center rounded-full text-2xl"
        style={{
          background: ok ? 'var(--brand-orange)' : 'var(--muted)',
          color: ok ? 'var(--brand-navy)' : 'var(--foreground-muted)',
        }}
      >
        {ok ? '✓' : '!'}
      </div>
      <h1 className="text-xl font-semibold">
        {ok ? 'Autorização registrada!' : 'Este número saiu da lista'}
      </h1>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--foreground-muted)' }}>
        {result.message}
      </p>
    </div>
  );
}
