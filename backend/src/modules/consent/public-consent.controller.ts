import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { PublicOptInDto } from './dto/public-optin.dto';
import {
  PublicConsentService,
  type PublicConsentTextView,
  type PublicOptInResult,
} from './public-consent.service';

/**
 * C4 — a landing pública de opt-in (spec §3.2). Aberta no celular, por QR ou
 * link, por gente que não tem (nem terá) conta no orgamind: `@Public()`.
 *
 * **Rate limit é obrigatório aqui**, e é a única proteção dura: captcha está
 * proibido nesta feature (o público é ribeirinho/rural — captcha derruba
 * conversão e exclui justamente quem a landing existe para alcançar). O
 * `UserThrottlerGuard` global chaveia por IP quando não há usuário autenticado,
 * que é exatamente o caso destas rotas.
 *
 * O POST responde **200** (e não 201): a resposta é sempre a mesma mensagem
 * genérica, e um 201 "Created" já denunciaria que a submissão virou linha nova —
 * o que, no honeypot e no telefone já cadastrado, é justamente o que não pode
 * vazar.
 */
@ApiTags('consent')
@Public()
@Controller('public')
export class PublicConsentController {
  constructor(private readonly publicConsent: PublicConsentService) {}

  @ApiOperation({
    summary:
      'Texto canônico VIGENTE de consentimento da finalidade (o que a landing exibe ao lado do checkbox)',
  })
  // Mais folgado que o POST: a página faz um GET por render, e um QR de feira é
  // escaneado por dezenas de pessoas na mesma rede (mesmo IP de saída).
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Get('consent-text')
  consentText(
    @Query('purposeKey') purposeKey?: string,
  ): Promise<PublicConsentTextView> {
    if (!purposeKey?.trim()) {
      throw new BadRequestException('Informe a finalidade (purposeKey).');
    }
    return this.publicConsent.activeText(purposeKey.trim());
  }

  @ApiOperation({
    summary:
      'Registra o opt-in coletado na landing pública (GRANT, source=WEB_FORM, com IP/user-agent/texto+versão na evidência)',
  })
  @Throttle({ default: { ttl: 10 * 60_000, limit: 5 } })
  @HttpCode(200)
  @Post('opt-in')
  submit(
    @Body() dto: PublicOptInDto,
    @Req() req: Request,
  ): Promise<PublicOptInResult> {
    // `req.ip` é o IP real do titular: o `trust proxy = 1` de main.ts já desconta
    // o único hop de proxy reverso. Sem isso, TODA submissão teria o IP do proxy
    // — a evidência seria inútil e o rate limit, um balde único para o mundo.
    return this.publicConsent.submit(dto, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      url: `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`,
    });
  }
}
