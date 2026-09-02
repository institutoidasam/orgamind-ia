import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { PublicConsentController } from './public-consent.controller';
import { PublicConsentService } from './public-consent.service';

function makeRequest(over: Partial<Request> = {}): Request {
  return {
    ip: '200.1.2.3',
    headers: { 'user-agent': 'Mozilla/5.0 (Android)' },
    protocol: 'https',
    get: (h: string) =>
      h.toLowerCase() === 'host' ? 'picoa.exemplo.org' : undefined,
    originalUrl: '/public/opt-in',
    ...over,
  } as unknown as Request;
}

describe('PublicConsentController — a superfície SEM login (spec §3.2)', () => {
  let controller: PublicConsentController;
  let service: MockProxy<PublicConsentService>;

  beforeEach(() => {
    service = mockDeep<PublicConsentService>();
    controller = new PublicConsentController(service);
  });

  it('é @Public() — a landing é aberta no celular, por QR, sem conta no orgamind', () => {
    const reflector = new Reflector();
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, PublicConsentController)).toBe(
      true,
    );
  });

  it('POST /public/opt-in tem RATE LIMIT por IP (a proteção dura, já que captcha é proibido)', () => {
    // Chaves que o @Throttle grava (throttler.constants: THROTTLER_LIMIT + nome
    // do throttler). Não são exportadas da raiz do pacote — daí as literais.
    const target = PublicConsentController.prototype.submit;
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', target);
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', target);

    // spec §3.2: 5 submissões / 10 min por IP. Sem isto, um script enche a base
    // de consentimentos fabricados — e cada um deles é uma linha append-only.
    expect(limit).toBe(5);
    expect(ttl).toBe(10 * 60_000);
  });

  it('GET /public/consent-text devolve o texto vigente da finalidade', async () => {
    const view = {
      purposeKey: 'convite_atividades',
      purposeLabel: 'Convites para cursos, oficinas e eventos',
      version: 'optin-v1',
      body: 'Autorizo o IDASAM …',
    };
    service.activeText.mockResolvedValue(view);

    await expect(controller.consentText('convite_atividades')).resolves.toEqual(
      view,
    );
    expect(service.activeText).toHaveBeenCalledWith('convite_atividades');
  });

  it('POST /public/opt-in repassa IP, user-agent e URL para a evidência (spec §2.4)', async () => {
    service.submit.mockResolvedValue({ status: 'ok', message: 'Pronto!' });

    const dto = {
      phone: '(92) 98765-4321',
      purposeKey: 'convite_atividades',
      accepted: true,
    };
    await controller.submit(dto, makeRequest());

    expect(service.submit).toHaveBeenCalledWith(dto, {
      ip: '200.1.2.3',
      userAgent: 'Mozilla/5.0 (Android)',
      url: 'https://picoa.exemplo.org/public/opt-in',
    });
  });
});
