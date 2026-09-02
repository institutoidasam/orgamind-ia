import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ConsentAction, ConsentSource, Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { Env } from '../../shared/config/env.schema';
import { ConsentService } from './consent.service';
import { OrganizationService } from '../organization/organization.service';
import {
  brazilianPhoneVariants,
  canonicalBrPhoneForm,
  normalizeToE164,
} from '../contacts/phone.util';
import type { PublicOptIn } from '../../schemas/contracts/public-optin.schema';

/** O que a landing exibe: o corpo RENDERIZADO do ConsentText vigente + a versão. */
export type PublicConsentTextView = {
  purposeKey: string;
  purposeLabel: string;
  /** Versão do ConsentText — vai para o `consentTextVersion` de todo GRANT. */
  version: string;
  /** Corpo já com `{url}` resolvido. É EXATAMENTE o que vira `evidenceText`. */
  body: string;
};

export type PublicOptInResult = {
  /** 'ok' cobre sucesso, honeypot e bot — a resposta é a mesma de propósito. */
  status: 'ok' | 'suppressed';
  message: string;
};

/** Metadados do request que compõem a evidência (spec §2.4, WEB_FORM). */
export type PublicOptInMeta = {
  ip: string | null;
  userAgent: string | null;
  url: string;
};

/**
 * Resposta ÚNICA do caminho de sucesso — e também a do honeypot e a do bot
 * rápido. Uma resposta diferente para "esse telefone já existe" seria um oráculo
 * de enumeração: qualquer um descobriria quem está na base da organização
 * digitando números num formulário aberto.
 */
const GENERIC_OK: PublicOptInResult = {
  status: 'ok',
  message:
    'Pronto! Sua autorização foi registrada. Em breve você recebe uma confirmação no WhatsApp.',
};

/** < 2s entre o render e o envio é bot: nenhum humano lê o termo nesse tempo. */
const MIN_TIME_TO_SUBMIT_MS = 2_000;

/**
 * C4 — a landing page pública de opt-in (spec §3.2).
 *
 * É o único ponto do orgamind em que um consentimento nasce de um request SEM
 * autenticação, e é por isso que o serviço é escrito na defensiva:
 *
 *  - o **texto** (a prova) é resolvido AQUI, do `ConsentText` versionado da
 *    finalidade. O cliente manda um `purposeKey`, nunca um corpo de texto —
 *    senão o navegador escreveria a própria prova;
 *  - `purposeKey` desconhecida/inativa é **404**, nunca um GRANT com finalidade
 *    inventada (art. 8º §4º: autorização genérica é nula);
 *  - **suprimido não ressuscita**. `ConsentService.record(GRANT)` levanta a
 *    supressão (regra 4 do §2.7) — o que é certo quando o ato vem do WhatsApp do
 *    próprio titular (wamid verificável), e é *errado* aqui: um formulário
 *    público não prova posse do número, e qualquer um digitaria o telefone de um
 *    terceiro para reinscrevê-lo. Quem deu PARAR volta pelo WhatsApp (VOLTAR),
 *    que é o canal autenticado por posse;
 *  - a resposta é **a mesma** para telefone novo e telefone já cadastrado — a
 *    landing não pode virar oráculo de "quem está na base da organização".
 *
 * Proteção sem captcha (proibido: o público é ribeirinho/rural e o captcha
 * exclui exatamente quem a landing existe para alcançar): rate limit por IP no
 * controller + honeypot + time-to-submit + validação real do telefone.
 *
 * **Toda menção à organização vem de `OrganizationService`** (singleton semeado
 * do env, editável em Configurações) — nunca de uma constante. Um titular
 * autorizando o nome de OUTRA organização é um consentimento incoerente: a Meta
 * exige que o texto nomeie o negócio e a LGPD exige controlador determinado.
 */
@Injectable()
export class PublicConsentService {
  private readonly logger = new Logger(PublicConsentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
    private readonly config: ConfigService<Env>,
    private readonly organization: OrganizationService,
  ) {}

