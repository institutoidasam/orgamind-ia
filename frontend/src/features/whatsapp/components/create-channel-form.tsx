import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { extractApiError } from '@/lib/api-error';
import {
  useCreateChannel,
  useProviders,
  useZernioAccounts,
  type ChannelProvider,
  type ZernioAccount,
} from '../api';
import { PROVIDER_LABEL } from '../provider-scope';

// Same E.164 shape the backend enforces (createChannelSchema): a leading '+'
// followed by 8–15 digits. Validated client-side so the operator gets an inline
// hint before the round-trip; the backend re-validates regardless.
const e164Regex = /^\+\d{8,15}$/;

/**
 * Which field is required is provider-dependent: TWILIO (and any other
 * cloud provider that isn't ZERNIO) needs an E.164 phone number, while ZERNIO
 * needs the id of the WhatsApp account already connected in the Zernio
 * dashboard — the number itself lives over there, not in this form. Built
 * per-render from the `provider` prop rather than as a single static schema.
 */
function buildFormSchema(provider: ChannelProvider, usePicker: boolean) {
  const isZernio = provider === 'ZERNIO';
  return z.object({
    name: z.string().min(2, 'Nome muito curto').max(80, 'Nome muito longo'),
    phoneE164: isZernio
      ? z.string().optional()
      : z
          .string()
          .regex(e164Regex, 'Use o formato E.164, ex.: +5592988887777'),
    twilioMessagingServiceSid: z.string().optional(),
    zernioAccountId: isZernio
      ? z.string().min(
          1,
          // A dica acompanha o modo: no seletor pede-se ESCOLHER, no fallback
          // manual pede-se INFORMAR — a mensagem tem de casar com o que está na tela.
          usePicker
            ? 'Escolha a conta Zernio deste canal'
            : 'ID da conta Zernio é obrigatório',
        )
      : z.string().optional(),
  });
}
// Derived (not hand-declared) so it always matches exactly what zodResolver
// infers from buildFormSchema's return type — the ternaries above mean
// per-field optionality can't be expressed as a single static object type.
type FormValues = z.infer<ReturnType<typeof buildFormSchema>>;

/** "+5592999998888 — Canal CONTINUUM" (ou só o id, se a conta não tiver nem número nem nome). */
function accountLabel(a: ZernioAccount): string {
  const parts = [a.phoneE164, a.displayName].filter(Boolean);
  return parts.length ? parts.join(' — ') : a.id;
}

/**
 * Registers a new cloud-provider channel via `POST /whatsapp/channels`. The
 * collected fields depend on `provider`: TWILIO (and META) collect a name + an
 * E.164 number, plus an optional Twilio Messaging Service SID; ZERNIO instead
 * identifies the WhatsApp account already connected in the Zernio dashboard.
 *
 * Para ZERNIO, a conta é ESCOLHIDA numa lista das contas reais
 * (GET /whatsapp/zernio/accounts), não digitada. Isso é um guard-rail de
 * incidente: um `zernioAccountId` digitado errado não falha em lugar nenhum — ele
 * faz o orgamind descartar em SILÊNCIO todo webhook daquela conta, e um disparo real
 * de ~100 mensagens foi perdido exatamente assim. A entrada manual continua
 * disponível como fallback (e é o único caminho quando o Zernio está fora do ar),
 * porque indisponibilidade do provedor não pode travar a configuração.
 */
