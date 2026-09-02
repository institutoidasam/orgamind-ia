/**
 * ★ POR QUE A AUDIÊNCIA ENCOLHEU — dito em palavras, no mesmo texto, nas duas
 * telas que mostram o número.
 *
 * A regra "ninguém recebe o mesmo template duas vezes" (spec 2026-08-12) é
 * SEMPRE ligada e não tem botão de desligar. O preço disso é que ela DEVE se
 * explicar: sem esta linha o operador vê 88 onde esperava 500 e não tem como
 * saber por quê — foi exatamente esse silêncio (uma recusa sem explicação) que
 * custou a tarde de 2026-08-11 e oito tentativas cegas.
 *
 * Vive num componente só porque aparece em DOIS lugares — o painel do passo 3
 * (LivePreview) e a tela de confirmação do passo 4. Duas cópias do texto viram,
 * com o tempo, duas explicações diferentes para o mesmo fato.
 *
 * Não renderiza nada quando ninguém foi excluído: um "0 excluídos" permanente
 * vira ruído e treina o operador a ignorar o aviso justo quando ele importa.
 *
 * ★★ DOIS MOTIVOS MUITO DIFERENTES DEBAIXO DO MESMO NÚMERO (2026-08-19).
 *
 * A régua mudou: uma campanha CANCELADA passou a bloquear também as linhas que
 * ficaram em SENT. Nos canais que este produto usa não há confirmação de
 * entrega, então SENT é onde a maioria das linhas para — inclusive quando o
 * número do canal é derrubado no meio do disparo, que é justamente a hora em
 * que o operador CANCELA a campanha e recria em outro canal.
 *
 * Nesse caminho, "já está em campanha com este mesmo template" soa como "já
 * recebeu" e é falso: a pessoa pode não ter recebido nada. Dizer a mesma frase
 * para os dois casos faz o operador desistir de uma audiência inteira achando
 * que ela já foi atendida.
 *
 * `stuckInCancelled` é a quebra do número por motivo. Enquanto o backend não a
 * devolver, o componente NÃO afirma que todos receberam — ele avisa que parte
 * do número pode ser gente presa numa campanha cancelada.
 */
export function SameTemplateExclusionNotice({
  count,
  stuckInCancelled,
}: {
  count: number;
  /**
   * Quantos, dos `count`, estão bloqueados por uma campanha CANCELADA (linha
   * parada em SENT) em vez de por uma campanha viva. `undefined` = o backend
   * ainda não sabe separar; nesse caso o texto cobre os dois casos.
   */
  stuckInCancelled?: number;
}) {
  if (count <= 0) return null;

  const presos =
    stuckInCancelled === undefined
      ? undefined
      : Math.max(0, Math.min(count, stuckInCancelled));
  const emCampanhaViva = presos === undefined ? count : count - presos;

  return (
    <div
      role="status"
      data-testid="same-template-exclusion"
      className="rounded-lg border p-3 text-xs"
      style={{
        background: 'var(--st-queued-bg, var(--surface))',
        borderColor: 'var(--border)',
      }}
    >
      {presos === undefined ? (
        <>
          <p>
            <strong>{count}</strong> {contato(count)} não{' '}
            {entrou(count)} porque já {estao(count)} em campanha com este mesmo
            template — ninguém recebe a mesma mensagem duas vezes.
          </p>
          <p className="mt-1.5">
            Parte desse número pode ser gente que ficou marcada como enviada numa{' '}
            <strong>campanha cancelada</strong> deste mesmo template. Cancelar
            não desmarca o que já saiu, e se o canal caiu no meio do disparo essa
            pessoa <strong>pode não ter recebido nada</strong>.
          </p>
        </>
      ) : (
        <>
          {emCampanhaViva > 0 && (
            <p>
              <strong>{emCampanhaViva}</strong> {contato(emCampanhaViva)} não{' '}
              {entrou(emCampanhaViva)} porque já {estao(emCampanhaViva)} em
              campanha com este mesmo template — ninguém recebe a mesma mensagem
              duas vezes.
            </p>
          )}
          {presos > 0 && (
            <p className={emCampanhaViva > 0 ? 'mt-1.5' : undefined}>
              <strong>{presos}</strong> {contato(presos)} não {entrou(presos)}{' '}
              porque {continua(presos)} marcad{presos === 1 ? 'o' : 'os'} como
              enviad{presos === 1 ? 'o' : 'os'} numa{' '}
              <strong>campanha cancelada</strong> deste mesmo template. Cancelar
              não desmarca o que já saiu, e se o canal caiu no meio do disparo
              {presos === 1 ? ' essa pessoa ' : ' essas pessoas '}
              <strong>
                {presos === 1 ? 'pode não ter recebido' : 'podem não ter recebido'}
              </strong>{' '}
              nada.
            </p>
          )}
        </>
      )}
    </div>
  );
}

const contato = (n: number) => (n === 1 ? 'contato' : 'contatos');
const entrou = (n: number) => (n === 1 ? 'entrou' : 'entraram');
const estao = (n: number) => (n === 1 ? 'está' : 'estão');
const continua = (n: number) => (n === 1 ? 'continua' : 'continuam');
