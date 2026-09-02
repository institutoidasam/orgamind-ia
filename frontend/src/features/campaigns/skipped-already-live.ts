/**
 * ★ O NÚMERO QUE EXPLICA O ZERO.
 *
 * `skippedAlreadyLive` existe no backend com uma justificativa escrita no
 * próprio código: "0 enviadas sozinho não é uma resposta — com um lote ainda
 * drenando, significa que todo mundo já está a caminho, e é isso que a tela
 * precisa poder dizer". Ele acompanha `queued` no POST /campaigns/:id/redispatch
 * e no envio de lote.
 *
 * A frase vive aqui, num lugar só, porque aparece em DOIS toasts (o "Disparar
 * novamente" da tela da campanha e o "Enviar lote" do painel). Duas cópias do
 * texto viram, com o tempo, duas explicações diferentes para o mesmo fato — foi
 * exatamente esse o argumento que criou o `SameTemplateExclusionNotice`.
 *
 * Devolve `null` quando não houve ninguém pulado: um aviso permanente de "0
 * pulados" é ruído e treina o operador a ignorar o texto justo quando importa.
 */
export function frasePuladosEmVoo(n: number | undefined): string | null {
  if (!n || n <= 0) return null;
  const um = n === 1;
  return (
    `${n} contato${um ? '' : 's'} já ${um ? 'tem' : 'têm'} mensagem a caminho ` +
    `nesta campanha — ${um ? 'ele não entrou' : 'eles não entraram'} de novo ` +
    `para não receber duas vezes.`
  );
}
