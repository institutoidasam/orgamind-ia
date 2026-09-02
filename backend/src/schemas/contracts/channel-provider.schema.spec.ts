import { describe, it, expect } from 'vitest';
import {
  PROVIDER_TRAITS,
  OFFICIAL_PROVIDERS,
  isOfficialProvider,
  isSessionProvider,
  hasMetaSessionWindow,
  channelProviderEnum,
} from './channel-provider.schema';

describe('PROVIDER_TRAITS (F0)', () => {
  it('cobre exatamente os providers do enum', () => {
    expect(Object.keys(PROVIDER_TRAITS).sort()).toEqual(
      [...channelProviderEnum.options].sort(),
    );
  });

  it('OFFICIAL_PROVIDERS derivada é idêntica à lista histórica', () => {
    // Teste de contrato da neutralidade: a lista antiga era
    // ['TWILIO', 'META', 'ZERNIO'] (allowlist explícita).
    expect([...OFFICIAL_PROVIDERS].sort()).toEqual(['META', 'TWILIO', 'ZERNIO']);
  });

  it('isOfficialProvider preserva o comportamento anterior', () => {
    expect(isOfficialProvider('TWILIO')).toBe(true);
    expect(isOfficialProvider('ZERNIO')).toBe(true);
    expect(isOfficialProvider('META')).toBe(true);
    expect(isOfficialProvider('EVOLUTION')).toBe(false);
    expect(isOfficialProvider(null)).toBe(false);
    expect(isOfficialProvider(undefined)).toBe(false);
  });

  it('isSessionProvider: EVOLUTION e GOZAP são de sessão', () => {
    expect(isSessionProvider('EVOLUTION')).toBe(true);
    expect(isSessionProvider('TWILIO')).toBe(false);
    expect(isSessionProvider('ZERNIO')).toBe(false);
    expect(isSessionProvider('META')).toBe(false);
    expect(isSessionProvider(null)).toBe(false);
    expect(isSessionProvider(undefined)).toBe(false);
    expect(isSessionProvider('GOZAP')).toBe(true);
  });

  // ── TRIPWIRE DE COMPLIANCE — não "conserte" apagando ──────────────────────
  // Três sites decidem se o override de consentimento (disparo SEM
  // consentimento, com justificativa escrita e teto de destinatários) sobrevive:
  // campaign-consent-gate.mayStillSendToContact, a invariante de criação em
  // campaigns.service.create e o resolveConsentOverride do disparo. Os três
  // perguntam `!isOfficialProvider(provider)` — ou seja, o override é concedido
  // a QUALQUER provider marcado `official: false`.
  //
  // GOZAP entrou em PROVIDER_TRAITS como `official: false` (não-oficial, mesma
  // semântica da EVOLUTION). Isso ampliaria o override automaticamente — o que
  // este teste é feito para detectar. Foi detectado, e submetido a decisão
  // humana: ver docs/superpowers/specs/2026-08-02-gozap-provider-design.md
  // §6-bis (decidido por Andre Lima, dono do produto, 2026-08-02) — SIM, o
  // override vale também no GoZap. A lista abaixo reflete essa decisão. O
  // tripwire continua valendo para o 3º provider não-oficial que aparecer.
  it('o override de consentimento sobrevive em EVOLUTION e GOZAP — mudar isto exige decisão humana registrada', () => {
    expect(channelProviderEnum.options.filter((p) => !isOfficialProvider(p))).toEqual(['EVOLUTION', 'GOZAP']);
  });

  it('hasMetaSessionWindow espelha session-window.ts: TWILIO e ZERNIO', () => {
    expect(hasMetaSessionWindow('TWILIO')).toBe(true);
    expect(hasMetaSessionWindow('ZERNIO')).toBe(true);
    expect(hasMetaSessionWindow('EVOLUTION')).toBe(false);
    expect(hasMetaSessionWindow('META')).toBe(false);
    expect(hasMetaSessionWindow(null)).toBe(false);
  });

  it('GOZAP é provider de sessão, não-oficial, sem janela', () => {
    expect(isSessionProvider('GOZAP')).toBe(true);
    expect(isOfficialProvider('GOZAP')).toBe(false);
    expect(hasMetaSessionWindow('GOZAP')).toBe(false);
  });
});