  /**
   * O texto canônico VIGENTE da finalidade, com `{url}` resolvido — o que a
   * landing renderiza ao lado do checkbox e o que, palavra por palavra, é
   * copiado para `ConsentEvent.evidenceText` no POST.
   */
  async activeText(purposeKey: string): Promise<PublicConsentTextView> {
    const purpose = await this.consent.findActivePurpose(purposeKey);
    if (!purpose) {
      // Genérico de propósito: a landing é pública e o conjunto de finalidades
      // da organização é configuração interna.
      throw new NotFoundException(
        'Finalidade de consentimento não encontrada.',
      );
    }

    const text = await this.prisma.consentText.findFirst({
      where: { purposeKey: purpose.key, activeFrom: { lte: new Date() } },
      orderBy: { activeFrom: 'desc' },
      select: { version: true, body: true },
    });
    if (!text?.body) {
      // Sem texto publicado não há declaração — e um checkbox sem declaração é
      // consentimento fabricado. Falhamos alto em vez de inventar um corpo.
      throw new NotFoundException(
        'Finalidade de consentimento não encontrada.',
      );
    }

    return {
      purposeKey: purpose.key,
      purposeLabel: purpose.label,
      version: text.version,
      body: await this.renderBody(text.body),
    };
  }

  /** O POST da landing. Ver o comentário da classe para o porquê de cada guarda. */
  async submit(
    input: PublicOptIn,
    meta: PublicOptInMeta,
  ): Promise<PublicOptInResult> {
    // 1. Honeypot — 200 idêntico ao sucesso, e nada gravado.
    if (input.website && input.website.trim()) {
      this.logger.debug('honeypot preenchido — submissão descartada');
      return GENERIC_OK;
    }

    // 2. Time-to-submit. Defesa em profundidade (o campo é do cliente, logo
    //    forjável); a proteção dura é o rate limit por IP.
    if (
      input.renderedAt &&
      Date.now() - input.renderedAt.getTime() < MIN_TIME_TO_SUBMIT_MS
    ) {
      this.logger.debug('submissão rápida demais para ser humana — descartada');
      return GENERIC_OK;
    }

    // 3. O ato afirmativo. Recusado com mensagem — não é aceitável "assumir" o
    //    aceite (caixa pré-marcada e consentimento presumido são proibidos).
    if (input.accepted !== true) {
      const org = await this.organization.get();
      throw new BadRequestException(
        `Para continuar, marque a caixa autorizando ${org.name} a enviar mensagens.`,
      );
    }

    // 4. Telefone. libphonenumber (o MESMO helper do import), não regex: um
    //    `^\+\d{8,15}$` aceitaria `+99999999999`, que não é número de lugar nenhum.
    const phoneE164 = normalizeToE164(input.phone);
    if (!phoneE164) {
      throw new BadRequestException(
        'Telefone inválido. Digite o DDD e o número, por exemplo: (92) 98765-4321.',
      );
    }

    // 5. Finalidade + texto. 404 antes de qualquer escrita.
    const text = await this.activeText(input.purposeKey);

    // 6. Supressão: quem pediu PARAR não volta por formulário público.
    if (await this.consent.isSuppressed(phoneE164)) {
      const org = await this.organization.get();
      return {
        status: 'suppressed',
        message: `Este número pediu para não receber mais mensagens de ${org.name}. Se você mudou de ideia, envie VOLTAR no WhatsApp para o número de ${org.name} — assim temos certeza de que é você.`,
      };
    }

    const { id: contactId, created } = await this.upsertContact(
      phoneE164,
      input.name,
    );

    // C5.3 — se o contato NASCEU agora, ele pode ser uma pessoa que já consentiu
    // (ou revogou uma finalidade) antes de a linha ser apagada. A trilha é durável
    // (`phoneHash`), o `ContactConsent` não é — reidratamos ANTES do GRANT desta
    // submissão, para que ele recomponha sobre a história inteira e não sobre um
    // estado derivado pela metade.
    if (created) {
      await this.consent.rehydrate(contactId, phoneE164);
    }

    const submissionId = randomUUID();

    await this.consent.record({
      contactId,
      phoneE164,
      purposeKey: text.purposeKey,
      action: ConsentAction.GRANT,
      source: ConsentSource.WEB_FORM,
      // A prova, por valor: o corpo renderizado que a pessoa leu.
      evidenceText: text.body,
      consentTextVersion: text.version,
      evidence: {
        ip: meta.ip,
        userAgent: meta.userAgent,
        url: meta.url,
        submissionId,
        checkboxes: [text.purposeKey],
        renderedAt: input.renderedAt?.toISOString() ?? null,
      } as Prisma.InputJsonObject,
    });

    // Sem PII no log: nem telefone, nem nome. `submissionId` é o que amarra este
    // request à evidência gravada, e ele já está dentro do ConsentEvent.
    this.logger.log(
      {
        submissionId,
        purposeKey: text.purposeKey,
        consentTextVersion: text.version,
      },
      'opt-in web registrado',
    );

    return GENERIC_OK;
  }

