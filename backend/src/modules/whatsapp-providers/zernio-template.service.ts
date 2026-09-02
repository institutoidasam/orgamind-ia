import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TemplateStatus } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

const DEFAULT_BASE_URL = 'https://zernio.com/api/v1';

/** Um template do catálogo da Meta, como `GET /whatsapp/templates` o devolve. */
export type ZernioTemplateItem = {
  /** O `message_template_id` da META (numérico), não um ObjectId do Zernio. */
  id: string;
  /** `^[a-z][a-z0-9_]*$` — case-sensitive, minúsculo. */
  name: string;
  /** O status BRUTO da Meta — preservado; o mapeamento (com perda) é do sync. */
  status?: string;
  category?: string;
  language: string;
  /** HEADER/BODY/FOOTER/BUTTONS crus — a estrutura que `body` sozinho perde. */
  components?: unknown;
  /** Extra não documentado da Zernio (só a LISTA traz; o get-by-name não). */
  qualityScore?: string;
};

/**
 * Status da Meta → o enum do orgamind.
 *
 * A LISTAGEM só devolve `APPROVED | PENDING | REJECTED`, mas o **webhook amplia**
 * para `PAUSED | DISABLED | IN_APPEAL | PENDING_DELETION` — e a Meta pode
 * inventar um status novo amanhã. Duas regras:
 *
 *  1. **Nunca lançar.** Um status desconhecido não pode derrubar o sync inteiro
 *     (antes, um `DISABLED` explodia no Zod e o catálogo daquela WABA não
 *     entrava).
 *  2. **Nunca abrir o gate por acidente.** O gate de campanha só aceita
 *     APPROVED; tudo que não for reconhecido cai em PENDING, que é fechado.
 *
 * O status CRU é persistido em `Template.zernioStatusRaw` — este mapeamento tem
 * perda (DISABLED e PENDING_DELETION viram PAUSED) e o raw é o que preserva o
 * diagnóstico para a tela.
 */
export function mapZernioTemplateStatus(
  raw: string | undefined | null,
): TemplateStatus {
  switch ((raw ?? '').trim().toUpperCase()) {
    case 'APPROVED':
      return TemplateStatus.APPROVED;
    case 'REJECTED':
      return TemplateStatus.REJECTED;
    // Aprovado um dia, fora de serviço hoje. PENDING_DELETION entra aqui porque
    // "vai sumir em 24h" definitivamente não é "esperando aprovação".
    case 'PAUSED':
    case 'DISABLED':
    case 'PENDING_DELETION':
      return TemplateStatus.PAUSED;
    // PENDING, IN_APPEAL (rejeitado, em recurso — ainda não pode enviar) e
    // QUALQUER status novo da Meta: fechado, e sem quebrar.
    default:
      return TemplateStatus.PENDING;
  }
}

/**
 * Cliente do catálogo de templates do Zernio — o análogo do
 * {@link TwilioContentService}, com uma diferença estrutural: o Zernio **não tem
 * catálogo da organização**. O catálogo é POR WABA, e `accountId` é OBRIGATÓRIO
 * na query (sem ele: 400). Daí o sync ser por CANAL.
 *
 * Fonte: `GET /v1/whatsapp/templates?accountId=` — busca direto na Cloud API da
 * Meta (não é cache da Zernio).
 */
