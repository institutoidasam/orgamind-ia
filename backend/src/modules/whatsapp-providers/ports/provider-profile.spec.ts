import { describe, it, expect } from 'vitest';
import { PROVIDER_TRAITS } from '../../../schemas/contracts/channel-provider.schema';
import { makeProfile, supports } from './provider-profile';

describe('ProviderProfile (F0)', () => {
  // O nome antigo ("congela as capacidades") prometia mais do que o corpo
  // verificava: `new Set(caps)` é mutável em runtime e `ReadonlySet` só existe
  // no compilador. O que o teste de fato cobre é a consulta ao Set + o
  // repasse dos traits; o freeze REAL (do objeto profile, não do conteúdo do
  // Set) tem asserção própria abaixo.
  it('makeProfile expõe as capacidades declaradas num Set consultável e repassa os traits', () => {
    const p = makeProfile(PROVIDER_TRAITS.EVOLUTION, ['campaignSend', 'labels']);
    expect(p.capabilities.has('campaignSend')).toBe(true);
    expect(p.capabilities.has('statusPolling')).toBe(false);
    expect(p.traits.sessionBased).toBe(true);
  });

  it('o objeto profile é congelado — trocar traits/capabilities de um adapter pronto não pega', () => {
    const p = makeProfile(PROVIDER_TRAITS.EVOLUTION, ['campaignSend']);
    expect(Object.isFrozen(p)).toBe(true);
    const mutable = p as unknown as Record<string, unknown>;
    expect(() => { mutable.capabilities = new Set(); }).toThrow();
    expect(p.capabilities.has('campaignSend')).toBe(true);
  });
  it('supports() responde pelo profile', () => {
    const holder = { profile: makeProfile(PROVIDER_TRAITS.TWILIO, ['statusPolling']) };
    expect(supports(holder, 'statusPolling')).toBe(true);
    expect(supports(holder, 'chatMedia')).toBe(false);
  });
});