  /**
   * Cria o contato quando ele não existe. Um contato já existente **não** tem o
   * nome sobrescrito por este formulário: o campo é entrada anônima e não
   * autenticada, e permitir a sobrescrita deixaria qualquer um renomear um
   * contato da organização sabendo só o telefone. Preencher um nome que estava
   * VAZIO é o único caso seguro — ali não há dado a destruir, e a fonte mais
   * autoritativa do nome de alguém é a própria pessoa.
   */
  private async upsertContact(
    phoneE164: string,
    name?: string,
  ): Promise<{ id: string; created: boolean }> {
    // C5 — a landing é o terceiro escritor de contato, e casava o titular por
    // igualdade EXATA de string. Quem já estava na base como `+5592995550101` e
    // digitava a forma de 12 dígitos ganhava um SEGUNDO Contact — que a
    // reidratação logo abaixo faz nascer GRANTED e passar o gate de campanha.
    // As duas grafias são a mesma conta de WhatsApp; a busca é pelas duas, e o
    // desempate (13 dígitos) é o mesmo do resto do sistema.
    const candidates = await this.prisma.contact.findMany({
      where: { phoneE164: { in: brazilianPhoneVariants(phoneE164) } },
      select: { id: true, name: true, phoneE164: true },
      // A bijeção do 9º dígito produz no máximo duas grafias.
      take: 2,
    });
    const canonical = canonicalBrPhoneForm(phoneE164);
    const existing =
      candidates.find((c) => c.phoneE164 === canonical) ?? candidates[0] ?? null;

    if (existing) {
      if (name && !existing.name) {
        await this.prisma.contact.update({
          where: { id: existing.id },
          data: { name },
        });
      }
      return { id: existing.id, created: false };
    }

    try {
      const created = await this.prisma.contact.create({
        data: { phoneE164, name: name ?? null, tags: [] },
        select: { id: true },
      });
      return { id: created.id, created: true };
    } catch (err) {
      // Corrida entre duas submissões do mesmo número (o QR de um evento é
      // escaneado por muita gente ao mesmo tempo): o unique de phoneE164 é a
      // fonte da verdade, e o perdedor apenas relê a linha.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raced = await this.prisma.contact.findUnique({
          where: { phoneE164 },
          select: { id: true },
        });
        // O vencedor da corrida já reidratou (ou já era um contato vivo): este
        // caminho não repete o trabalho.
        if (raced) return { id: raced.id, created: false };
      }
      throw err;
    }
  }

  /**
   * `{url}` do corpo canônico → a política de privacidade da organização, quando
   * ela declarou uma em Configurações; senão, a página do próprio orgamind.
   *
   * O corpo vive versionado no banco justamente para que trocar a razão social
   * (ou a URL) seja correção de DADO, nunca de código; o que o servidor resolve
   * aqui é só o placeholder — o texto publicado permanece byte a byte o que era.
   */
  private async renderBody(body: string): Promise<string> {
    const org = await this.organization.get();
    const base = (
      this.config.get('APP_BASE_URL', { infer: true }) ?? ''
    ).replace(/\/+$/, '');
    const url = org.privacyPolicyUrl ?? `${base}/privacidade`;
    return body.replaceAll('{url}', url);
  }
}
