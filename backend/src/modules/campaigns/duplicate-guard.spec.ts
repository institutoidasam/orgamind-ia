import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { duplicateGuardWhere } from './duplicate-guard';
import { CANCELLED_CAMPAIGN_BLOCKING_STATUSES } from './batch-audience';

const CREATED_AT = new Date('2026-08-01T12:00:00.000Z');

function where() {
  return duplicateGuardWhere({
    messageId: 'm1',
    contactId: 'c1',
    campaignId: 'camp1',
    templateId: 't1',
    createdAt: CREATED_AT,
  });
}

/** Os ramos do OR, achatados em listas de status, para poder perguntar coisas. */
function branches() {
  return (where().OR ?? []) as Array<Record<string, unknown>>;
}

function statusesOf(b: Record<string, unknown>): string[] {
  const s = b.status as { in?: string[] } | undefined;
  return s?.in ?? [];
}

describe('duplicateGuardWhere — a régua que impede o eleitor de receber duas vezes', () => {
  it('★ a própria linha NUNCA bloqueia a si mesma (é o que separa duplicata de redisparo)', () => {
    expect(where().id).toEqual({ not: 'm1' });
  });

  it('★ pergunta é sobre a PESSOA e só sobre o que SAI (INBOUND não bloqueia nada)', () => {
    expect(where().contactId).toBe('c1');
    expect(where().direction).toBe('OUTBOUND');
  });

  it('★ irmã ENTREGUE ou EM VOO no provedor bloqueia SEM desempate', () => {
    const b = branches().find(
      (x) => x.campaignId === 'camp1' && statusesOf(x).includes('SENDING'),
    );
    expect(b).toBeDefined();
    expect(statusesOf(b!)).toEqual(['SENT', 'DELIVERED', 'READ', 'SENDING']);
    // Sem cláusula de anterioridade: uma irmã que JÁ está no provedor bloqueia,
    // tenha nascido antes ou depois.
    expect(b!.OR).toBeUndefined();
  });

  it('★ irmã ainda PARADA na fila só bloqueia se for ANTERIOR — senão as duas se cancelam', () => {
    const b = branches().find(
      (x) => x.campaignId === 'camp1' && statusesOf(x).includes('QUEUED'),
    );
    expect(b).toBeDefined();
    // Sem este desempate, duas linhas QUEUED do mesmo contato veem uma à outra e
    // NINGUÉM envia: o eleitor some da campanha em silêncio.
    expect(b!.OR).toEqual([
      { createdAt: { lt: CREATED_AT } },
      { createdAt: CREATED_AT, id: { lt: 'm1' } },
    ]);
  });

  it('★ FALSO POSITIVO: FAILED, CANCELLED e SKIPPED_* NUNCA bloqueiam', () => {
    // São exatamente as pessoas que ainda PRECISAM receber: número errado que foi
    // corrigido, canal que caiu, quem foi pulado por falta de consentimento e
    // depois consentiu. Bloquear por causa delas é queimar o eleitor para sempre.
    const all = branches().flatMap(statusesOf);
    for (const dead of [
      'FAILED',
      'CANCELLED',
      'SKIPPED_NO_CONSENT',
      'SKIPPED_SUPPRESSED',
    ]) {
      expect(all).not.toContain(dead);
    }
  });

  /**
   * ★ I9 (revisão de integração) — AS QUATRO CAMADAS PASSARAM A CONCORDAR.
   *
   * Esta cláusula usava `RECEIVED_STATUSES` (só DELIVERED/READ) enquanto o
   * recorte da audiência usava `CANCELLED_CAMPAIGN_BLOCKING_STATUSES` (que
   * inclui SENT). A rede de baixo era mais FROUXA que a de cima exatamente na
   * regra que o dono mandou apertar (C14): cancelar NÃO cancela o que já está
   * no provedor — aquela linha vai ser entregue, o que falta é o recibo. Quem
   * chegasse ao envio por um caminho que não passou pela audiência (redisparo
   * manual, linha criada antes do cancelamento, corrida entre o cancelamento e
   * o disparo irmão) saía com a mesma propaganda pela segunda vez.
   *
   * A objeção contra incluir SENT é real — o incidente do 9º dígito deixa
   * mensagens presas em SENT para sempre, e é assim que um número banido morre.
   * A resposta NÃO é afrouxar UMA das quatro camadas (isso só esconde o furo em
   * três delas): é a porta que veio junto,
   * `CampaignsService.releaseUnconfirmedSent` — "o canal morreu, estas SENT
   * nunca chegaram" — que converte em massa aquelas linhas para FAILED, e
   * FAILED não bloqueia em camada nenhuma (ver o teste logo abaixo).
   */
  it('★ campanha CANCELADA do mesmo template bloqueia o ENTREGUE e o que já está NO PROVEDOR (SENT)', () => {
    const b = branches().find(
      (x) =>
        (x.campaign as { status?: string } | undefined)?.status === 'CANCELLED',
    );
    expect(b).toBeDefined();
    // Duas afirmações, de propósito. A literal pega alguém mudando a régua da
    // audiência sem perceber que ela vale aqui também; a comparação com a
    // CONSTANTE pega alguém mudando esta guarda sem mexer na audiência. Só as
    // duas juntas impedem as camadas de divergirem de novo.
    expect(statusesOf(b!)).toEqual(['DELIVERED', 'READ', 'SENT']);
    expect(statusesOf(b!)).toEqual(CANCELLED_CAMPAIGN_BLOCKING_STATUSES);
    // E continua LIBERANDO a fila, que é o que o cancelamento de fato cancela.
    expect(statusesOf(b!)).not.toContain('QUEUED');
    expect(statusesOf(b!)).not.toContain('WAITING_INSTANCE');
  });

  /**
   * ★ I9 — A CÓPIA NÃO PODE VOLTAR.
   *
   * O defeito não foi a régua estar errada: foi existirem DUAS funções idênticas
   * que divergiram JUNTAS, de um jeito que comparar uma com a outra não acusava.
   * Este teste varre `src/` e exige que a guarda seja DEFINIDA em um lugar só —
   * quem for tentado a copiar de novo (porque "o outro pacote ainda não
   * mergeou") fica vermelho aqui.
   */
  it('★ existe UMA definição de duplicateGuardWhere em todo o src — a cópia não volta', () => {
    const raiz = join(__dirname, '..', '..');
    const arquivos: string[] = [];
    const varre = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) varre(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts'))
          arquivos.push(p);
      }
    };
    varre(raiz);
    const definidores = arquivos.filter((f) =>
      /export function duplicateGuardWhere\(/.test(readFileSync(f, 'utf8')),
    );
    expect(definidores.map((f) => f.replace(raiz, 'src'))).toEqual([
      join('src', 'modules', 'campaigns', 'duplicate-guard.ts'),
    ]);
  });

  it('outra campanha do MESMO template só entra na conta se for outra campanha', () => {
    const irmas = branches().filter((x) => x.campaign !== undefined);
    expect(irmas.length).toBeGreaterThan(0);
    for (const b of irmas) {
      expect(b.campaign).toMatchObject({
        templateId: 't1',
        id: { not: 'camp1' },
      });
    }
  });
});
