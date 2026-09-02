import { describe, it, expect } from 'vitest';
import { isExternallyReachableUrl } from './public-url';

describe('isExternallyReachableUrl', () => {
  it('aceita domínios públicos, com ou sem porta/caminho', () => {
    expect(isExternallyReachableUrl('https://picoa.app.br/api')).toBe(true);
    expect(isExternallyReachableUrl('https://picoa.app.br')).toBe(true);
    expect(
      isExternallyReachableUrl('http://exemplo.com.br:8080/webhooks'),
    ).toBe(true);
    // http puro num host público é alcançável de verdade (túnel de dev) —
    // recusá-lo tornaria o guard um estorvo justo onde ele mais é usado.
    expect(isExternallyReachableUrl('http://abc123.ngrok-free.app')).toBe(true);
    // IP público literal.
    expect(isExternallyReachableUrl('http://8.8.8.8:3000')).toBe(true);
  });

  it('recusa o hostname de rótulo único do docker-compose — o caso do incidente', () => {
    expect(isExternallyReachableUrl('http://api:3000')).toBe(false);
    expect(isExternallyReachableUrl('http://worker:3000')).toBe(false);
    expect(isExternallyReachableUrl('http://evolution-api:8080')).toBe(false);
  });

  it('recusa loopback e sufixos de rede local', () => {
    expect(isExternallyReachableUrl('http://localhost:3000')).toBe(false);
    expect(isExternallyReachableUrl('http://LOCALHOST:3000')).toBe(false);
    expect(isExternallyReachableUrl('https://picoa.local')).toBe(false);
    expect(isExternallyReachableUrl('https://picoa.internal')).toBe(false);
    expect(isExternallyReachableUrl('https://picoa.lan')).toBe(false);
    expect(isExternallyReachableUrl('https://picoa.home.arpa')).toBe(false);
  });

  it('recusa faixas IPv4 privadas / loopback / link-local / CGNAT', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.0.10',
      '100.64.0.1',
    ]) {
      expect(isExternallyReachableUrl(`http://${ip}:3000`), ip).toBe(false);
    }
    // Fora das faixas privadas — 172.15 e 172.32 NÃO são RFC1918.
    expect(isExternallyReachableUrl('http://172.15.0.1:3000')).toBe(true);
    expect(isExternallyReachableUrl('http://172.32.0.1:3000')).toBe(true);
    expect(isExternallyReachableUrl('http://100.63.0.1:3000')).toBe(true);
  });

  it('recusa IPv6 loopback / unique-local / link-local', () => {
    expect(isExternallyReachableUrl('http://[::1]:3000')).toBe(false);
    expect(isExternallyReachableUrl('http://[fd00::1]:3000')).toBe(false);
    expect(isExternallyReachableUrl('http://[fe80::1]:3000')).toBe(false);
    expect(isExternallyReachableUrl('http://[2001:4860:4860::8888]:3000')).toBe(
      true,
    );
  });

  it('recusa entrada vazia, lixo e protocolos não-HTTP', () => {
    expect(isExternallyReachableUrl(undefined)).toBe(false);
    expect(isExternallyReachableUrl(null)).toBe(false);
    expect(isExternallyReachableUrl('')).toBe(false);
    expect(isExternallyReachableUrl('picoa.app.br')).toBe(false); // sem protocolo
    expect(isExternallyReachableUrl('ftp://picoa.app.br')).toBe(false);
    expect(isExternallyReachableUrl('file:///etc/passwd')).toBe(false);
  });
});
