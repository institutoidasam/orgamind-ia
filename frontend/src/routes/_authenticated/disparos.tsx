import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /disparos FOI FUNDIDO em /campanhas (pedido do cliente, 13/07): as duas
 * telas mostravam os mesmos números dos mesmos disparos. O que só existia
 * aqui — os disparos feitos PELO PAINEL do Zernio e o contraste de volume
 * "fora do orgamind" — chegou a viver na seção PanelBroadcasts de /campaigns
 * (features/zernio-metrics/components/panel-broadcasts.tsx), mas essa seção
 * também foi removida a pedido do cliente (25/08, 5bf2d11): a tela de
 * campanhas parou de mostrar qualquer coisa que não fosse campanha do
 * orgamind. Hoje não há mais tela nem seção equivalente — só o redirect abaixo.
 *
 * A rota sobrevive só como redirect: link salvo e memória muscular não podem
 * cair num 404.
 */
export const Route = createFileRoute('/_authenticated/disparos')({
  beforeLoad: () => {
    throw redirect({ to: '/campaigns' });
  },
});
