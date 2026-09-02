import { describe, it, expect } from 'vitest';
import {
  listCampaignMessagesQuerySchema,
  listCampaignRecipientsQuerySchema,
  createCampaignSchema,
  previewCampaignSchema,
} from './campaign.schema';

/**
 * GATE SILENCIOSO — o contrato escondia os pulados.
 *
 * O front já oferecia o filtro "Sem consentimento" na tabela de mensagens, mas
 * o enum do contrato não conhecia SKIPPED_NO_CONSENT: a chamada voltava 400 e a
 * lista dos pulados era literalmente inalcançável pela API. Idem para a aba de
 * destinatários — só existiam sent/pending/unreachable, e o contato pulado não
 * caía em nenhum dos três.
 */
describe('campaign contract — os status SKIPPED_* são filtráveis', () => {
  it('aceita SKIPPED_NO_CONSENT como filtro de status de mensagem', () => {
    const parsed = listCampaignMessagesQuerySchema.parse({
      status: 'SKIPPED_NO_CONSENT',
    });
    expect(parsed.status).toBe('SKIPPED_NO_CONSENT');
  });

  it('aceita SKIPPED_SUPPRESSED e WAITING_INSTANCE', () => {
    expect(
      listCampaignMessagesQuerySchema.parse({ status: 'SKIPPED_SUPPRESSED' })
        .status,
    ).toBe('SKIPPED_SUPPRESSED');
    expect(
      listCampaignMessagesQuerySchema.parse({ status: 'WAITING_INSTANCE' })
        .status,
    ).toBe('WAITING_INSTANCE');
  });

  it('aceita o grupo "skipped" na listagem de destinatários', () => {
    const parsed = listCampaignRecipientsQuerySchema.parse({
      group: 'skipped',
    });
    expect(parsed.group).toBe('skipped');
  });

  // F2 T7 — quem falhou de verdade (Message FAILED) não tinha aba própria: caía
  // implicitamente em "pendente" (se ainda elegível para retry) e o motivo da
  // falha ficava invisível na tela de destinatários.
  it('aceita o grupo "failed" na listagem de destinatários', () => {
    const parsed = listCampaignRecipientsQuerySchema.parse({
      group: 'failed',
    });
    expect(parsed.group).toBe('failed');
  });
});

/**
 * A.1 — "Limitar aos primeiros N" era a armadilha: ele recorta SEMPRE os
 * mesmos N primeiros por ordem de cadastro, ANTES de qualquer exclusão. O
 * cliente mandava para as mesmas 500 pessoas achando que estava avançando na
 * base. Campanhas novas não gravam mais o campo — e o contrato recusa quem
 * ainda tentar, com a mensagem que aponta para onde o tamanho do envio mora
 * agora (o 1º lote).
 */
describe('A.1 — createCampaignSchema recusa o "limit" legado', () => {
  const base = {
    name: 'Campanha',
    templateId: 'tpl1',
    defaultInstanceId: 'inst1',
    filters: { combinator: 'and', rules: [] },
    variableMap: {},
    purposeKey: 'convite_atividades',
  };

  it('aceita a criação SEM limit', () => {
    const parsed = createCampaignSchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  it('aceita limit: null (cliente antigo que manda o campo vazio)', () => {
    const parsed = createCampaignSchema.safeParse({ ...base, limit: null });
    expect(parsed.success).toBe(true);
  });

  it('recusa limit numérico com a mensagem que aponta o 1º lote', () => {
    const parsed = createCampaignSchema.safeParse({ ...base, limit: 500 });
    expect(parsed.success).toBe(false);
    const issue = parsed.success
      ? undefined
      : parsed.error.issues.find((i) => i.path.join('.') === 'limit');
    expect(issue?.message).toMatch(/1º lote/);
  });
});

/**
 * ★ Pedido do cliente 2026-08-25 — dois campos novos, opcionais com default,
 * para não quebrar nenhum chamador existente (front antigo, testes, campanhas
 * já criadas). Os nomes aqui são o contrato que o frontend precisa bater.
 */
describe('2026-08-25 — excludeAnyPreviousCampaign e respeitarJanelaDeEnvio', () => {
  const base = {
    name: 'Campanha',
    templateId: 'tpl1',
    defaultInstanceId: 'inst1',
    filters: { combinator: 'and', rules: [] },
    variableMap: {},
    purposeKey: 'convite_atividades',
  };

  it('createCampaignSchema: ausentes → default false/true (comportamento de sempre)', () => {
    const parsed = createCampaignSchema.parse(base);
    expect(parsed.excludeAnyPreviousCampaign).toBe(false);
    expect(parsed.respeitarJanelaDeEnvio).toBe(true);
  });

  it('createCampaignSchema: aceita os dois booleanos explícitos', () => {
    const parsed = createCampaignSchema.parse({
      ...base,
      excludeAnyPreviousCampaign: true,
      respeitarJanelaDeEnvio: false,
    });
    expect(parsed.excludeAnyPreviousCampaign).toBe(true);
    expect(parsed.respeitarJanelaDeEnvio).toBe(false);
  });

  it('previewCampaignSchema: excludeAnyPreviousCampaign ausente → default false', () => {
    const parsed = previewCampaignSchema.parse({
      filters: { combinator: 'and', rules: [] },
    });
    expect(parsed.excludeAnyPreviousCampaign).toBe(false);
  });

  it('previewCampaignSchema: aceita excludeAnyPreviousCampaign:true', () => {
    const parsed = previewCampaignSchema.parse({
      filters: { combinator: 'and', rules: [] },
      excludeAnyPreviousCampaign: true,
    });
    expect(parsed.excludeAnyPreviousCampaign).toBe(true);
  });
});
