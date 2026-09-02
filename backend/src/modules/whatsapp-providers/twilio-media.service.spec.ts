import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

import axios from 'axios';
import type { ConfigService } from '@nestjs/config';
import { TwilioMediaService } from './twilio-media.service';

const ACCOUNT_SID = 'AC00000000000000000000000000000000';
const AUTH_TOKEN = 'the-auth-token';
const MEDIA_URL = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/MM1/Media/ME1`;

const axiosGet = vi.mocked(axios.get);

function makeConfig(values: Record<string, string | undefined>) {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function makeService(
  overrides: Record<string, string | undefined> = {},
): TwilioMediaService {
  return new TwilioMediaService(
    makeConfig({
      TWILIO_ACCOUNT_SID: ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      ...overrides,
    }),
  );
}

describe('TwilioMediaService', () => {
  beforeEach(() => {
    axiosGet.mockReset();
  });

  it('baixa a mídia com Basic Auth quando a Twilio responde 200 direto', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from('binary-image'),
      headers: { 'content-type': 'image/jpeg' },
    });

    const result = await makeService().download(MEDIA_URL);

    expect(result.buffer.toString()).toBe('binary-image');
    expect(result.mimeType).toBe('image/jpeg');
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(axiosGet).toHaveBeenCalledWith(
      MEDIA_URL,
      expect.objectContaining({
        auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
        responseType: 'arraybuffer',
        maxRedirects: 0,
        maxContentLength: 96 * 1024 * 1024,
      }),
    );
  });

  it('segue o redirect para o storage SEM enviar as credenciais no segundo hop', async () => {
    axiosGet
      .mockResolvedValueOnce({
        status: 307,
        data: Buffer.alloc(0),
        headers: { location: 'https://storage.example.com/signed/abc' },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: Buffer.from('redirected-bytes'),
        headers: { 'content-type': 'audio/ogg' },
      });

    const result = await makeService().download(MEDIA_URL);

    expect(result.buffer.toString()).toBe('redirected-bytes');
    expect(result.mimeType).toBe('audio/ogg');
    expect(axiosGet).toHaveBeenCalledTimes(2);
    const [secondUrl, secondOpts] = axiosGet.mock.calls[1];
    expect(secondUrl).toBe('https://storage.example.com/signed/abc');
    expect(secondOpts).not.toHaveProperty('auth');
    expect(secondOpts).toMatchObject({
      responseType: 'arraybuffer',
      maxContentLength: 96 * 1024 * 1024,
    });
  });

  it('lança erro PT-BR quando o redirect vem sem header Location', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 307,
      data: Buffer.alloc(0),
      headers: {},
    });

    await expect(makeService().download(MEDIA_URL)).rejects.toThrow(
      /sem header Location/,
    );
  });

  it('lança erro PT-BR quando as credenciais Twilio estão ausentes', async () => {
    const svc = makeService({
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
    });
    await expect(svc.download(MEDIA_URL)).rejects.toThrow(/Credenciais da Twilio ausentes/);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('propaga o erro do axios (o processor marca a mídia FAILED)', async () => {
    axiosGet.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(makeService().download(MEDIA_URL)).rejects.toThrow('ECONNRESET');
  });

  it('retorna mimeType null quando o content-type está ausente', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from('x'),
      headers: {},
    });
    const result = await makeService().download(MEDIA_URL);
    expect(result.mimeType).toBeNull();
  });

  // SSRF/credential-leak guard: a MediaUrl vem do PAYLOAD do webhook — o Basic
  // Auth só pode ir para hosts da própria Twilio, nunca para host arbitrário.
  describe('validação de host (SSRF / vazamento de credenciais)', () => {
    it('rejeita URL de mídia fora do domínio Twilio SEM chamar axios', async () => {
      await expect(
        makeService().download('https://evil.example.com/roubar-credenciais'),
      ).rejects.toThrow(/fora do domínio Twilio/);
      expect(axiosGet).not.toHaveBeenCalled();
    });

    it('rejeita URL http:// (não-https) SEM chamar axios', async () => {
      await expect(
        makeService().download(`http://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/MM1/Media/ME1`),
      ).rejects.toThrow(/fora do domínio Twilio/);
      expect(axiosGet).not.toHaveBeenCalled();
    });

    it('rejeita URL inválida (não parseável) SEM chamar axios', async () => {
      await expect(makeService().download('nada-de-url')).rejects.toThrow(/inválida/);
      expect(axiosGet).not.toHaveBeenCalled();
    });

    it('aceita media.twilio.com (case-insensitive, trailing dot normalizado)', async () => {
      axiosGet.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from('ok'),
        headers: { 'content-type': 'image/png' },
      });
      const result = await makeService().download('https://MEDIA.twilio.com./v1/media/ME1');
      expect(result.buffer.toString()).toBe('ok');
    });

    it('rejeita redirect com Location não-https (sem segundo GET)', async () => {
      axiosGet.mockResolvedValueOnce({
        status: 307,
        data: Buffer.alloc(0),
        headers: { location: 'http://interno.local/metadata' },
      });
      await expect(makeService().download(MEDIA_URL)).rejects.toThrow(/não-HTTPS/);
      expect(axiosGet).toHaveBeenCalledTimes(1);
    });
  });
});
