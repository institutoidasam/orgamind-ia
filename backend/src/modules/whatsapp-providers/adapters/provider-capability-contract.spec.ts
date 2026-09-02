import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { MessageProvider } from '../ports/message-provider.port';
import type { ProviderCapability } from '../ports/provider-profile';
import { EvolutionApiAdapter } from './evolution-api.adapter';
import { MetaCloudAdapter } from './meta-cloud.adapter';
import { TwilioCloudAdapter } from './twilio-cloud.adapter';
import { ZernioCloudAdapter } from './zernio-cloud.adapter';
import { GozapCloudAdapter } from './gozap-cloud.adapter';

/**
 * Contrato "capacidade DECLARADA ⇒ método IMPLEMENTADO".
 *
 * O F0 trocou uma SONDAGEM (`typeof adapter.fetchMessageStatus === 'function'`)
 * por uma DECLARAÇÃO (`profile.capabilities`). A sondagem mentia numa direção
 * (stub-que-lança conta como implementado); a declaração pode mentir na outra —
 * e nada guardava esse lado. `makeProfile` aceita qualquer array e TODOS os
 * métodos do port são opcionais, então declarar uma capacidade que o adapter
 * não implementa compila, passa nos testes e falha em SILÊNCIO em produção:
 * `supportsStatusPollingFor` confia na declaração enquanto
 * `fetchMessageStatusFor` ainda faz `?.fetchMessageStatus?.()` — um adapter que
 * declare `statusPolling` sem o método faz o sending-reconciler classificar
 * TODA mensagem como `stillPending` em todo tick, para sempre, sem erro e sem
 * métrica.
 *
 * A direção é UMA SÓ, de propósito. A recíproca ("método presente ⇒ capacidade
 * declarada") é FALSA por design: Twilio e Meta implementam stubs que lançam
 * (`sendMedia`, `findChats`, …) justamente porque `typeof` não distingue
 * "implementa" de "existe para lançar" — expressar essa diferença é o motivo de
 * o modelo de capacidades existir.
 */
const CAPABILITY_METHODS: Record<ProviderCapability, (keyof MessageProvider)[]> = {
  campaignSend: ['sendTemplate'],
  statusPolling: ['fetchMessageStatus'],
  sessionLifecycle: ['getConnectionInfo'],
  inboxChat: ['sendChatText'],
  chatMedia: ['sendMedia', 'sendWhatsAppAudio', 'getMediaBase64'],
  contactTools: ['checkNumbersOnWhatsapp', 'fetchProfilePictureUrl'],
  labels: ['fetchLabels', 'handleContactLabel'],
  historySync: ['findChats', 'findMessages'],
};

function config(values: Record<string, string>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

// Os 4 adapters REAIS (não fakes): é a declaração de produção que precisa ser
// verificada. Credenciais de fixture — nenhum teste aqui faz I/O, só inspeciona
// a presença dos métodos.
const ADAPTERS: Array<[string, MessageProvider]> = [
  [
    'EvolutionApiAdapter',
    new EvolutionApiAdapter(
      config({
        EVOLUTION_BASE_URL: 'http://evolution:8080',
        EVOLUTION_API_KEY: 'KEY',
        EVOLUTION_INSTANCE_NAME: 'picoa-test',
      }),
    ),
  ],
  [
    'MetaCloudAdapter',
    new MetaCloudAdapter(
      config({
        META_PHONE_NUMBER_ID: 'PNID',
        META_ACCESS_TOKEN: 'TOKEN',
        META_APP_SECRET: 'SECRET',
      }),
    ),
  ],
  [
    'TwilioCloudAdapter',
    new TwilioCloudAdapter(
      config({
        TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
        TWILIO_AUTH_TOKEN: 'the-auth-token',
        TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
      }),
    ),
  ],
  ['ZernioCloudAdapter', new ZernioCloudAdapter(config({ ZERNIO_API_KEY: 'sk_test_0' }))],
  [
    'GozapCloudAdapter',
    new GozapCloudAdapter(config({ GOZAP_BASE_URL: 'https://acme.gozap.dev' })),
  ],
];

describe('contrato de capacidades: declarado ⇒ implementado', () => {
  describe.each(ADAPTERS)('%s', (_name, adapter) => {
    const declared = [...adapter.profile.capabilities];

    it('declara ao menos uma capacidade (profile não é placeholder vazio)', () => {
      expect(declared.length).toBeGreaterThan(0);
    });

    it.each(declared)('capacidade %s tem todos os métodos do port', (cap) => {
      for (const method of CAPABILITY_METHODS[cap]) {
        expect(
          typeof (adapter as unknown as Record<string, unknown>)[method],
          `${_name} declara "${cap}" mas não implementa ${method}()`,
        ).toBe('function');
      }
    });
  });

  it('toda capacidade do union tem um mapeamento de métodos', () => {
    // Guarda do próprio mapa: uma capacidade nova no union sem entrada aqui
    // deixaria o contrato acima cego para ela (o `Record` já quebra a
    // compilação; isto documenta a intenção e vale em runtime).
    for (const methods of Object.values(CAPABILITY_METHODS)) {
      expect(methods.length).toBeGreaterThan(0);
    }
  });
});
