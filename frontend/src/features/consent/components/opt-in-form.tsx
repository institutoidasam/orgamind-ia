import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PublicConsentText, PublicOptInInput } from '../public-optin';

type Props = {
  /** O texto canônico VERSIONADO da finalidade, vindo do backend. */
  text: PublicConsentText;
  onSubmit: (input: PublicOptInInput) => void;
  isPending: boolean;
};

/**
 * C4 — o formulário da landing pública (spec §3.2).
 *
 * Três decisões que não são de estilo:
 *
 * 1. **O texto exibido é o do backend**, palavra por palavra (`ConsentText`
 *    versionado). O React não escreve, não resume e não reformula a declaração —
 *    ele a renderiza. O corpo é a prova (art. 8º §2º), e o mesmo corpo é o que o
 *    servidor grava em `evidenceText`.
 * 2. **A caixa nasce desmarcada** e o consentimento não está embutido em nenhum
 *    "aceito os termos". Ato afirmativo ou nada.
 * 3. **Honeypot no lugar do captcha.** Captcha está proibido nesta feature: o
 *    público é ribeirinho/rural, com conectividade ruim — captcha derruba
 *    conversão e exclui exatamente quem a landing existe para alcançar.
 */
export function OptInForm({ text, onSubmit, isPending }: Props) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot — humano deixa vazio
  const [showErrors, setShowErrors] = useState(false);

  // Fixado no 1º render: é o "quando a pessoa viu o texto". Alimenta o
  // time-to-submit (< 2s = bot) e entra na evidência (spec §2.4).
  const renderedAt = useRef(new Date().toISOString());

  const [declaration, ...rest] = text.body.split('\n').filter((l) => l.trim());
  const phoneMissing = phone.trim().length === 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (phoneMissing || !accepted) {
      setShowErrors(true);
      return;
    }
    onSubmit({
      phone: phone.trim(),
      name: name.trim() || undefined,
      purposeKey: text.purposeKey,
      accepted,
      website,
      renderedAt: renderedAt.current,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="phone">Seu WhatsApp</Label>
        <Input
          id="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="(92) 98765-4321"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-invalid={showErrors && phoneMissing}
        />
        {showErrors && phoneMissing && (
          <p className="text-xs text-destructive">Digite o número com DDD.</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="name">Seu nome (opcional)</Label>
        <Input
          id="name"
          autoComplete="name"
          placeholder="Como podemos te chamar?"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {/*
        HONEYPOT. Fora do fluxo visual, fora da ordem de foco, fora do leitor de
        tela e fora do autofill — um humano não tem como preenchê-lo. Bot de
        formulário preenche todo input que encontra, e o backend descarta a
        submissão em silêncio (200 idêntico ao sucesso).
      */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '-9999px',
          width: 1,
          height: 1,
          overflow: 'hidden',
        }}
      >
        <label htmlFor="website">Não preencha este campo</label>
        <input
          id="website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      <div
        className="rounded-lg border p-4"
        style={{ borderColor: 'var(--border)', background: 'var(--muted, transparent)' }}
      >
        <div className="flex gap-3">
          <Checkbox
            id="accept"
            checked={accepted}
            onCheckedChange={(v) => setAccepted(v === true)}
            aria-describedby="accept-detail"
            className="mt-1"
          />
          <div className="space-y-1.5">
            <Label htmlFor="accept" className="block text-sm font-semibold leading-snug">
              {declaration}
            </Label>
            <div
              id="accept-detail"
              className="space-y-1 text-xs leading-relaxed"
              style={{ color: 'var(--foreground-muted)' }}
            >
              {rest.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        </div>
        {showErrors && !accepted && (
          <p className="mt-3 text-xs text-destructive">
            Para continuar, marque a autorização acima.
          </p>
        )}
      </div>

      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? 'Enviando…' : 'Autorizar e receber mensagens'}
      </Button>
    </form>
  );
}