@Injectable()
export class ZernioTemplateService {
  private readonly logger = new Logger(ZernioTemplateService.name);
  private readonly http: AxiosInstance;
  /** False em deploy sem credencial Zernio — o sync no-op em vez de tomar 401. */
  readonly configured: boolean;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ZERNIO_API_KEY')?.trim() ?? '';
    const baseURL =
      config.get<string>('ZERNIO_BASE_URL')?.trim() || DEFAULT_BASE_URL;
    this.configured = apiKey.length > 0;
    this.http = axios.create({
      baseURL,
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15_000,
    });
  }

  /**
   * O catálogo de UMA conta WhatsApp (WABA).
   *
   * **Lança** quando a API falha — de propósito, e ao contrário da saúde (ZB):
   * quem chama PRECISA distinguir "esta WABA tem 0 templates" de "não consegui
   * ler esta WABA". Confundir os dois faria o sync concluir "o catálogo sumiu".
   *
   * Um item torto (sem `name`) é pulado e logado: um template malformado não
   * pode levar junto o resto do catálogo daquela conta.
   */
  async list(accountId: string): Promise<ZernioTemplateItem[]> {
    const { data } = await this.http.get<{ templates?: unknown[] }>(
      '/whatsapp/templates',
      { params: { accountId } },
    );
    const raw = Array.isArray(data?.templates) ? data.templates : [];
    const items: ZernioTemplateItem[] = [];
    for (const entry of raw) {
      const item = this.parseItem(entry, accountId);
      if (item) items.push(item);
    }
    return items;
  }

  /**
   * ZB — CRIA o template na Meta, através do Zernio.
   *
   * Este é o caminho que faltava: até aqui o orgamind só sabia LER o catálogo
   * (`list`), então "criar um template com botões" era impossível pelo produto —
   * e a única alternativa (o `POST /templates` genérico) gravava uma row
   * `APPROVED` que não existia na Meta, o que é pior do que não criar nada.
   *
   * `status` volta PENDING (custom, review da Meta em até 24h). NUNCA
   * fabricamos APPROVED: o gate de campanha continua fechado até a Meta abrir.
   *
   * **Lança** quando a API falha — quem chama precisa distinguir "a Meta
   * recusou" de "criei" (não persistir uma row de um template que não existe).
   */
  async create(
    accountId: string,
    input: {
      name: string;
      language: string;
      category: string;
      components: unknown[];
    },
  ): Promise<{ id: string; status?: string }> {
    const { data } = await this.http.post<{
      template?: { id?: string | number; status?: string };
    }>('/whatsapp/templates', {
      accountId,
      name: input.name,
      category: input.category,
      language: input.language,
      components: input.components,
    });
    const t = data?.template;
    return {
      id: t?.id != null ? String(t.id) : '',
      status: typeof t?.status === 'string' ? t.status : undefined,
    };
  }

  /**
   * ZB — relê UM template pelo nome (`GET /whatsapp/templates/{name}`).
   *
   * Usado no round-trip pós-criação: o rótulo que volta no clique da pessoa é o
   * rótulo COMO A META O GUARDOU, não o que mandamos. Reler e reconferir contra
   * o reconhecedor é a diferença entre garantir o casamento e torcer por ele.
   *
   * 404 → `null` (o template ainda não propagou); outras falhas propagam.
   */
  async getByName(
    accountId: string,
    name: string,
  ): Promise<ZernioTemplateItem | null> {
    try {
      const { data } = await this.http.get<{ template?: unknown }>(
        `/whatsapp/templates/${encodeURIComponent(name)}`,
        { params: { accountId } },
      );
      return this.parseItem(data?.template, accountId);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * ZB — APAGA o template na Meta (`DELETE /whatsapp/templates/{name}`; a Meta o
   * põe em `PENDING_DELETION` por 24h antes de remover de fato).
   *
   * Existe por um motivo só, e é o mais importante do módulo: quando o
   * round-trip pós-criação descobre que a Meta guardou o rótulo do botão de
   * opt-in de um jeito que o reconhecedor NÃO lê, o orgamind recusa a row local —
   * mas o template JÁ EXISTE lá. Sem este DELETE, o sync horário o traria de
   * volta sozinho, como uma row normal, e uma vez APROVADO ele passaria no gate
   * de campanha: a rejeição duraria no máximo 60 minutos, e a campanha rodaria
   * em cima de um template que colhe zero.
   *
   * 404 é sucesso (já não está lá). As demais falhas propagam — quem chama
   * precisa poder dizer ao operador "apague no painel", em vez de fingir.
   */
  async delete(accountId: string, name: string): Promise<void> {
    try {
      await this.http.delete(
        `/whatsapp/templates/${encodeURIComponent(name)}`,
        { params: { accountId } },
      );
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return;
      throw err;
    }
  }

  private parseItem(
    raw: unknown,
    accountId: string,
  ): ZernioTemplateItem | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;

    // `name` é a chave do upsert (com channelId + language) E o identificador
    // que o `POST /inbox/conversations` usa para enviar. Sem ele o template é
    // inutilizável — pular é melhor do que gravar uma row que não dá para enviar.
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) {
      this.logger.warn(
        `conta ${accountId}: template sem nome, pulando (${JSON.stringify(
          raw,
        ).slice(0, 160)})`,
      );
      return null;
    }

    const quality =
      typeof r.quality_score === 'object' && r.quality_score !== null
        ? (r.quality_score as Record<string, unknown>).score
        : undefined;

    return {
      // A Meta manda o id como número ou string dependendo do endpoint.
      id: r.id != null ? String(r.id) : '',
      name,
      status: typeof r.status === 'string' ? r.status : undefined,
      category: typeof r.category === 'string' ? r.category : undefined,
      // `language` ausente é raríssimo, mas a chave composta precisa de um valor
      // determinístico — pt_BR é o único idioma em uso no projeto.
      language: typeof r.language === 'string' ? r.language : 'pt_BR',
      components: r.components,
      qualityScore: typeof quality === 'string' ? quality : undefined,
    };
  }
}