export function CreateChannelForm({ provider }: { provider: ChannelProvider }) {
  const create = useCreateChannel();
  const [backendError, setBackendError] = useState<string | null>(null);
  const isTwilio = provider === 'TWILIO';
  const isZernio = provider === 'ZERNIO';
  const [manualZernioId, setManualZernioId] = useState(false);

  const zernioAccounts = useZernioAccounts(isZernio);
  const accounts = zernioAccounts.data?.accounts ?? [];
  // Sem contas listáveis (Zernio fora do ar, ou nenhuma WABA conectada), o
  // seletor não tem o que oferecer — o input manual é o único caminho.
  const canPick = accounts.length > 0 && !zernioAccounts.data?.unavailable;
  // Enquanto as contas carregam, o form fica no MODO seletor (desabilitado,
  // "Carregando…") em vez de renderizar o input manual e trocar de forma
  // sozinho quando a lista chega.
  const pickerLoading = isZernio && zernioAccounts.isLoading && !manualZernioId;
  const usePicker = isZernio && !manualZernioId && (canPick || zernioAccounts.isLoading);

  // Conta que já tem canal ATIVO fica marcada e desabilitada no seletor: o
  // backend recusaria a duplicata de qualquer forma
  // (channel.duplicate_zernio_account), mas o operador merece ver isso na
  // lista, não no erro depois do submit. Canal DESATIVADO não bloqueia —
  // recadastrar a conta é o caminho legítimo de reativação.
  const providers = useProviders();
  const activeChannelByAccountId = new Map<string, string>();
  for (const group of providers.data?.providers ?? []) {
    if (group.provider !== 'ZERNIO') continue;
    for (const ch of group.channels) {
      if (ch.isActive && ch.zernioAccountId) {
        activeChannelByAccountId.set(ch.zernioAccountId, ch.name);
      }
    }
  }

  const form = useForm<FormValues>({
    resolver: zodResolver(buildFormSchema(provider, usePicker)),
    defaultValues: {
      name: '',
      phoneE164: '',
      twilioMessagingServiceSid: '',
      zernioAccountId: '',
    },
  });

  return (
    <form
      onSubmit={form.handleSubmit(async (values) => {
        setBackendError(null);
        try {
          await create.mutateAsync({
            provider,
            name: values.name,
            phoneE164: isZernio ? undefined : values.phoneE164,
            twilioMessagingServiceSid: isTwilio
              ? values.twilioMessagingServiceSid?.trim() || undefined
              : undefined,
            zernioAccountId: isZernio
              ? values.zernioAccountId?.trim() || undefined
              : undefined,
          });
          toast.success('Canal cadastrado');
          form.reset();
        } catch (err) {
          // `title` carries the DomainError's PT-BR phrase; `message` maps to
          // the technical `detail` (e.g. "channelId=..."), same convention as
          // every other extractApiError consumer in the app.
          const { title } = await extractApiError(err);
          setBackendError(title);
        }
      })}
      className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3"
    >
      <p className="text-sm font-medium">
        Cadastrar novo canal {PROVIDER_LABEL[provider]}
      </p>

      {backendError && (
        <Alert variant="destructive">
          <AlertTitle>Não foi possível cadastrar</AlertTitle>
          {/* whitespace-pre-line: o erro do backend lista as contas disponíveis
              uma por linha — sem isso vira um parágrafo ilegível. */}
          <AlertDescription className="whitespace-pre-line">
            {backendError}
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-1">
        <Label htmlFor={`ch-name-${provider}`}>Nome do canal</Label>
        <Input id={`ch-name-${provider}`} {...form.register('name')} />
        {form.formState.errors.name && (
          <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
        )}
      </div>

      {isZernio ? (
        <div className="space-y-1">
          {usePicker ? (
            <>
              <Label htmlFor="ch-zernio-account-select">Conta Zernio</Label>
              <Select
                value={form.watch('zernioAccountId') || undefined}
                onValueChange={(v) => {
                  form.setValue('zernioAccountId', v, { shouldValidate: true });
                  // Sugere o nome do canal a partir da conta — só quando o
                  // operador ainda não digitou nada (o que ele escreveu vence).
                  if (!form.getValues('name')) {
                    const account = accounts.find((a) => a.id === v);
                    const suggested = account?.displayName ?? account?.phoneE164;
                    if (suggested) {
                      form.setValue('name', suggested, { shouldValidate: true });
                    }
                  }
                }}
              >
                <SelectTrigger
                  id="ch-zernio-account-select"
                  aria-label="Conta Zernio"
                  disabled={pickerLoading}
                >
                  <SelectValue
                    placeholder={
                      pickerLoading
                        ? 'Carregando contas do Zernio…'
                        : 'Escolha a conta WhatsApp'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => {
                    const takenBy = activeChannelByAccountId.get(a.id);
                    return (
                      <SelectItem key={a.id} value={a.id} disabled={Boolean(takenBy)}>
                        {accountLabel(a)}
                        {takenBy ? ` · já cadastrada (${takenBy})` : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Contas WhatsApp conectadas na sua conta Zernio. Escolher da lista
                evita o ID errado — um ID errado faz o orgamind perder, em silêncio,
                todas as mensagens e status recebidos.
              </p>
              <button
                type="button"
                className="text-xs underline text-muted-foreground"
                onClick={() => setManualZernioId(true)}
              >
                Prefiro informar o ID manualmente
              </button>
            </>
          ) : (
            <>
              <Label htmlFor="ch-zernio-account">ID da conta Zernio</Label>
              <Input
                id="ch-zernio-account"
                placeholder="a1b2c3d4..."
                {...form.register('zernioAccountId')}
              />
              <p className="text-xs text-muted-foreground">
                {zernioAccounts.isLoading
                  ? 'Carregando as contas do Zernio…'
                  : zernioAccounts.data?.unavailable || zernioAccounts.isError
                    ? 'Não foi possível listar as contas do Zernio agora — informe o ID manualmente. O ID será validado no cadastro.'
                    : 'ID da conta conectada no dashboard do Zernio.'}
              </p>
              {canPick && (
                <button
                  type="button"
                  className="text-xs underline text-muted-foreground"
                  onClick={() => setManualZernioId(false)}
                >
                  Escolher da lista de contas
                </button>
              )}
            </>
          )}
          {form.formState.errors.zernioAccountId && (
            <p className="text-xs text-destructive">
              {form.formState.errors.zernioAccountId.message}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor={`ch-phone-${provider}`}>Número (formato E.164)</Label>
          <Input
            id={`ch-phone-${provider}`}
            placeholder="+5592988887777"
            {...form.register('phoneE164')}
          />
          {form.formState.errors.phoneE164 && (
            <p className="text-xs text-destructive">{form.formState.errors.phoneE164.message}</p>
          )}
        </div>
      )}

      {isTwilio && (
        <div className="space-y-1">
          <Label htmlFor="ch-sid">Messaging Service SID (opcional)</Label>
          <Input
            id="ch-sid"
            placeholder="MG..."
            {...form.register('twilioMessagingServiceSid')}
          />
        </div>
      )}

      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? 'Cadastrando…' : 'Cadastrar canal'}
      </Button>
    </form>
  );
}
