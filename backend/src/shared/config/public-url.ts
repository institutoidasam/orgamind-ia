/**
 * "Esta URL é alcançável a partir da INTERNET?"
 *
 * Incidente de produção (2026-08-07): `armWebhook` do GoZap montava a URL do
 * webhook a partir de `WEBHOOK_BASE_URL`, que em prod vale `http://api:3000` —
 * o nome de serviço do docker-compose. Isso está CERTO para o Evolution (que
 * roda no mesmo compose) e ERRADO para o GoZap, que é SaaS de terceiro. O
 * GoZap aceitou o registro com 200 (ele só descobriria o problema na hora de
 * ENTREGAR), então nada falhou, nada foi logado, e o canal nasceu surdo:
 * nenhum ack de entrega, nenhuma mensagem recebida, nenhum opt-out por
 * WhatsApp. Dezessete horas de log sem uma única linha `level>=40`.
 *
 * `z.string().url()` não pega isso — `http://api:3000` é uma URL válida. O que
 * falta é a distinção entre "sintaticamente uma URL" e "um terceiro fora da
 * nossa rede consegue resolver isso", e é isso que este módulo nomeia.
 *
 * A regra é POR CONSUMIDOR, não por variável: o mesmo `http://api:3000` é
 * correto quando quem chama mora no compose. Só aplique onde o chamador é
 * externo.
 */

/** Sufixos reservados para redes locais — nunca resolvem na internet pública. */
const PRIVATE_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.lan',
  '.home.arpa',
];

/** Um rótulo IPv4 decimal pontuado, sem interpretar formas exóticas (octal/hex). */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv4(hostname: string): boolean {
  const m = IPV4.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0) return true; // 0.0.0.0/8 — "este host"
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  // `new URL()` mantém os colchetes do literal IPv6 no hostname? Não — ele os
  // remove. Aceitamos as duas formas por segurança.
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::' || h === '::1') return true; // não-especificado / loopback
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique-local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // link-local fe80::/10
  return false;
}

/**
 * `true` só quando a URL tem chance real de ser chamada por um serviço fora da
 * nossa rede. Conservador de propósito: na dúvida, `false` — um falso negativo
 * custa uma variável de ambiente explícita; um falso positivo custa um canal
 * mudo em produção, que é justamente o que aconteceu.
 *
 * Reprova: protocolo não-HTTP; `localhost`; sufixo de rede local; **hostname de
 * rótulo único** (`api`, `worker`, `evolution-api` — o caso exato do
 * incidente); e IP literal privado/loopback/link-local/CGNAT.
 *
 * Deliberadamente NÃO exige HTTPS: um túnel http de desenvolvimento (ngrok
 * antigo, IP público de teste) é alcançável de verdade, e recusá-lo tornaria o
 * guard um estorvo no ambiente onde ele mais precisa ser usado.
 */
export function isExternallyReachableUrl(
  raw: string | null | undefined,
): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const hostname = url.hostname.toLowerCase();
  if (!hostname) return false;
  if (hostname === 'localhost') return false;
  if (PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))
    return false;
  if (isPrivateIpv4(hostname)) return false;
  if (hostname.includes(':') || hostname.startsWith('['))
    return isPrivateIpv6(hostname) ? false : true;
  // Rótulo único (sem ponto) = nome resolvido só pelo DNS interno do docker.
  if (!hostname.includes('.')) return false;
  return true;
}
